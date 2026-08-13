import { join } from "@std/path";
import { Store } from "~/libs/storage/Store.ts";

import { DatabaseSync, type StatementSync } from "node:sqlite";

export type ManifestStores = { readonly [name: string]: Store };
export type ManifestOptions<T extends ManifestStores> = {
	path: string;
	stores: T;
	pinner: boolean;
	beforeRecovery(ctx: { pins: ReadonlyMap<string, number>; stores: T }): void;
};

// Every store's cursor lives in its own shared mmap now (BlobStore and
// SharedArrayStore both), so `size()` is always the live truth for every
// opener, in every process, the instant reveal() runs — no broadcast, no
// separate "reveal" checkpoint needed to find out. `pin` is the only thing
// this class still persists: a durable checkpoint sqlite can recover to after
// an unclean shutdown, and the boundary the frontend/API should trust. It has
// nothing to do with cross-worker visibility anymore.
export class Manifest<T extends ManifestStores> implements Disposable {
	public readonly stores: T;
	public readonly path: string;
	private readonly db: DatabaseSync;
	private readonly storeMap: ReadonlyMap<string, Store>;
	private readonly pinQuery: StatementSync;
	private readonly getPinsQuery: StatementSync;
	private readonly lockFile: Deno.FsFile | null;

	private constructor(options: ManifestOptions<T>) {
		this.path = options.path;
		this.stores = options.stores;
		this.storeMap = new Map(Object.entries(this.stores));
		this.db = new DatabaseSync(join(this.path, "manifest.sqlite"));
		this.db.exec(`PRAGMA journal_mode = WAL;`);
		this.db.exec(`PRAGMA busy_timeout = 5000;`);
		this.db.exec(`CREATE TABLE IF NOT EXISTS sizes (name TEXT PRIMARY KEY, pin INTEGER NOT NULL DEFAULT 0);`);
		this.getPinsQuery = this.db.prepare("SELECT * FROM sizes");
		this.pinQuery = this.db.prepare(
			`INSERT INTO sizes (name, pin) VALUES (:name, :size) ON CONFLICT(name) DO UPDATE SET pin = excluded.pin;`,
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
		// Only the pinner recovers. A non-pinner opener's stores already read
		// the live, shared cursors straight off disk — there is nothing to
		// catch up on. This also relies on the pinner (chain) always opening
		// the manifest (and running recovery) before any consume worker is
		// spawned, so a fresh consume worker never observes pre-recovery state.
		if (!options.pinner) return manifest;

		const pins = manifest.getPinsQuery.all() as { name: string; pin: number }[];
		const pinMap = new Map<string, number>();
		for (const { name, pin } of pins) pinMap.set(name, pin);

		// Let the app undo cross-store side effects that landed on slots the
		// mechanical truncate below is about to roll back. Every store's live
		// cursor already reflects whatever survived the unclean shutdown (no
		// reveal step needed — it was never buffered anywhere else), so
		// beforeRecovery can read all of it directly before truncation removes it.
		options.beforeRecovery({ pins: pinMap, stores: manifest.stores });

		// Rewind every store's cursor to its last durable pin. HashMapStore's
		// truncate restores its own bucket heads from the links' prevIndex
		// chain, so no cross-store help is needed for headerhash/txid/pubkey —
		// only the effects the beforeRecovery hook just undid had escaped to
		// other stores.
		for (const { name, pin } of pins) {
			const store = manifest.storeMap.get(name);
			if (!store) throw new Error(`Pinned store "${name}" does not exist.`);
			if (store.size() > pin) store.truncate(pin);
		}
		return manifest;
	}

	public pin(): void {
		try {
			this.db.exec("BEGIN IMMEDIATE;");
			for (const [name, store] of this.storeMap) {
				store.sync();
				this.pinQuery.run({ name, size: store.size() });
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
