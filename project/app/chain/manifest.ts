import { StructCodec, U32 } from "@nomadshiba/codec";
import {
	Bytes32,
	NullableNumaricCodec,
	StoredBlockHeader,
	StoredBlockInfo,
	StoredHeaderHashIndex,
	StoredHeaderHashPointer,
	StoredOutputIndex,
	StoredPubKey,
	StoredPubKeyIndex,
	StoredTxIdIndex,
	StoredTxInfo,
	StoredTxInput,
	U48,
	WireTxInput,
} from "@project/codecs";
import { COINBASE_TXID, GB, MAX_BLOCK_SIZE, MB } from "@project/utils";
import { join } from "@std/path";
import { BASE_DATA_DIR } from "~/env.ts";
import { ArrayStore } from "~/libs/storage/ArrayStore.ts";
import { BlobStore } from "~/libs/storage/BlobStore.ts";
import { HashMapStore, type LoadFactorOptions } from "~/libs/storage/HashMapStore.ts";
import { Manifest } from "~/libs/storage/Manifest.ts";
import { SharedArrayStore } from "~/libs/storage/SharedArrayStore.ts";

const LOAD_FACTOR_OPTIONS: LoadFactorOptions = {
	target: .75,
	maxDrift: .25,
};

export const manifest = Manifest.open({
	path: join(BASE_DATA_DIR, "manifest"),
	pinner: self.name === "chain",
	stores: {
		header: ArrayStore.open({
			path: join(BASE_DATA_DIR, "header"),
			item: StoredBlockHeader,
			minChunkSize: 1 * GB,
		}),
		headerhash: HashMapStore.open({
			commiter: self.name === "chain",
			path: join(BASE_DATA_DIR, "headerhash"),
			loadFactor: LOAD_FACTOR_OPTIONS,
			entries: {
				key: Bytes32,
				value: U32,
				chunkSize: 500 * MB,
				pointer: StoredHeaderHashPointer,
			},
			buckets: {
				initialSize: 1_000_000,
				minChunkSize: 500 * MB,
			},
			links: {
				index: StoredHeaderHashIndex,
				minChunkSize: 500 * MB,
			},
			sha256: true,
		}),
		block: ArrayStore.open({
			path: join(BASE_DATA_DIR, "block"),
			item: StoredBlockInfo,
			minChunkSize: 1 * GB,
		}),
		tx: BlobStore.open({
			path: join(BASE_DATA_DIR, "tx"),
			chunkSize: 1 * GB,
			restore: { windowLogMax: 27 },
		}),
		txid: HashMapStore.open({
			commiter: self.name === "chain",
			path: join(BASE_DATA_DIR, "txid"),
			loadFactor: LOAD_FACTOR_OPTIONS,
			entries: {
				key: Bytes32,
				value: StoredTxInfo,
				chunkSize: 500 * MB,
				pointer: U48,
			},
			buckets: {
				initialSize: 1_000_000,
				minChunkSize: 500 * MB,
			},
			links: {
				index: StoredTxIdIndex,
				minChunkSize: 500 * MB,
			},
			sha256: true,
		}),
		pubkey: HashMapStore.open({
			commiter: self.name === "chain",
			path: join(BASE_DATA_DIR, "pubkey"),
			loadFactor: LOAD_FACTOR_OPTIONS,
			entries: {
				key: StoredPubKey,
				value: StoredOutputIndex,
				chunkSize: 1 * GB,
				maxEntrySize: MAX_BLOCK_SIZE,
				pointer: U48,
			},
			buckets: {
				initialSize: 1_000_000,
				minChunkSize: 500 * MB,
			},
			links: {
				index: StoredPubKeyIndex,
				minChunkSize: 500 * MB,
			},
			sha256: true,
		}),
		output: SharedArrayStore.open({
			writable: self.name === "chain",
			path: join(BASE_DATA_DIR, "output"),
			item: new StructCodec({
				ownerTx: StoredTxIdIndex,
				spenderTx: new NullableNumaricCodec(StoredTxIdIndex),
				prevSamePubkeyOutputIndex: new NullableNumaricCodec(StoredOutputIndex),
			}),
			minChunkSize: 500 * MB,
		}),
	},
});

export function getPrevOutTxId(input: StoredTxInput): WireTxInput["prevOut"]["txId"] {
	const txId = input.prevOut.txId;
	if (txId === null) return COINBASE_TXID;
	const [key] = manifest.stores.txid.getEntry(txId);
	return key;
}
