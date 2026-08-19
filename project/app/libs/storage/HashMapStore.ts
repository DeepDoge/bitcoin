import { Codec, FixedCodec, StructCodec, TupleCodec, TupleOutput } from "@nomadshiba/codec";
import { IfNever, MAX_BLOCK_SIZE } from "@project/utils";
import { equals } from "@std/bytes";
import { join } from "@std/path";
import { Mmap } from "@nomadshiba/mmap";
import { BlobStore } from "~/libs/storage/BlobStore.ts";
import { AtomicMmapArray } from "~/libs/storage/AtomicMmapArray.ts";
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

const META_GENERATION = 0;
const META_COUNT = 1;

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

	public readonly buckets: AtomicMmapArray<NullableNumaricCodec<FixedCodec<number>>>;
	public readonly links: AtomicMmapArray<
		StructCodec<{ prevIndex: NullableNumaricCodec<FixedCodec<number>>; entryPointer: FixedCodec<number> }>
	>;
	public readonly entries: BlobStore;

	private meta: Mmap;
	private metaView: Uint32Array;
	private linkedCount = 0;

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

		this.buckets = AtomicMmapArray.open({
			path: join(this.path, "buckets"),
			item: new NullableNumaricCodec(options.links.index),
			minChunkSize: options.buckets.minChunkSize,
		});
		this.links = AtomicMmapArray.open({
			path: join(this.path, "links"),
			item: new StructCodec({ prevIndex: new NullableNumaricCodec(options.links.index), entryPointer: options.entries.pointer }),
			minChunkSize: options.links.minChunkSize,
		});
		this.entries = BlobStore.open({
			path: join(this.path, "entries"),
			chunkSize: options.entries.chunkSize,
		});

		Deno.mkdirSync(this.path, { recursive: true });
		this.meta = Mmap.openSync(join(this.path, "META"), { write: true, ensureFileSize: 2 * Uint32Array.BYTES_PER_ELEMENT });
		this.metaView = new Uint32Array(this.meta.buffer(), 0, 2);

		if (this.bucketCount() === 0) {
			this.buckets.resize(options.buckets.initialSize);
			Atomics.store(this.metaView, META_COUNT, options.buckets.initialSize);
			Atomics.store(this.metaView, META_GENERATION, 0);
		}
		if (this.links.size() === 0) {
			this.links.resize(1);
			this.links.set(0, { prevIndex: null, entryPointer: 0 });
		}
		this.linkedCount = this.entryCount();
	}

	public static open<Key extends Codec, Value extends Codec>(options: HashMapStoreOptions<Key, Value>): HashMapStore<Key, Value> {
		return new HashMapStore(options);
	}

	public bucketCount(): number {
		return Atomics.load(this.metaView, META_COUNT);
	}

	public entryCount(): number {
		const links = this.links.size();
		return links > 0 ? links - 1 : 0;
	}

	public override snapshot(): number {
		return this.entryCount();
	}

	public put(key: Codec.InferInput<Key>, value: Codec.InferInput<Value>): number {
		const index = this.entryCount();
		const from = this.links.get(index).entryPointer;
		const written = this.entry.encodeInto([key, value], this.entries.mmap(this.maxEntrySize, from));
		this.entries.reveal(from + written);
		this.links.set(index + 1, { prevIndex: null, entryPointer: this.entries.next(this.maxEntrySize, from + written) });
		this.reveal(index + 1);
		return index;
	}

	public stage(key: Codec.InferInput<Key>, value: Codec.InferInput<Value>): number {
		const index = this.entryCount();
		const from = this.links.get(index).entryPointer;
		const written = this.entry.encodeInto([key, value], this.entries.mmap(this.maxEntrySize, from));
		this.entries.reveal(from + written);
		this.links.set(index + 1, { prevIndex: null, entryPointer: this.entries.next(this.maxEntrySize, from + written) });
		this.links.resize(index + 2);
		return index;
	}

	public getIndex(key: Codec.InferInput<Key>, isSha256?: boolean): number | undefined {
		const keyBytes = this.keyScratch.subarray(0, this.key.encodeInto(key, this.keyScratch));
		for (let attempt = 0; attempt < 64; attempt++) {
			const generation = this.generation();
			if ((generation & 1) === 1) continue;
			const bucket = this.hashKey(keyBytes, isSha256) % this.bucketCount();
			let index = this.buckets.get(bucket);
			let match: number | undefined;
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
					match = index;
					break;
				}
				index = link.prevIndex;
			}

			if (this.generation() !== generation) continue;
			return match;
		}
	}

	public getKeyAtIndex(index: number): Codec.InferOutput<Key> {
		const link = this.links.get(index);
		const [key] = this.key.decode(this.entries.mmap(this.maxEntrySize, link.entryPointer));
		return key;
	}

	public getEntryAtIndex(index: number): TupleOutput<[Key, Value]> {
		const link = this.links.get(index);
		const [entry] = this.entry.decode(this.entries.mmap(this.maxEntrySize, link.entryPointer));
		return entry;
	}

	public get(key: Codec.InferInput<Key>, isSha256?: boolean): Codec.InferOutput<Value> | undefined {
		const index = this.getIndex(key, isSha256);
		if (index === undefined) return undefined;
		const [, value] = this.getEntryAtIndex(index);
		return value;
	}

	public getEntry(key: Codec.InferInput<Key>, isSha256?: boolean): TupleOutput<[Key, Value]> | undefined {
		const index = this.getIndex(key, isSha256);
		if (index === undefined) return undefined;
		return this.getEntryAtIndex(index);
	}

	public has(key: Codec.InferInput<Key>, isSha256?: boolean): boolean {
		return this.getIndex(key, isSha256) !== undefined;
	}

	public reveal(size: number): void {
		const targetEntries = size;
		const currentEntries = this.linkedCount;
		if (targetEntries < currentEntries) {
			throw new RangeError(
				`reveal entries=${targetEntries} is behind the linked cursor (linked=${currentEntries}); reveal only moves forward`,
			);
		}
		this.links.resize(targetEntries + 1);
		const bucketCount = this.bucketCount();
		for (let index = currentEntries; index < targetEntries; index++) {
			const link = this.links.get(index);
			const mmap = this.entries.mmap(this.maxEntrySize, link.entryPointer);
			const [, keySize] = this.key.decode(mmap);
			const bucket = this.hashKey(mmap.subarray(0, keySize), false) % bucketCount;
			const head = this.buckets.get(bucket);
			this.links.set(index, { prevIndex: head, entryPointer: link.entryPointer });
			this.buckets.set(bucket, index);
		}
		this.linkedCount = targetEntries;

		// maybe grow
		const count = this.bucketCount();
		if (count === 0) return;
		const entryCount = this.entryCount();
		const load = entryCount / count;
		if (load <= this.loadFactor.target + this.loadFactor.maxDrift) return;
		const newCount = Math.max(count * 2, Math.ceil(entryCount / this.loadFactor.target));

		// rehash
		console.log(`[hashmap ${this.path}] rehash ${this.bucketCount} -> ${newCount} buckets (${entryCount} entries)`);
		Atomics.add(this.metaView, META_GENERATION, 1);
		this.buckets.resize(Math.max(this.buckets.size(), newCount));
		this.rebuild(newCount, entryCount);
		Atomics.store(this.metaView, META_COUNT, newCount);
		Atomics.add(this.metaView, META_GENERATION, 1);
	}

	// For the parallel-write path (see parallelHashMapWrite.ts): entries in
	// [linkedCount, targetEntries) have already been written AND linked into
	// buckets by the caller (via CasBucketArray), unlike normal reveal()
	// which does the linking itself. This just advances the cursor and runs
	// the same load-factor/rehash check reveal() ends with.
	public revealPrelinked(targetEntries: number): void {
		if (targetEntries < this.linkedCount) {
			throw new RangeError(
				`revealPrelinked entries=${targetEntries} is behind the linked cursor (linked=${this.linkedCount})`,
			);
		}
		this.linkedCount = targetEntries;

		const count = this.bucketCount();
		if (count === 0) return;
		const entryCount = this.entryCount();
		const load = entryCount / count;
		if (load <= this.loadFactor.target + this.loadFactor.maxDrift) return;
		const newCount = Math.max(count * 2, Math.ceil(entryCount / this.loadFactor.target));

		console.log(`[hashmap ${this.path}] rehash ${this.bucketCount} -> ${newCount} buckets (${entryCount} entries)`);
		Atomics.add(this.metaView, META_GENERATION, 1);
		this.buckets.resize(Math.max(this.buckets.size(), newCount));
		this.rebuild(newCount, entryCount);
		Atomics.store(this.metaView, META_COUNT, newCount);
		Atomics.add(this.metaView, META_GENERATION, 1);
	}

	public recover(snapshot: number): void {
		{
			const generation = this.generation();
			const bucketCount = this.bucketCount();
			if ((generation & 1) === 0) return;
			console.log(`[hashmap ${this.path}] repairing torn rehash at ${bucketCount} buckets`);
			this.rebuild(this.bucketCount(), this.entryCount());
			Atomics.add(this.metaView, META_GENERATION, 1);
		}

		const targetEntries = snapshot;
		const currentEntries = this.entryCount();
		if (targetEntries > currentEntries) {
			throw new RangeError(`truncate entries=${targetEntries} is ahead of the cursor (entries=${currentEntries})`);
		}

		const bucketCount = this.bucketCount();
		for (let index = currentEntries - 1; index >= targetEntries; index--) {
			const link = this.links.get(index);
			const mmap = this.entries.mmap(this.maxEntrySize, link.entryPointer);
			const [, keySize] = this.key.decode(mmap);
			const bucket = this.hashKey(mmap.subarray(0, keySize), false) % bucketCount;
			this.buckets.set(bucket, link.prevIndex);
		}
		const entriesEnd = this.links.get(targetEntries).entryPointer;
		this.links.resize(targetEntries + 1);
		this.entries.truncate(entriesEnd);
		this.linkedCount = targetEntries;
	}

	public override sync(): void {
		this.entries.sync();
		this.links.sync();
		this.buckets.sync();
		this.meta.flush();
	}

	public close(): void {
		this.entries.close();
		this.links.close();
		this.buckets.close();
		this.meta.close();
	}

	public [Symbol.dispose](): void {
		this.close();
	}

	private generation(): number {
		return Atomics.load(this.metaView, META_GENERATION);
	}

	// Made public so parallel bulk-write paths (see parallelHashMapWrite.ts)
	// can compute the same bucket index this store's own getIndex()/reveal()
	// use, without duplicating the hash algorithm in a second place.
	public hashKey(keyBytes: Uint8Array, isSha256: boolean | undefined): number {
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

	private rebuild(bucketCount: number, entryCount: number): void {
		for (let bucket = 0; bucket < bucketCount; bucket++) this.buckets.set(bucket, null);
		for (let index = 0; index < entryCount; index++) {
			const link = this.links.get(index);
			const mmap = this.entries.mmap(this.maxEntrySize, link.entryPointer);
			const [, keySize] = this.key.decode(mmap);
			const bucket = this.hashKey(mmap.subarray(0, keySize), false) % bucketCount;
			const head = this.buckets.get(bucket);
			this.links.set(index, { prevIndex: head, entryPointer: link.entryPointer });
			this.buckets.set(bucket, index);
		}
	}
}
