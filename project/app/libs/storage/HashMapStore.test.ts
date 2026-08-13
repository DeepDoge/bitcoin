import { assertEquals } from "@std/assert";
import { Bytes32, StoredHeaderHashIndex, StoredHeaderHashPointer } from "@project/codecs";
import { U32 } from "@nomadshiba/codec";
import { sha256 } from "@noble/hashes/sha2";
import { HashMapStore } from "~/libs/storage/HashMapStore.ts";
import { join } from "@std/path";
import { rm } from "~/libs/fs/fs.ts";

// Match the headerhash store shape from manifest.ts (Bytes32 -> U32), but with
// tiny chunk sizes so we exercise chunk-boundary alignment in a small test.
function openStore(dir: string): HashMapStore<typeof Bytes32, typeof U32> {
	return HashMapStore.open({
		path: dir,
		loadFactor: { target: 0.75, maxDrift: 0.25 },
		entries: {
			key: Bytes32,
			value: U32,
			chunkSize: 256, // small to force multi-chunk scenarios
			pointer: StoredHeaderHashPointer,
		},
		buckets: {
			initialSize: 64,
			minChunkSize: 256,
		},
		links: {
			index: StoredHeaderHashIndex,
			minChunkSize: 256,
		},
		sha256: true,
	});
}

function randomKey(seed: number): Uint8Array {
	const k = new Uint8Array(32);
	const h = sha256(new Uint8Array([seed, seed >> 8, seed >> 16, seed >> 24]));
	k.set(h);
	return k;
}

Deno.test("HashMapStore: put resolves keys to values and indices", () => {
	const dir = join(Deno.env.get("TMP") ?? "/tmp", `hmtest-put-${Date.now()}`);
	try {
		const store = openStore(dir);
		const N = 50;
		const keys: Uint8Array[] = [];
		const values: number[] = [];

		for (let i = 0; i < N; i++) {
			const k = randomKey(i);
			keys.push(k);
			values.push(i);
			store.put(k, i);
		}

		// Every key resolves to its value + index
		for (let i = 0; i < N; i++) {
			assertEquals(store.get(keys[i]!), values[i], `get key ${i}`);
			assertEquals(store.getIndex(keys[i]!), i, `getIndex key ${i}`);
		}
		assertEquals(store.size(), N);

		store.close();
	} finally {
		rm(dir);
	}
});

Deno.test("HashMapStore: reveal wires new entries into buckets immediately (no staging)", () => {
	const dir = join(Deno.env.get("TMP") ?? "/tmp", `hmtest-reveal-${Date.now()}`);
	try {
		const store = openStore(dir);
		const N = 20;
		const keys: Uint8Array[] = [];

		for (let i = 0; i < N; i++) {
			const k = randomKey(i);
			keys.push(k);
			store.put(k, i);
			// Visible immediately, straight in the real buckets store — no
			// separate sync()/pin() needed to see it.
			assertEquals(store.get(k), i, `key ${i} visible right after put()`);
		}

		for (let i = 0; i < N; i++) {
			assertEquals(store.get(keys[i]!), i, `get key ${i}`);
			assertEquals(store.getIndex(keys[i]!), i, `getIndex key ${i}`);
		}
		assertEquals(store.size(), N);
		store.close();
	} finally {
		rm(dir);
	}
});

Deno.test("HashMapStore: truncate undoes puts (bucket heads restored)", () => {
	const dir = join(Deno.env.get("TMP") ?? "/tmp", `hmtest-truncate-${Date.now()}`);
	try {
		const store = openStore(dir);
		const keys: Uint8Array[] = [];

		for (let i = 0; i < 5; i++) {
			const k = randomKey(i);
			keys.push(k);
			store.put(k, i);
		}
		store.sync();

		for (let i = 0; i < 10; i++) {
			const k = randomKey(5 + i);
			keys.push(k);
			store.put(k, 5 + i);
		}
		assertEquals(store.size(), 15);

		// Truncate back to 5 — should undo the batch
		store.truncate(5);
		assertEquals(store.size(), 5);

		// Baseline keys still resolve
		for (let i = 0; i < 5; i++) {
			assertEquals(store.get(keys[i]!), i, `baseline key ${i} after truncate`);
			assertEquals(store.getIndex(keys[i]!), i, `baseline index ${i} after truncate`);
		}
		// Batch keys no longer resolve
		for (let i = 5; i < 15; i++) {
			assertEquals(store.get(keys[i]!), undefined, `batch key ${i} should be gone after truncate`);
		}

		// Can re-put on top — buckets are consistent
		for (let i = 0; i < 5; i++) {
			const k = randomKey(100 + i);
			keys.push(k);
			store.put(k, 100 + i);
		}
		assertEquals(store.size(), 10);
		for (let i = 0; i < 5; i++) assertEquals(store.get(keys[i]!), i, `baseline after recommit ${i}`);
		assertEquals(store.get(keys[15]!), 100, `new key after recommit`);
		assertEquals(store.get(keys[16]!), 101, `new key 2 after recommit`);

		store.close();
	} finally {
		rm(dir);
	}
});

Deno.test("HashMapStore: duplicate keys — latest wins (BIP30 semantics)", () => {
	const dir = join(Deno.env.get("TMP") ?? "/tmp", `hmtest-dup-${Date.now()}`);
	try {
		const store = openStore(dir);
		const dupKey = randomKey(999);

		// First put
		store.put(dupKey, 1);
		assertEquals(store.get(dupKey), 1);

		// Second put same key — new entry prepended to chain, wins reads
		store.put(dupKey, 2);
		assertEquals(store.get(dupKey), 2);
		assertEquals(store.getIndex(dupKey), 1); // latest index

		const k2 = randomKey(111);
		store.put(k2, 10);
		store.put(dupKey, 20);

		assertEquals(store.get(dupKey), 20, "latest put wins for dup key");
		assertEquals(store.getIndex(dupKey), 3, "latest index for dup key");
		assertEquals(store.get(k2), 10);

		store.close();
	} finally {
		rm(dir);
	}
});
