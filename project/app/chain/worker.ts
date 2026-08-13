import { equals } from "@std/bytes";
import { delay } from "@std/async";
import { manifest } from "~/chain/manifest.ts";
import { GENESIS_BLOCK_HASH, GENESIS_BLOCK_HEADER_DECODED } from "~/chain/genesis.ts";
import type { CommittedResult, ConsumeRequest, ConsumeResult, DecodedResult, WorkerMessage } from "~/chain/consume.protocol.ts";

import { verifyProofOfWork, workFromHeader } from "@project/bitcoin";
import { Queue } from "@project/collections";
import { MessagePortLike } from "@project/message";
import { WireBlockHeader } from "@project/codecs";
import { WireBlockHeaders } from "@project/codecs";
import { PARALLELISM_THREADS } from "~/env.ts";

console.log("[chain] booting");

// This worker is the SINGLE pinner: it owns every store's durable commit. p2p
// is pure networking now — it reads headers from shared mmap to drive downloads
// and builds locators, but never writes or pins. Header application (reorg-aware
// most-work adoption) and block-body indexing both land here, so one worker holds
// the manifest write lock and there is no cross-isolate BEGIN IMMEDIATE contention.

const p2pMessageQueue = new Queue<{ type: string; data: any }>(1000);
const chunkQueue = new Queue<Uint8Array>(256);

// ── blocks/s throughput ──────────────────────────────────────────────────────
const RATE_REPORT_INTERVAL_MS = 2_000;
const bootAt = performance.now();
let totalBlocks = 0;
let windowBlocks = 0;
let lastReportAt = bootAt;
let windowChunksUsed = 0;
let windowCommitMs = 0;
let windowGapMs = 0;
let windowCommitSamples = 0;
let lastCommitEndAt = bootAt;

function recordBlocks(n: number, tipHeight: number, chunksUsed: number, nWorkers: number, commitMs: number, gapMs: number): void {
	totalBlocks += n;
	windowBlocks += n;
	windowChunksUsed += chunksUsed;
	windowCommitMs += commitMs;
	windowGapMs += gapMs;
	windowCommitSamples += 1;
	const now = performance.now();
	const windowMs = now - lastReportAt;
	if (windowMs < RATE_REPORT_INTERVAL_MS) return;
	const windowRate = windowBlocks / (windowMs / 1000);
	const avgRate = totalBlocks / ((now - bootAt) / 1000);
	const avgChunks = windowCommitSamples > 0 ? windowChunksUsed / windowCommitSamples : 0;
	const avgCommitMs = windowCommitSamples > 0 ? windowCommitMs / windowCommitSamples : 0;
	const avgGapMs = windowCommitSamples > 0 ? windowGapMs / windowCommitSamples : 0;
	const dutyCycle = windowCommitMs + windowGapMs > 0 ? (windowCommitMs / (windowCommitMs + windowGapMs)) * 100 : 0;
	console.log(
		`[chain] ${windowRate.toFixed(0)} blocks/s (avg ${avgRate.toFixed(0)}/s) height=${tipHeight} total=${totalBlocks} chunks=${
			avgChunks.toFixed(1)
		}/${nWorkers} commit=${avgCommitMs.toFixed(1)}ms gap=${avgGapMs.toFixed(1)}ms duty=${dutyCycle.toFixed(0)}%`,
	);
	windowBlocks = 0;
	windowChunksUsed = 0;
	windowCommitMs = 0;
	windowGapMs = 0;
	windowCommitSamples = 0;
	lastReportAt = now;
}

// ── header chain (this worker owns the writes now) ────────────────────────────

function tipHeight(): number {
	return manifest.stores.header.size() - 1;
}

function headerAt(height: number): WireBlockHeader | undefined {
	return manifest.stores.header.get(height);
}

function headerHashAt(height: number): Uint8Array | undefined {
	return manifest.stores.header.get(height)?.hash();
}

function tipHash(): Uint8Array | undefined {
	const height = tipHeight();
	return height < 0 ? undefined : headerHashAt(height);
}

function heightOfHash(hash: Uint8Array): number | undefined {
	const height = manifest.stores.headerhash.get(hash);
	if (height === undefined) return undefined;
	const at = headerHashAt(height);
	return at && equals(at, hash) ? height : undefined;
}

type ApplyResult = { adopted: number; rewind?: number };

