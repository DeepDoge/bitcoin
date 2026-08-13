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

// There is only ever one active writer at a time across the whole worker
// pool (the pipeline hands out an exclusive "commit" turn, never two at
// once), so every opener can safely write. reveal() wires buckets straight
// into the real, shared SharedArrayStore the moment it runs — every other
// worker sees it immediately through the page cache, no staging, no
// broadcast, no separate "commit" step. sync() is durability only (msync);
// pin() (in Manifest) is the durable checkpoint used for crash recovery and
// nothing to do with cross-worker visibility.
export class HashMapStore<Key extends Codec, Value extends Codec> extends Store implements Disposable {
	public readonly path: string;

	public readonly key: Key;
	public readonly value: Value;
	public readonly entry: TupleCodec<[Key, Value]>;

	private sha256: boolean;
	private sha256Scratch1: Uint8Array<ArrayBuffer>;
	private sha256Scratch2: Uint8Array<ArrayBuffer>;
	private keyScratch: Uint8Array<ArrayBuffer>;

	public readonly maxEntrySize: number;
	private loadFactor: LoadFactorOptions;

	public readonly buckets: SharedArrayStore<NullableNumaricCodec<FixedCodec<number>>>;
	public readonly links: SharedArrayStore<StructCodec<{ prevIndex: NullableNumaricCodec<FixedCodec<number>>; entryPointer: FixedCodec<number> }>>;
	public readonly entries: BlobStore;

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

		this.buckets = SharedArrayStore.open({
			path: join(this.path, "buckets"),
			item: new NullableNumaricCodec(options.links.index),
			minChunkSize: options.buckets.minChunkSize,
		});
		this.links = SharedArrayStore.open({
			path: join(this.path, "links"),
			item: new StructCodec({ prevIndex: new NullableNumaricCodec(options.links.index), entryPointer: options.entries.pointer }),
			minChunkSize: options.links.minChunkSize,
		});
		this.entries = BlobStore.open({
			path: join(this.path, "entries"),
			chunkSize: options.entries.chunkSize,
		});

		// One-time seeding on a brand-new store. Unconditional + idempotent
		// (size()===0 check), same pattern as the genesis header seed in
		// chain/worker.ts — relies on the chain worker opening the manifest
		// (and therefore every store) before any consume worker is spawned, so
		// this always runs exactly once, in chain, before anyone else could
		// race it. No lock needed for the same reason genesis seeding needs
		// none.
		if (this.buckets.size() === 0) this.buckets.reveal(options.buckets.initialSize);
		if (this.links.size() === 0) {
			this.links.reveal(1);
			this.links.set(0, { prevIndex: null, entryPointer: 0 });
		}
	}

	public static open<Key extends Codec, Value extends Codec>(options: HashMapStoreOptions<Key, Value>): HashMapStore<Key, Value> {
		return new HashMapStore(options);
	}

	public override size(): number {
		return this.entryCount;
	}

	public get entryCount(): number {
		const links = this.links.size();
		return links > 0 ? links - 1 : 0;
	}

	/**
	 * Append one (key, value) entry: write its bytes into the entries blob at
	 * the pre-staged next free pointer, write its link slot, pre-stage the
	 * following entry's pointer, then reveal() to wire it into its bucket.
	 * Whichever worker is currently the exclusive committer just calls this
	 * directly — no staging, no remote pointer recompute.
	 */
	public put(key: Codec.InferInput<Key>, value: Codec.InferInput<Value>): number {
		const index = this.entryCount;
		const from = this.links.get(index).entryPointer; // pre-staged by the previous put()
		const written = this.entry.encodeInto([key, value], this.entries.mmap(this.maxEntrySize, from));
		this.entries.reveal(from + written);
		// Pre-stage the NEXT free pointer before reveal(): reveal()'s linking
		// loop reads links.get(index) for THIS entry's pointer (already there)
		// and rewrites its prevIndex, then advances past index + 1 — so
		// index + 1's entryPointer must already be in place for the following
		// put() to read, same alignment function (entries.next) as always.
		this.links.set(index + 1, { prevIndex: null, entryPointer: this.entries.next(this.maxEntrySize, from + written) });
		this.reveal(index + 1);
		return index;
	}

	public get(key: Codec.InferInput<Key>, isSha256?: boolean): Codec.InferOutput<Value> | undefined {
		const keyBytes = this.keyScratch.subarray(0, this.key.encodeInto(key, this.keyScratch));
		const bucket = this.hashKey(keyBytes, isSha256) % this.buckets.size();
		let index = this.buckets.get(bucket);
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
		const bucket = this.hashKey(keyBytes, isSha256) % this.buckets.size();
		let index = this.buckets.get(bucket);
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
		const bucket = this.hashKey(keyBytes, isSha256) % this.buckets.size();
		let index = this.buckets.get(bucket);
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

	/**
	 * Wire entries [entryCount, size) into their buckets, straight into the
	 * real shared buckets store — no staging map. Every other worker sees
	 * this the instant it lands, through the page cache. Entry bytes and
	 * link slots for this range must already be written (put() does both
	 * before calling this).
	 */
	public override reveal(size: number): void {
		const targetEntries = size;
		const currentEntries = this.entryCount;
		if (targetEntries < currentEntries) {
			throw new RangeError(`reveal entries=${targetEntries} is behind the cursor (entries=${currentEntries}); reveal only moves forward`);
		}
		// links first: the linking loop below reads links.get(index), which
		// bounds-checks against the links cursor.
		this.links.reveal(targetEntries + 1);
		for (let index = currentEntries; index < targetEntries; index++) {
			const link = this.links.get(index);
			const mmap = this.entries.mmap(this.maxEntrySize, link.entryPointer);
			const [, keySize] = this.key.decode(mmap);
			const bucket = this.hashKey(mmap.subarray(0, keySize), false) % this.buckets.size();
			const head = this.buckets.get(bucket);
			this.links.set(index, { prevIndex: head, entryPointer: link.entryPointer });
			this.buckets.set(bucket, index);
		}
	}

	public override truncate(size: number): void {
		const targetEntries = size;
		const currentEntries = this.entryCount;
		if (targetEntries > currentEntries) throw new RangeError(`truncate entries=${targetEntries} is ahead of the cursor (entries=${currentEntries})`);
		for (let index = currentEntries - 1; index >= targetEntries; index--) {
			const link = this.links.get(index);
			const mmap = this.entries.mmap(this.maxEntrySize, link.entryPointer);
			const [, keySize] = this.key.decode(mmap);
			const bucket = this.hashKey(mmap.subarray(0, keySize), false) % this.buckets.size();
			this.buckets.set(bucket, link.prevIndex);
		}
		const entriesEnd = this.links.get(targetEntries).entryPointer;
		this.links.truncate(targetEntries + 1);
		this.entries.truncate(entriesEnd);
	}

	public override sync(): void {
		this.entries.sync();
		this.links.sync();
		this.buckets.sync();
	}

	public close(): void {
		this.entries.close();
		this.links.close();
		this.buckets.close();
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
