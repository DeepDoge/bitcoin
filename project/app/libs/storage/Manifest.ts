import { join } from "@std/path";
import { Store } from "~/libs/storage/Store.ts";

import { DatabaseSync, type StatementSync } from "node:sqlite";

const BROADCAST_PREFIX = "manifest-store-";

export type ManifestStores = { readonly [name: string]: Store };
export type ManifestOptions<T extends ManifestStores> = {
	path: string;
	stores: T;
	pinner: boolean;
	beforeRecovery(ctx: { pins: ReadonlyMap<string, number>; stores: T }): void;
};

export class Manifest<T extends ManifestStores> implements Disposable {
	public readonly stores: T;
	public readonly path: string;
	private readonly db: DatabaseSync;
	private readonly storeMap: ReadonlyMap<string, { store: Store; channel: BroadcastChannel }>;
	private readonly pinQuery: StatementSync;
	private readonly revealQuery: StatementSync;
	private readonly getSizesQuery: StatementSync;
	private readonly lockFile: Deno.FsFile | null;

	private constructor(options: ManifestOptions<T>) {
		this.path = options.path;
		this.stores = options.stores;
		this.storeMap = new Map(
			Object.entries(this.stores).map(([name, store]) => {
				const channel = new BroadcastChannel(`${BROADCAST_PREFIX}${name}`);
			channel.addEventListener("message", (event) => {
				const size = event.data as number;
				store.reveal(size);
			});
				return [name, { store, channel }];
			}),
		);
		this.db = new DatabaseSync(join(this.path, "manifest.sqlite"));
		this.db.exec(`PRAGMA journal_mode = WAL;`);
		this.db.exec(`PRAGMA busy_timeout = 5000;`);
		this.db.exec(
			`CREATE TABLE IF NOT EXISTS sizes (name TEXT PRIMARY KEY, pin INTEGER NOT NULL DEFAULT 0, reveal INTEGER NOT NULL DEFAULT 0);`,
		);
		this.getSizesQuery = this.db.prepare("SELECT * FROM sizes");
		this.pinQuery = this.db.prepare(
			`INSERT INTO sizes (name, pin) VALUES (:name, :size) ON CONFLICT(name) DO UPDATE SET pin = excluded.pin;`,
		);
		this.revealQuery = this.db.prepare(
			`INSERT INTO sizes (name, reveal) VALUES (:name, :size) ON CONFLICT(name) DO UPDATE SET reveal = excluded.reveal;`,
		);
		this.lockFile = null;
		if (options.pinner) {
			const lockFile = Deno.openSync(join(this.path, "PINNER.lock"), { create: true, read: true, write: true });
			if (!lockFile.tryLockSync(true)) {
				lockFile.close();
				throw new Error(`another pinner already holds ${join(this.path, "PINNER.lock")}`);
			}
			this.lockFile = lockFile;
		}
	}

	public static open<T extends ManifestStores>(options: ManifestOptions<T>) {
		Deno.mkdirSync(options.path, { recursive: true });
		const manifest = new Manifest<T>(options);
		const pins = manifest.getSizesQuery.all() as { name: string; pin: number; reveal: number }[];
		if (options.pinner) {
			// 1. Reveal every store up to its persisted `reveal` size first, so the
			//    uncommitted tail (crash-mid-chunk writes) is readable. A store's
			//    own persisted cursor can already be at or ahead of the DB value
			//    (it moves at reveal time, the DB at pin time), so only move it
			//    forward when the DB actually demands it.
			for (const { name, reveal } of pins) {
				const value = manifest.storeMap.get(name);
				if (!value) throw new Error(`Pinned store "${name}" does not exist.`);
				if (value.store.size() < reveal) value.store.reveal(reveal);
			}
			// 2. Let the app undo cross-store side effects that landed on
			//    already-revealed slots while everything is still readable. The
			//    mechanical cursor truncation below cannot touch live slots
			//    below the cursor, so anything written there (spends, etc.) must
			//    be reverted here, against the data that produced it, before it's
			//    truncated away.
			if (options.beforeRecovery) {
				const pinMap = new Map<string, number>();
				for (const { name, pin } of pins) pinMap.set(name, pin);
				options.beforeRecovery({ pins: pinMap, stores: manifest.stores });
			}
			// 3. Rewind every store's cursor to its pin. HashMapStore.truncate
			//    restores its own bucket heads from the links' prevIndex chain,
			//    so no cross-store help is needed for headerhash/txid/pubkey —
			//    only the effects the beforeRecovery hook just undid had escaped
			//    to other stores.
			for (const { name, pin } of pins) {
				const value = manifest.storeMap.get(name);
				if (!value) throw new Error(`Pinned store "${name}" does not exist.`);
				if (value.store.size() > pin) value.store.truncate(pin);
			}
		} else {
			for (const { name, pin } of pins) {
				const value = manifest.storeMap.get(name);
				if (!value) throw new Error(`Pinned store "${name}" does not exist.`);
				if (value.store.size() < pin) value.store.reveal(pin);
			}
		}
		return manifest;
	}

	public pin() {
		try {
			this.db.exec("BEGIN IMMEDIATE;");
			for (const [name, { store }] of this.storeMap) {
				this.revealQuery.run({ name, size: store.size() });
			}
			this.db.exec("COMMIT;");
		} catch (reason) {
			console.error(reason);
			if (this.db.isTransaction) this.db.exec("ROLLBACK;");
			Deno.kill(Deno.pid);
		}
		try {
			this.db.exec("BEGIN IMMEDIATE;");
			for (const [name, { store, channel }] of this.storeMap) {
				store.sync();
				const size = store.size();
				this.pinQuery.run({ name, size });
				channel.postMessage(size);
			}
			this.db.exec("COMMIT;");
		} catch (reason) {
			console.error(reason);
			if (this.db.isTransaction) this.db.exec("ROLLBACK;");
			Deno.kill(Deno.pid);
		}
	}

	public close() {
		this.db.close();
		if (this.lockFile) {
			this.lockFile.unlockSync();
			this.lockFile.close();
		}
	}

	public [Symbol.dispose](): void {
		this.close();
	}
}