function applyHeaders(headers: WireBlockHeader[]): ApplyResult {
	const head = headers[0];
	if (!head) return { adopted: 0 };

	const tip = tipHash();
	if (tip === undefined) return { adopted: 0 };

	let splitHeight: number;
	if (equals(head.prevHash, tip)) {
		splitHeight = tipHeight();
	} else {
		const forked = heightOfHash(head.prevHash);
		if (forked === undefined) return { adopted: 0 };
		splitHeight = forked;
	}

	const branch: WireBlockHeader[] = [];
	let prevHash = headerHashAt(splitHeight)!;
	let branchWork = 0n;
	for (const header of headers) {
		if (!equals(header.prevHash, prevHash)) break;
		if (!verifyProofOfWork(header)) break;
		branch.push(header);
		branchWork += workFromHeader(header);
		prevHash = header.hash();
	}
	if (branch.length === 0) return { adopted: 0 };

	const currentTip = tipHeight();
	let ourWork = 0n;
	for (let h = splitHeight + 1; h <= currentTip; h++) ourWork += workFromHeader(headerAt(h)!);

	const isReorg = splitHeight < currentTip;
	if (isReorg && branchWork <= ourWork) return { adopted: 0 };

	let rewind: number | undefined;
	if (isReorg) {
		console.log(`[chain] header reorg: dropping height ${tipHeight()} -> ${splitHeight}, applying ${branch.length} headers`);
		manifest.stores.header.truncate(splitHeight + 1);

		if (splitHeight < manifest.stores.block.size() - 1) {
			throw new Error(
				`header reorg to ${splitHeight} is below committed block tip ${manifest.stores.block.size() - 1}; ` +
					`block-domain rewind is not implemented`,
			);
		}

		rewind = splitHeight;
	}

	for (const header of branch) {
		const height = manifest.stores.header.stage(header);
		manifest.stores.header.reveal(height + 1);
		manifest.stores.headerhash.put(header.hash(), height);
	}
	manifest.pin();
	return { adopted: branch.length, rewind };
}

self.onmessage = async (event) => {
	console.log("[chain] main-port message event, ports:", event.ports.length, "data:", event.data);
	const port = event.ports[0]!;
	prepare(port);
	port.start();

	if (manifest.stores.header.size() === 0) {
		const height = manifest.stores.header.stage(GENESIS_BLOCK_HEADER_DECODED);
		manifest.stores.header.reveal(height + 1);
		manifest.stores.headerhash.put(GENESIS_BLOCK_HASH, height);
		manifest.pin();
		console.log("[chain] seeded genesis header");
	}

	manifest.stores.tx.startArchiveWorkers({
		maxRestoredChunks: 8,
		zstd: {
			archive: {
				compressionLevel: 19,
				enableLongDistanceMatching: 1,
				windowLog: 27,
				checksumFlag: 1,
				contentSizeFlag: 1,
			},
		},
	});

	await startConsumePipeline(port);
};

self.onunhandledrejection = (e) => {
	console.error("[chain] unhandledrejection:", e.reason);
};

self.postMessage(null);

function prepare(port: MessagePortLike): void {
	port.addEventListener("message", (event) => p2pMessageQueue.enqueue(event.data));

	const target = manifest.stores.block.size() - 1;
	console.log(`[chain] sync port received, blocks committed up to height ${target}, requesting from p2p`);
	port.postMessage({ type: "seek", data: target });
	port.postMessage({ type: "start" });
}

/** Drain p2p messages. Headers are handled inline (cheap, p2p blocks on the ack);
 * blocks are enqueued for the pipeline. Returns when the queue is empty. */
async function drainP2P(port: MessagePortLike): Promise<void> {
	while (true) {
		const message = p2pMessageQueue.dequeue();
		if (!message) return;
		if (message.type === "blocks") {
			if (!chunkQueue.enqueue(message.data as Uint8Array)) {
				console.error("[chain] chunkQueue overflow — p2p backpressure is not holding");
				Deno.kill(Deno.pid);
			}
		} else if (message.type === "headers") {
			const [headers] = WireBlockHeaders.decode(message.data as Uint8Array);
			try {
				const result = applyHeaders(headers);
				port.postMessage({ type: "headers-applied", data: result });
			} catch (reason) {
				console.error("[chain] applyHeaders failed:", reason);
				Deno.kill(Deno.pid);
			}
		}
	}
}

// ── pipelined consume worker pool ─────────────────────────────────────────────
//
// Long-lived consumer workers (one per parallelism thread). Each holds read-
// only handles to the shared mmap stores — they see committed data live via
// the shared CURSOR mmaps without any RPC. Spawned lazily on first use; reused
// for the lifetime of the worker.
//
// Pipeline (real, not rounds): each worker is an independent state machine
// FREE → DECODING → DECODED(waiting turn) → COMMITTING → FREE. Decode dispatch
// is gated ONLY on "a chunk is queued AND a worker is FREE" — never on commits
// finishing — so stage 1 (the sha256d-heavy decode) stays saturated. Commit
// runs strictly in chunk-sequence order: chunk K's commit turn is granted only
// after chunk K-1 is committed + pinned, so the live store values ARE the
// correct bases — no negotiation, no cross-worker maps, no scratch.

const consumeWorkerUrl = new URL("./consume.worker.ts", import.meta.url);
const consumeWorkers: Worker[] = [];

