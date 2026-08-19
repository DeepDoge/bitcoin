import type { Job, Result } from "~/libs/storage/archive.worker.ts";

import type zlib from "node:zlib";

type Pending = {
	job: Job;
	resolve: (archivedSize: number) => void;
	reject: (error: Error) => void;
};

export class ArchiveWorkerPool implements Disposable {
	private readonly workers: Worker[] = [];
	private readonly idle: Worker[] = [];
	private readonly busy = new Map<Worker, Pending>();
	private readonly queue: Pending[] = [];
	private nextJobId = 0;
	private disposed = false;

	public constructor(size: number) {
		const count = Math.max(1, size);
		for (let i = 0; i < count; i++) {
			const worker = new Worker(new URL("./archive.worker.ts", import.meta.url), {
				type: "module",
				name: `archive-${i}`,
			});
			worker.onmessage = (event: MessageEvent<Result>) => this.onWorkerDone(worker, event.data);
			worker.onerror = (event) => this.onWorkerError(worker, event);
			this.workers.push(worker);
			this.idle.push(worker);
		}
	}

	public archive(index: number, rawPath: string, tmpPath: string, params: zlib.ZstdOptions["params"]): Promise<number> {
		if (this.disposed) return Promise.reject(new Error("archive pool is disposed"));
		return new Promise<number>((resolve, reject) => {
			const job: Job = { id: this.nextJobId++, index, rawPath, tmpPath, params };
			const pending: Pending = { job, resolve, reject };
			const worker = this.idle.pop();
			if (worker) {
				this.assign(worker, pending);
			} else {
				this.queue.push(pending);
			}
		});
	}

	private assign(worker: Worker, pending: Pending) {
		this.busy.set(worker, pending);
		console.log(`[archive] chunk ${pending.job.index} starting`);
		worker.postMessage(pending.job);
	}

	private onWorkerDone(worker: Worker, result: Result) {
		const pending = this.busy.get(worker);
		this.busy.delete(worker);
		if (pending) {
			if (result.ok) pending.resolve(result.archivedSize);
			else pending.reject(new Error(`worker failed to archive chunk ${result.index}: ${result.error}`));
		}
		if (this.disposed) {
			worker.terminate();
			return;
		}
		const next = this.queue.shift();
		if (next) this.assign(worker, next);
		else this.idle.push(worker);
	}

	private onWorkerError(worker: Worker, event: ErrorEvent) {
		const pending = this.busy.get(worker);
		this.busy.delete(worker);
		event.preventDefault?.();
		if (pending) pending.reject(new Error(`archive worker crashed: ${event.message}`));
		const idleAt = this.idle.indexOf(worker);
		if (idleAt >= 0) this.idle.splice(idleAt, 1);
		worker.terminate();
	}

	public dispose() {
		this.disposed = true;
		for (const pending of this.queue) pending.reject(new Error("archive pool disposed before job ran"));
		this.queue.length = 0;
		for (const worker of this.idle) worker.terminate();
		this.idle.length = 0;
	}

	public [Symbol.dispose]() {
		return this.dispose();
	}
}
