import { U32 } from "@nomadshiba/codec";
import { Bytes32, StoredBlockHeader, StoredHeaderHashIndex, StoredHeaderHashPointer } from "@project/codecs";
import { GB, MB } from "@project/utils";
import { join } from "@std/path";
import { BASE_DATA_DIR } from "~/env.ts";
import { ArrayStore } from "~/libs/storage/ArrayStore.ts";
import { HashMapStore, type LoadFactorOptions } from "~/libs/storage/HashMapStore.ts";
import { Manifest } from "~/libs/storage/Manifest.ts";
import { ChainStore } from "~/libs/storage/ChainStore.ts";

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
		chain: ChainStore.open({
			path: join(BASE_DATA_DIR, "chain"),
			loadFactor: LOAD_FACTOR_OPTIONS,
		}),
	},
});
