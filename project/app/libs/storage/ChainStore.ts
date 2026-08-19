import { type Codec, StructCodec, Void } from "@nomadshiba/codec";
import {
	Bytes32,
	NullableNumaricCodec,
	StoredBlockInfo,
	StoredOutputIndex,
	StoredPubKey,
	StoredPubKeyIndex,
	StoredTx,
	StoredTxIdIndex,
	StoredTxInfo,
	StoredTxInput,
	StoredTxPointer,
	U48,
	WireTxInput,
} from "@project/codecs";
import { COINBASE_TXID, GB, MAX_BLOCK_SIZE, MB } from "@project/utils";
import { join } from "@std/path";
import { BlobStore } from "~/libs/storage/BlobStore.ts";
import { AtomicMmapArray } from "~/libs/storage/AtomicMmapArray.ts";
import { HashMapStore, type LoadFactorOptions } from "~/libs/storage/HashMapStore.ts";
import { Store } from "~/libs/storage/Store.ts";
import { ArrayStore } from "~/libs/storage/ArrayStore.ts";

const TX_BLOB_CHUNK_SIZE = 1 * GB;
const TX_RESTORE_WINDOW_LOG_MAX = 27;

const OUTPUT_MIN_CHUNK_SIZE = 500 * MB;

const TXID_ENTRIES_CHUNK_SIZE = 500 * MB;
// Pre-sized large enough that the txid hashmap does not rehash during a typical
// IBD run: each rehash is an O(entryCount) synchronous pass over every entry
// (HashMapStore.rebuild) and blocks the single-writer commit thread for tens
// of seconds at multi-million entry counts (observed ~50s at 8M entries). At
// load factor 0.75, 64M buckets holds ~48M entries before the first rehash.
// Cost: 64M * 6 bytes/slot = 384 MB on disk (mmap-backed). Full mainnet sync
// (~900M txids) would need ~1.2B buckets (~7 GB) for zero rehash — not seeded
// here due to storage cost; revisit (or offload rehash off the commit thread)
// if late-IBD storms reappear.
const TXID_BUCKETS_INITIAL_SIZE = 67_108_864;
const TXID_BUCKETS_MIN_CHUNK_SIZE = 500 * MB;
const TXID_LINKS_MIN_CHUNK_SIZE = 500 * MB;

const PUBKEY_ENTRIES_CHUNK_SIZE = 1 * GB;
// Same rationale as TXID_BUCKETS_INITIAL_SIZE: avoid synchronous rehash storms
// on the commit thread. Unique scriptPubKeys grow slower than txids; 16M
// buckets (~12M entries at load 0.75) is enough headroom for a typical IBD run.
// Cost: 16M * 6 bytes/slot = 96 MB on disk.
const PUBKEY_BUCKETS_INITIAL_SIZE = 16_777_216;
const PUBKEY_BUCKETS_MIN_CHUNK_SIZE = 500 * MB;
const PUBKEY_LINKS_MIN_CHUNK_SIZE = 500 * MB;

const BLOCK_MIN_CHUNK_SIZE = 1 * GB;

type ChainStoreOutputItem = Codec.InferOutput<typeof ChainStoreOutputItem>;
const ChainStoreOutputItem = new StructCodec({
	ownerTx: StoredTxIdIndex,
	prevSamePubkeyOutputIndex: new NullableNumaricCodec(StoredOutputIndex),
});

type ChainStoreSpenderItem = Codec.InferOutput<typeof ChainStoreSpenderItem>;
const ChainStoreSpenderItem = new NullableNumaricCodec(StoredTxIdIndex);

export type ChainStoreOptions = {
	path: string;
	loadFactor: LoadFactorOptions;
};

// Holds everything that must recover to the same block-height snapshot
// together: block records, tx bytes, the txid/pubkey indexes, output rows,
// and spender marks. snapshot()/recover() are height-based (not raw byte
// offsets) so that a single pin point always corresponds to a whole,
// consistent block boundary across every sub-store here — the block store is
// always the LAST thing written per height (see chain/worker.ts's pipeline:
// block.reveal happens after txid/output/spender/pubkey are committed), so if
// a height is visible in `block`, everything else for it is guaranteed
// correct and committed too. recover() relies on exactly that invariant.
export class ChainStore extends Store implements Disposable {
	public readonly path: string;
	public readonly tx: BlobStore;
	public readonly output: ArrayStore<typeof ChainStoreOutputItem>;
	public readonly spender: AtomicMmapArray<typeof ChainStoreSpenderItem>;
	public readonly txid: HashMapStore<typeof Bytes32, typeof StoredTxInfo>;
	public readonly block: ArrayStore<typeof StoredBlockInfo>;

