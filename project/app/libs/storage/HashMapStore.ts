import { Codec, FixedCodec, StructCodec, TupleCodec, TupleOutput } from "@nomadshiba/codec";
import { IfNever, MAX_BLOCK_SIZE } from "@project/utils";
import { equals } from "@std/bytes";
import { join } from "@std/path";
import { BlobStore } from "~/libs/storage/BlobStore.ts";
import { SharedArrayStore } from "~/libs/storage/SharedArrayStore.ts";
import { Store } from "~/libs/storage/Store.ts";
import { NullableNumaricCodec } from "@project/codecs";
import { sha256 } from "@noble/hashes/sha2";

export type LoadFactorOptions = { target: number; maxDrift: number };
export type HashMapStoreOptions<Key extends Codec, Value extends Codec> = {
	commiter: boolean;
	path: string;

	loadFactor: LoadFactorOptions;
	entries: {
		key: Key;
		value: Value;
		chunkSize: number;
		pointer: FixedCodec<number>;
	} & IfNever<Extract<Key, FixedCodec> & Extract<Value, FixedCodec>, { maxEntrySize: number }, { maxEntrySize?: undefined }>;
	buckets: {
		initialSize: number;
		minChunkSize: number;
	};
	links: {
		index: FixedCodec<number>;
		minChunkSize: number;
	};

	sha256?: boolean;
};

export class HashMapStore<Key extends Codec, Value extends Codec> extends Store implements Disposable {
	public readonly path: string;

	public readonly key: Key;
	public readonly value: Value;
	public readonly entry: TupleCodec<[Key, Value]>;

	private sha256: boolean;
	private sha256Scratch1: Uint8Array<ArrayBuffer>;
	private sha256Scratch2: Uint8Array<ArrayBuffer>;
	private keyScratch: Uint8Array<ArrayBuffer>;

	private maxEntrySize: number;
	private loadFactor: LoadFactorOptions;

	private buckets: SharedArrayStore<NullableNumaricCodec<FixedCodec<number>>>;
	private links: SharedArrayStore<StructCodec<{ prevIndex: NullableNumaricCodec<FixedCodec<number>>; entryPointer: FixedCodec<number> }>>;
	private entries: BlobStore;

	private commiter: boolean;
	private stagedBuckets: Map<number, number>;

	private lockFile: Deno.FsFile | null;

	private readonly indexBits = 64n;

	private constructor(options: HashMapStoreOptions<Key, Value>) {
		super();
		this.path = options.path;
		this.key = options.entries.key;
		this.value = options.entries.value;
		this.entry = new TupleCodec([this.key, this.value]);

		this.sha256 = Boolean(options.sha256);
		this.sha256Scratch1 = new Uint8Array(32);
		this.sha256Scratch2 = new Uint8Array(32);
		this.keyScratch = new Uint8Array(MAX_BLOCK_SIZE);

		this.maxEntrySize = options.entries.maxEntrySize ?? this.entry.stride.size!;
		this.loadFactor = options.loadFactor;
		this.commiter = options.commiter;
		this.stagedBuckets = new Map();

		this.lockFile = null;
		if (options.commiter) {
			Deno.mkdirSync(this.path, { recursive: true });
			const lockFile = Deno.openSync(join(this.path, "COMMITTER.lock"), { create: true, read: true, write: true });
			if (!lockFile.tryLockSync(true)) {
				lockFile.close();
				throw new Error(`another committer already holds ${join(this.path, "COMMITTER.lock")}`);
			}
			this.lockFile = lockFile;
		}

		this.buckets = SharedArrayStore.open({
			path: join(this.path, "buckets"),
			writable: options.commiter,
			item: new NullableNumaricCodec(options.links.index),
			minChunkSize: options.buckets.minChunkSize,
		});
		this.links = SharedArrayStore.open({
			path: join(this.path, "links"),
			writable: options.commiter,
			item: new StructCodec({ prevIndex: new NullableNumaricCodec(options.links.index), entryPointer: options.entries.pointer }),
			minChunkSize: options.links.minChunkSize,
		});
		this.entries = BlobStore.open({
			path: join(this.path, "entries"),
			chunkSize: options.entries.chunkSize,
		});

		if (options.commiter) {
			if (Number(this.buckets.size()) === 0) this.buckets.reveal(options.buckets.initialSize);
			if (Number(this.links.size()) === 0) {
				this.links.reveal(1);
				this.links.set(0, { prevIndex: null, entryPointer: 0 });
			}
		}
	}

	public static open<Key extends Codec, Value extends Codec>(options: HashMapStoreOptions<Key, Value>): HashMapStore<Key, Value> {
		return new HashMapStore(options);
	}

