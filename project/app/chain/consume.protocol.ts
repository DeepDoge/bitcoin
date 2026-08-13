/**
 * consume.protocol — chain ↔ consumer-worker message protocol.
 *
 * Two stages, pipelined:
 *
 *   decode (PARALLEL): pure function of the chunk's own bytes. Parses
 *     WireTxs — which eagerly computes txId/wtxId (sha256d per tx, twice for
 *     segwit), the dominant CPU cost of the whole consume path. Touches NO
 *     store: a worker may be decoding chunk N+2 while chunk N is still
 *     uncommitted, so any store read here could be stale.
 *
 *   commit (SEQUENTIAL, strictly in chunk order): every earlier chunk is
 *     already committed, so every store's live, shared cursor already
 *     reflects it — no bases need to travel over the wire. Resolves
 *     prevOuts/pubkeys, runs BIP checks, and writes everything (tx bytes,
 *     txid/pubkey entries, output rows, block records) straight into the
 *     shared mmaps, visible to every other worker the instant each write
 *     lands — no scratch buffer, no placeholders, no patching, exactly like
 *     the old sequential path.
 *
 * Because every store is live-shared, there is no cross-worker negotiation at
 * all: no shared txid map, no pubkey dedup table, no deferred refs, no sizes
 * to report back. The wire protocol carries just enough for the chain worker
 * to log throughput.
 */

// ── chain → worker ──────────────────────────────────────────────────────────

export type DecodeRequest = {
	type: "decode";
	/** Raw WireTxs back to back. */
	chunk: Uint8Array;
};

export type CommitRequest = { type: "commit" };

export type ConsumeRequest = DecodeRequest | CommitRequest;

// ── worker → chain ──────────────────────────────────────────────────────────

export type DecodedResult = {
	type: "decoded";
	blockCount: number;
	txCount: number;
};

export type CommittedResult = {
	type: "committed";
	blockCount: number;
};

export type ConsumeResult = DecodedResult | CommittedResult;

export type ReadyMessage = { type: "ready" };
export type ErrorMessage = { type: "error"; phase: string; message: string; stack?: string };
export type WorkerMessage = ReadyMessage | ErrorMessage | ConsumeResult;