	private readonly pubkey: HashMapStore<typeof StoredPubKey, typeof Void>;
	private readonly pubkeyOutputHead: AtomicMmapArray<typeof StoredOutputIndex>;

	private constructor(options: ChainStoreOptions) {
		super();
		this.path = options.path;
		this.tx = BlobStore.open({
			path: join(options.path, "tx"),
			chunkSize: TX_BLOB_CHUNK_SIZE,
			restore: { windowLogMax: TX_RESTORE_WINDOW_LOG_MAX },
		});
		this.block = ArrayStore.open({
			path: join(options.path, "block"),
			item: StoredBlockInfo,
			minChunkSize: BLOCK_MIN_CHUNK_SIZE,
		});
		this.output = ArrayStore.open({
			path: join(options.path, "output"),
			item: ChainStoreOutputItem,
			minChunkSize: OUTPUT_MIN_CHUNK_SIZE,
		});
		this.spender = AtomicMmapArray.open({
			path: join(options.path, "spender"),
			item: ChainStoreSpenderItem,
			minChunkSize: OUTPUT_MIN_CHUNK_SIZE,
		});
		this.txid = HashMapStore.open({
			path: join(options.path, "txid"),
			loadFactor: options.loadFactor,
			entries: {
				key: Bytes32,
				value: StoredTxInfo,
				chunkSize: TXID_ENTRIES_CHUNK_SIZE,
				pointer: StoredTxPointer,
			},
			buckets: {
				initialSize: TXID_BUCKETS_INITIAL_SIZE,
				minChunkSize: TXID_BUCKETS_MIN_CHUNK_SIZE,
			},
			links: {
				index: StoredTxIdIndex,
				minChunkSize: TXID_LINKS_MIN_CHUNK_SIZE,
			},
		});
		this.pubkey = HashMapStore.open({
			path: join(options.path, "pubkey"),
			loadFactor: options.loadFactor,
			entries: {
				key: StoredPubKey,
				value: Void,
				chunkSize: PUBKEY_ENTRIES_CHUNK_SIZE,
				maxEntrySize: MAX_BLOCK_SIZE,
				pointer: U48,
			},
			buckets: {
				initialSize: PUBKEY_BUCKETS_INITIAL_SIZE,
				minChunkSize: PUBKEY_BUCKETS_MIN_CHUNK_SIZE,
			},
			links: {
				index: StoredPubKeyIndex,
				minChunkSize: PUBKEY_LINKS_MIN_CHUNK_SIZE,
			},
			sha256: true,
		});
		this.pubkeyOutputHead = AtomicMmapArray.open({
			path: join(options.path, "pubkeyOutputHead"),
			item: StoredOutputIndex,
			minChunkSize: PUBKEY_BUCKETS_MIN_CHUNK_SIZE,
		});
	}

	public static open(options: ChainStoreOptions): ChainStore {
		return new ChainStore(options);
	}

	public override snapshot(): number {
		return this.block.size();
	}

	public override sync(): void {
		this.tx.sync();
		this.block.sync();
		this.output.sync();
		this.spender.sync();
		this.txid.sync();
		this.pubkey.sync();
		this.pubkeyOutputHead.sync();
	}