	private pack(bucketCount: number, entryCount: number): bigint {
		return (BigInt(bucketCount) << this.indexBits) | BigInt(entryCount);
	}

	private unpack(size: bigint): [number, number] {
		const mask = (1n << this.indexBits) - 1n;
		return [Number(size >> this.indexBits), Number(size & mask)];
	}

	public override size(): bigint {
		const links = Number(this.links.size());
		return this.pack(Number(this.buckets.size()), links > 0 ? links - 1 : 0);
	}

	public get entryCount(): number {
		const links = Number(this.links.size());
		return links > 0 ? links - 1 : 0;
	}

	public put(key: Codec.InferInput<Key>, value: Codec.InferInput<Value>): number {
		const index = this.entryCount;
		const from = this.links.get(index).entryPointer;
		const written = this.entry.encodeInto([key, value], this.entries.mmap(this.maxEntrySize, from));
		this.entries.reveal(from + written);
		// Stage the next free pointer slot BEFORE reveal(): reveal()'s linking
		// loop reads links.get(index) and rewrites its prevIndex (entryPointer is
		// preserved), then advances the links cursor past index + 1. Advancing
		// the links cursor first would make entryCount == the reveal target and
		// the linking loop would never run — the entry would be written but
		// unreachable from its bucket.
		this.links.set(index + 1, { prevIndex: null, entryPointer: this.entries.next(this.maxEntrySize, from + written) });
		this.reveal(this.pack(Number(this.buckets.size()), index + 1));
		return index;
	}

	public get(key: Codec.InferInput<Key>, isSha256?: boolean): Codec.InferOutput<Value> | undefined {
		const keyBytes = this.keyScratch.subarray(0, this.key.encodeInto(key, this.keyScratch));
		const bucket = this.hashKey(keyBytes, isSha256) % Number(this.buckets.size());
		let index = this.commiter && this.stagedBuckets.has(bucket) ? this.stagedBuckets.get(bucket)! : this.buckets.get(bucket);
		while (index !== null) {
			const link = this.links.get(index);
			const mmap = this.entries.mmap(this.maxEntrySize, link.entryPointer);
			const [, keySize] = this.key.decode(mmap);

			let equal: boolean;
			if (this.sha256 && isSha256) {
				sha256.create().update(mmap.subarray(0, keySize)).digestInto(this.sha256Scratch2);
				equal = equals(this.sha256Scratch2, keyBytes);
			} else {
				equal = equals(mmap.subarray(0, keySize), keyBytes);
			}

			if (equal) {
				const [value] = this.value.decode(mmap.subarray(keySize));
				return value;
			}
			index = link.prevIndex;
		}
		return undefined;
	}

	public getIndex(key: Codec.InferInput<Key>, isSha256?: boolean): number | undefined {
		const keyBytes = this.keyScratch.subarray(0, this.key.encodeInto(key, this.keyScratch));
		const bucket = this.hashKey(keyBytes, isSha256) % Number(this.buckets.size());
		let index = this.commiter && this.stagedBuckets.has(bucket) ? this.stagedBuckets.get(bucket)! : this.buckets.get(bucket);
		while (index !== null) {
			const link = this.links.get(index);
			const mmap = this.entries.mmap(this.maxEntrySize, link.entryPointer);
			const [, keySize] = this.key.decode(mmap);

			let equal: boolean;
			if (this.sha256 && isSha256) {
				sha256.create().update(mmap.subarray(0, keySize)).digestInto(this.sha256Scratch2);
				equal = equals(this.sha256Scratch2, keyBytes);
			} else {
				equal = equals(mmap.subarray(0, keySize), keyBytes);
			}

			if (equal) {
				return index;
			}
			index = link.prevIndex;
		}
		return undefined;
	}

	public getEntry(index: number): TupleOutput<[Key, Value]> {
		const link = this.links.get(index);
		const [entry] = this.entry.decode(this.entries.mmap(this.maxEntrySize, link.entryPointer));
		return entry;
	}

	public getValueAndIndex(key: Codec.InferInput<Key>, isSha256?: boolean): [Codec.InferOutput<Value>, number] | undefined {
		const keyBytes = this.keyScratch.subarray(0, this.key.encodeInto(key, this.keyScratch));
		const bucket = this.hashKey(keyBytes, isSha256) % Number(this.buckets.size());
		let index = this.commiter && this.stagedBuckets.has(bucket) ? this.stagedBuckets.get(bucket)! : this.buckets.get(bucket);
		while (index !== null) {
			const link = this.links.get(index);
			const mmap = this.entries.mmap(this.maxEntrySize, link.entryPointer);
			const [, keySize] = this.key.decode(mmap);

			let equal: boolean;
			if (this.sha256 && isSha256) {
				sha256.create().update(mmap.subarray(0, keySize)).digestInto(this.sha256Scratch2);
				equal = equals(this.sha256Scratch2, keyBytes);
			} else {
				equal = equals(mmap.subarray(0, keySize), keyBytes);
			}

			if (equal) {
				const [value] = this.value.decode(mmap.subarray(keySize));
				return [value, index];
			}
			index = link.prevIndex;
		}
		return undefined;
	}