async function ensureConsumeWorkers(): Promise<void> {
	if (consumeWorkers.length > 0) return;
	const n = Math.max(1, PARALLELISM_THREADS);
	console.log(`[chain] spawning ${n} consume workers`);
	const readyPromises: Promise<void>[] = [];
	for (let i = 0; i < n; i++) {
		const w = new Worker(consumeWorkerUrl, { type: "module", name: `consumer-${i}` });
		const ready = new Promise<void>((resolve, reject) => {
			const onMessage = (event: MessageEvent<WorkerMessage>) => {
				const msg = event.data;
				if (msg.type === "ready") {
					w.removeEventListener("message", onMessage);
					resolve();
				} else if (msg.type === "error") {
					w.removeEventListener("message", onMessage);
					reject(new Error(`${msg.phase}: ${msg.message}`));
				}
			};
			w.addEventListener("message", onMessage);
			w.addEventListener("error", (e) => reject(new Error((e as ErrorEvent).message)));
		});
		consumeWorkers.push(w);
		readyPromises.push(ready);
	}
	await Promise.all(readyPromises);
	console.log(`[chain] all consume workers ready`);
}

/** Send a request to a worker and await its result (one in-flight per worker). */
function workerRound(w: Worker, req: ConsumeRequest): Promise<ConsumeResult> {
	return new Promise((resolve, reject) => {
		const onMessage = (event: MessageEvent<WorkerMessage>) => {
			const msg = event.data;
			if (msg.type === "error") {
				w.removeEventListener("message", onMessage);
				reject(new Error(`${msg.phase}: ${msg.message}`));
				return;
			}
			if (msg.type === "decoded" || msg.type === "committed") {
				w.removeEventListener("message", onMessage);
				resolve(msg);
				return;
			}
		};
		w.addEventListener("message", onMessage);
		w.addEventListener("error", (e) => {
			w.removeEventListener("message", onMessage);
			reject(new Error((e as ErrorEvent).message));
		});
		w.postMessage(req);
	});
}

type Slot = {
	worker: Worker;
	busy: boolean;
	seq: number;
	decode: Promise<DecodedResult> | null;
};

/**
 * The pipeline driver — runs forever once started. Each iteration either
 * dispatches a decode to a free worker (non-blocking) or commits the chunk
 * whose turn has come (blocking, in order). The call to dispatch() BETWEEN
 * awaiting decode and awaiting commit is what makes this a real pipeline:
 * free workers refill their decode stage while some worker is busy
 * committing, so stage 1 stays saturated.
 *
 * The committing worker writes everything itself, straight into the shared
 * mmaps — chain's only remaining jobs per chunk are handing out the commit
 * turn and calling manifest.pin(), the durable checkpoint (crash recovery +
 * frontend/API boundary), which has nothing to do with cross-worker
 * visibility anymore.
 */
async function startConsumePipeline(port: MessagePortLike): Promise<void> {
	await ensureConsumeWorkers();
	const nWorkers = consumeWorkers.length;

	const slots: Slot[] = consumeWorkers.map((w) => ({ worker: w, busy: false, seq: 0, decode: null }));
	let nextDispatchSeq = 0;
	let nextCommitSeq = 0;

	/** Non-blocking: hand a chunk to every free worker that can get one. */
	const dispatch = (): void => {
		for (const slot of slots) {
			if (slot.busy) continue;
			const chunk = chunkQueue.dequeue();
			if (!chunk) break;
			slot.busy = true;
			slot.seq = nextDispatchSeq++;
			slot.decode = workerRound(slot.worker, { type: "decode", chunk }) as Promise<DecodedResult>;
		}
	};

	const blockStore = manifest.stores.block;

	while (true) {
		try {
			// Drain p2p messages so chunks posted between iterations land in
			// chunkQueue before dispatch.
			await drainP2P(port);

			// Top up free workers with new decode work.
			dispatch();

			// Find the chunk whose commit turn has come (oldest in-flight).
			const slot = slots.find((s) => s.busy && s.seq === nextCommitSeq);
			if (!slot || !slot.decode) {
				// Nothing ready to commit yet — either all workers are free
				// (no chunks queued) or the next-in-line is still decoding.
				await delay(1);
				continue;
			}

			// Await the decode result for this chunk.
			await slot.decode;

			// CRITICAL: refill free workers BEFORE awaiting commit. This is the
			// only line that makes the pipeline real — while this worker
			// commits chunk K, other workers decode chunks K+1, K+2, ...
			await drainP2P(port);
			dispatch();

			const commitStart = performance.now();
			const gapMs = commitStart - lastCommitEndAt;

			const res = await workerRound(slot.worker, { type: "commit" }) as CommittedResult;

			// Durable checkpoint. The worker already wrote everything (tx
			// bytes, txid/pubkey entries, output rows, block records) straight
			// into the shared mmaps, visible to every other worker already —
			// pin() just fsyncs and records the recovery boundary.
			manifest.pin();

			// Ack p2p — one per chunk consumed, so its postedChunks-consumedChunks
			// backpressure can drain at the same rate we commit.
			port.postMessage({ type: "consume" });

			const commitMs = performance.now() - commitStart;
			lastCommitEndAt = performance.now();
			recordBlocks(res.blockCount, blockStore.size() - 1, 1, nWorkers, commitMs, gapMs);

			slot.busy = false;
			slot.decode = null;
			nextCommitSeq++;
		} catch (reason) {
			console.error(`[chain] pipeline error:`, reason);
			Deno.kill(Deno.pid);
		}
	}
}