	public override recover(snapshot: number): void {
		const blockHeight = snapshot;
		const currentBlockCount = this.block.size();
		if (blockHeight >= currentBlockCount) return;

		// The block at blockHeight is the FIRST doomed block (heights
		// [0, blockHeight) are kept). Its txPointer is where its txs start
		// in the tx blob (past the StoredTxs VarInt counter). Recovery
		// iterates block-by-block using each block's StoredBlockInfo to find
		// its txs and tx count.
		const blockInfo = this.block.get(blockHeight);
		if (!blockInfo) throw new Error(`recover: block at height ${blockHeight} not found`);
		const txPin = blockInfo.txPointer;

		const currentTxSize = this.tx.size();
		if (txPin >= currentTxSize) {
			this.block.recover(blockHeight);
			return;
		}

		console.log(`[chainstore ${this.path}] recovering: rewinding block ${currentBlockCount} -> ${blockHeight}, tx ${currentTxSize} -> ${txPin}`);

		const originalOutputCount = this.output.size();
		let doomedTxCount = 0;
		let doomedOutputCount = 0;
		const doomedOutputPubkeys: { relativeOutputIndex: number; pubkeyIndex: number }[] = [];

		// Iterate doomed txs block-by-block. Each block's txs are stored as
		// a StoredTxs record (VarInt counter + StoredTx[]) in the tx blob.
		// blockInfo.txPointer points past the counter to the first StoredTx,
		// and blockInfo.txCount tells us how many txs to read.
		for (let doomedHeight = blockHeight; doomedHeight < currentBlockCount; doomedHeight++) {
			const doomedBlockInfo = this.block.get(doomedHeight);
			if (!doomedBlockInfo) break;
			let at = doomedBlockInfo.txPointer;
			const txsInBlock = doomedBlockInfo.txCount;
			for (let t = 0; t < txsInBlock; t++) {
				if (at >= currentTxSize) break;
				const [tx, size] = this.tx.get(at, StoredTx);
				doomedTxCount++;

				for (const input of tx.inputs) {
					const spentTxIdIndex = input.prevOut.txId;
					if (spentTxIdIndex === null) continue;
					const vout = input.prevOut.output;
					if (spentTxIdIndex >= this.txid.entryCount()) continue;
					const [, spentTxInfo] = this.txid.getEntryAtIndex(spentTxIdIndex);
					const prevOutputIndex = spentTxInfo.totalOutput + vout;
					if (prevOutputIndex >= this.spender.size()) continue;
					this.spender.set(prevOutputIndex, null);
				}

				for (const output of tx.outputs) {
					doomedOutputPubkeys.push({ relativeOutputIndex: doomedOutputCount, pubkeyIndex: output.scriptPubKey });
					doomedOutputCount++;
				}

				at += size;
			}
		}

		const newOutputCount = originalOutputCount - doomedOutputCount;
		const newTxIdCount = this.txid.entryCount() - doomedTxCount;

		for (let i = doomedOutputPubkeys.length - 1; i >= 0; i--) {
			const { relativeOutputIndex, pubkeyIndex } = doomedOutputPubkeys[i]!;
			const absoluteOutputIndex = newOutputCount + relativeOutputIndex;
			const outputRow = this.output.get(absoluteOutputIndex);
			if (!outputRow) continue;
			// prevSamePubkeyOutputIndex is null for the first output of a
			// pubkey in the doomed range (or coinbase outputs). Skip those
			// — there's no prior output head to restore. With batched
			// pinning this can also happen for outputs whose prior was in
			// the committed range; the pubkeyOutputHead for that pubkey
			// will be set by a different doomed output or is already correct.
			if (outputRow.prevSamePubkeyOutputIndex === null) continue;
			this.pubkeyOutputHead.set(pubkeyIndex, outputRow.prevSamePubkeyOutputIndex);
		}

		this.txid.recover(newTxIdCount);
		this.tx.recover(txPin);
		this.output.recover(newOutputCount);
		this.spender.resize(newOutputCount);
		this.block.recover(blockHeight);
	}

	public getPrevOutTxId(input: StoredTxInput): WireTxInput["prevOut"]["txId"] {
		const txId = input.prevOut.txId;
		if (txId === null) return COINBASE_TXID;
		const [key] = this.txid.getEntryAtIndex(txId);
		return key;
	}

	public getPubkeyIndex(scriptPubKey: Uint8Array): number | undefined {
		return this.pubkey.getIndex(scriptPubKey);
	}

	public putPubkey(scriptPubKey: Uint8Array): number {
		const newIndex = this.pubkey.put(scriptPubKey, undefined);
		this.pubkeyOutputHead.resize(this.pubkey.entryCount());
		return newIndex;
	}

	public getPubkeyAtIndex(pubkeyIndex: number): Codec.InferOutput<typeof StoredPubKey> {
		return this.pubkey.getKeyAtIndex(pubkeyIndex);
	}

	public getPubkeyLastOutput(pubkeyIndex: number): number | null {
		return this.pubkeyOutputHead.get(pubkeyIndex);
	}

	public setPubkeyLastOutput(pubkeyIndex: number, outputIndex: number): void {
		this.pubkeyOutputHead.set(pubkeyIndex, outputIndex);
	}

	public close(): void {
		this.tx.close();
		this.block.close();
		this.output.close();
		this.spender.close();
		this.txid.close();
		this.pubkey.close();
		this.pubkeyOutputHead.close();
	}

	public [Symbol.dispose](): void {
		this.close();
	}
}