	public has(key: Codec.InferInput<Key>, isSha256?: boolean): boolean {
		return this.getIndex(key, isSha256) !== undefined;
	}

	public override reveal(size: bigint | number): void {
		const target = typeof size === "bigint" ? size : BigInt(size);
		const [targetBuckets, targetEntries] = this.unpack(target);
		const [currentBuckets, currentEntries] = this.unpack(this.size());
		// Readers observe sub-store cursors directly through their shared
		// mappings, which are always at or ahead of the last pinned broadcast —
		// so a broadcast arriving "behind" is the normal, already-caught-up case
		// for them. Only the writer enforces the forward-only invariant.
		if (this.commiter && targetEntries < currentEntries) {
			throw new RangeError(`reveal entries=${targetEntries} is behind the cursor (entries=${currentEntries}); reveal only moves forward`);
		}
		// Sub-stores first: the linking loop below reads links.get(index) and
		// buckets.get(bucket), which bounds-check against their own cursors.
		this.buckets.reveal(targetBuckets);
		this.links.reveal(targetEntries + 1);
		if (this.commiter) {
			for (let index = currentEntries; index < targetEntries; index++) {
				const link = this.links.get(index);
				const mmap = this.entries.mmap(this.maxEntrySize, link.entryPointer);
				const [, keySize] = this.key.decode(mmap);
				const bucket = this.hashKey(mmap.subarray(0, keySize), false) % Number(this.buckets.size());
				const head = this.stagedBuckets.has(bucket) ? this.stagedBuckets.get(bucket)! : this.buckets.get(bucket);
				this.links.set(index, { prevIndex: head, entryPointer: link.entryPointer });
				this.stagedBuckets.set(bucket, index);
			}
		}
	}

	public override truncate(size: bigint | number): void {
		const target = typeof size === "bigint" ? size : BigInt(size);
		const [targetBuckets, targetEntries] = this.unpack(target);
		const [currentBuckets, currentEntries] = this.unpack(this.size());
		if (targetEntries > currentEntries) throw new RangeError(`truncate entries=${targetEntries} is ahead of the cursor (entries=${currentEntries})`);
		for (let index = currentEntries - 1; index >= targetEntries; index--) {
			const link = this.links.get(index);
			const mmap = this.entries.mmap(this.maxEntrySize, link.entryPointer);
			const [, keySize] = this.key.decode(mmap);
			const bucket = this.hashKey(mmap.subarray(0, keySize), false) % Number(this.buckets.size());
			this.buckets.set(bucket, link.prevIndex);
		}
		this.stagedBuckets.clear();
		const entriesEnd = this.links.get(targetEntries).entryPointer;
		this.links.truncate(targetEntries + 1);
		this.entries.truncate(entriesEnd);
		this.buckets.truncate(targetBuckets);
	}

	public override sync(): void {
		this.entries.sync();
		this.links.sync();
		for (const [bucket, index] of this.stagedBuckets) {
			this.buckets.set(bucket, index);
		}
		this.stagedBuckets.clear();
		this.buckets.sync();
	}

	public close(): void {
		this.entries.close();
		this.links.close();
		this.buckets.close();
		if (this.lockFile) {
			this.lockFile.unlockSync();
			this.lockFile.close();
			this.lockFile = null;
		}
	}

	private hashKey(keyBytes: Uint8Array, isSha256: boolean | undefined): number {
		if (this.sha256 && !isSha256) {
			sha256.create().update(keyBytes).digestInto(this.sha256Scratch1);
			keyBytes = this.sha256Scratch1;
		}

		const end = keyBytes.length & ~3;
		let h = 0;
		let i = 0;
		for (; i < end; i += 4) {
			const w = keyBytes[i]! | (keyBytes[i + 1]! << 8) | (keyBytes[i + 2]! << 16) | (keyBytes[i + 3]! << 24);
			h = (Math.imul(h, 31) + w) | 0;
		}
		for (; i < keyBytes.length; i++) {
			h = (Math.imul(h, 31) + keyBytes[i]!) | 0;
		}
		return h >>> 0;
	}

	public [Symbol.dispose](): void {
		this.close();
	}
}
