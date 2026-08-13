/**
 * consume.worker — one stage-pair of the pipelined IBD consume path.
 *
 * Long-lived (spawned once, reused). Holds read-only handles to the shared
 * mmap stores so it sees committed data live without any RPC.
 *
 *   decode:  parse the chunk into WireTx objects. This is where the sha256d
 *            txid/wtxid work happens (see WireTx.decoder) — the dominant CPU
 *            cost, and the reason this stage runs in parallel. Touches NO
 *            store, because an earlier chunk may still be uncommitted.
 *
 *   commit:  runs only when every earlier chunk is committed, so every
 *            store's live cursor is authoritative. Resolves prevOuts/pubkeys,
 *            checks double-spends, runs BIP34/BIP30, and writes everything —
 *            tx bytes, txid/pubkey entries, output rows, block records —
 *            straight into the shared mmaps via put()/set()/reveal(). Every
 *            other worker sees each write the instant it lands, so there's no
 *            staging, no cross-worker map, no result payload beyond a count:
 *            this is exactly the old sequential consume loop, just running in
 *            a worker that happens to also decode other chunks in between.
 *
 * The chain worker's only remaining job per chunk is to hand out the
 * exclusive commit turn and, on some cadence, call manifest.pin() — the
 * durable checkpoint used for crash recovery and as the frontend/API read
 * boundary. It has nothing to do with cross-worker visibility.
 */

import { equals } from "@std/bytes";
import type { Codec } from "@nomadshiba/codec";
import { manifest } from "~/chain/manifest.ts";
import { BIP30_EXCEPTION_BLOCKS, isBip30Exception } from "~/chain/bips/bip30.ts";
import { checkBip34CoinbaseHeight } from "~/chain/bips/bip34.ts";
import type { CommittedResult, ConsumeRequest, DecodedResult } from "~/chain/consume.protocol.ts";
import { StoredTx } from "@project/codecs";
import { WireBlockHeader, WireTxs } from "@project/codecs";
import type { WireTx } from "@project/codecs";
import { COINBASE_TXID, MAX_BLOCK_SIZE } from "@project/utils";

const NAME = self.name || "consumer-?";

// ── decoded chunk held between the two stages ────────────────────────────────
// Exactly one chunk in flight per worker, so this is the whole memory bound
// for decoded-but-uncommitted data: N workers => at most N chunks.

type DecodedBlock = { txs: WireTx[]; wireSize: number };

let pendingBlocks: DecodedBlock[] = [];

// ── stage 1: decode (parallel, no store access) ──────────────────────────────

function decode(chunk: Uint8Array): DecodedResult {
	const blocks: DecodedBlock[] = [];
	let txCount = 0;

	let offset = 0;
	while (offset < chunk.length) {
		const [txs, size] = WireTxs.decode(chunk.subarray(offset));
		offset += size;
		blocks.push({ txs, wireSize: size });
		txCount += txs.length;
	}

	pendingBlocks = blocks;
	return { type: "decoded", blockCount: blocks.length, txCount };
}

// ── stage 2: commit (sequential, in chunk order) ─────────────────────────────

function commit(): CommittedResult {
	const blockStore = manifest.stores.block;
	const txStore = manifest.stores.tx;
	const txidStore = manifest.stores.txid;
	const pubkeyStore = manifest.stores.pubkey;
	const outputStore = manifest.stores.output;

	// Every store's cursor is live-shared: reading size() here already
	// reflects every earlier chunk's writes, no matter which worker committed
	// them. No bases need to travel over the wire.
	let txPointer = txStore.size();
	let totalOutput = outputStore.size();
	const blockHeightBase = blockStore.size();

	const blockCount = pendingBlocks.length;

	for (let b = 0; b < blockCount; b++) {
		const { txs, wireSize } = pendingBlocks[b]!;
		const height = blockHeightBase + b;

		// BIP34: from height 227931 the coinbase scriptSig must start with the
		// serialized block height.
		const coinbase = txs[0];
		if (coinbase) checkBip34CoinbaseHeight(height, coinbase.inputs[0]?.scriptSig ?? new Uint8Array(0));

		// BIP30: only ever possible at two known heights, so skip the header
		// hash recompute otherwise, and verify against the stored header hash.
		const bip30Overwrite = BIP30_EXCEPTION_BLOCKS.has(height) &&
			isBip30Exception(height, manifest.stores.header.get(height)?.hash() ?? new Uint8Array(0));

		// Align to a block slot: next() bumps us to the next blob chunk if this
		// one has less than a max block left, so the whole block region lands
		// contiguously in one chunk — no straddle. This is alignment only, NOT
		// a per-block reservation: txs pack tightly and the next block starts
		// right where this one ended.
		txPointer = txStore.next(MAX_BLOCK_SIZE, txPointer);
		const blockRegionEnd = txPointer + MAX_BLOCK_SIZE;
		const blockTxPointer = txPointer;

		for (const tx of txs) {
			const myTotalOutput = totalOutput;

			if (bip30Overwrite && txidStore.getIndex(tx.txId) !== undefined) {
				console.log(`[${NAME}] BIP30 overwrite of duplicate coinbase txid at height ${height}`);
			}

			// Stage the txid entry first — its index is what inputs record as
			// the spender and what outputs record as owner. put() wires it into
			// its bucket immediately, so every worker (including this one, later
			// in this same loop) can already resolve it — appending a fresh
			// entry for a duplicate txid makes it win reads, which is exactly
			// the BIP30 OVERWRITE semantic.
			const myTxidIndex = txidStore.put(tx.txId, { totalOutput: myTotalOutput, txPointer });

			const storedTx: Codec.InferInput<typeof StoredTx> = {
				lockTimeAndVersionPack: { locktime: tx.locktime, version: tx.version },
				inputs: tx.inputs.map((input, index) => {
					const witness = tx.witness[index] ?? [];
					const base = { scriptSig: input.scriptSig, sequence: input.sequence, witness };

					if (equals(input.prevOut.txId, COINBASE_TXID)) {
						return { prevOut: { txId: null, output: input.prevOut.output }, ...base };
					}

					// txidStore already sees every earlier put() — this chunk's
					// own txs included — the instant it runs, so a single lookup
					// resolves both same-chunk and cross-chunk prevOuts alike. No
					// overlay, no cross-worker map.
					const resolved = txidStore.getValueAndIndex(input.prevOut.txId);
					if (resolved === undefined) {
						throw new Error("prevOut references a txid not present in the index");
					}
					const [prevValue, prevEntryIndex] = resolved;
					const prevOutputIndex = prevValue.totalOutput + input.prevOut.output;
					const existing = outputStore.get(prevOutputIndex);
					if (existing.spenderTx !== null) {
						throw new Error(`double spend: output ${prevOutputIndex} already spent`);
					}
					// Mark the spend immediately — visible to everyone right
					// away, same as everything else here. Crash-safety doesn't
					// depend on deferring this: beforeRecovery walks every block
					// from the live (possibly mid-chunk) block cursor down to the
					// last pin and reverts any spend it finds, and block reveal
					// for this tx's block always happens after this line within
					// this same synchronous call — so recovery's range always
					// covers exactly what needs reverting, or none of it once
					// pinned.
					outputStore.set(prevOutputIndex, { ...existing, spenderTx: myTxidIndex });
					return { prevOut: { txId: prevEntryIndex, output: input.prevOut.output }, ...base };
				}),
				outputs: tx.outputs.map((output) => {
					// The pubkey store dedups scripts: each distinct
					// scriptPubKey is stored once and its entry index is the
					// stable reference.
					let index = pubkeyStore.getIndex(output.scriptPubKey);
					if (index === undefined) index = pubkeyStore.put(output.scriptPubKey, myTxidIndex);
					return { value: Number(output.value), scriptPubKey: index };
				}),
			};

			// Encode straight into the blob mmap — one encode, no copy. Ask for
			// what's LEFT of this block's aligned region, not a fresh
			// MAX_BLOCK_SIZE per tx (which would demand room the alignment
			// never promised past the first tx).
			txPointer += StoredTx.encodeInto(storedTx, txStore.mmap(blockRegionEnd - txPointer, txPointer));

			for (let i = 0; i < tx.outputs.length; i++) {
				outputStore.set(totalOutput + i, { ownerTx: myTxidIndex, spenderTx: null, prevSamePubkeyOutputIndex: null });
			}
			totalOutput += tx.outputs.length;
			// Reveal THIS tx's own outputs immediately, not once per block: a
			// later tx — even later in this same block, or the next block in
			// this same chunk — can spend an output this tx just created, and
			// get() bounds-checks against the revealed cursor. Writing ahead of
			// the cursor is fine; reading back before it catches up isn't.
			outputStore.reveal(totalOutput);
		}

		txStore.reveal(txPointer);
		blockStore.stage({ txPointer: blockTxPointer, wireSize: wireSize + WireBlockHeader.stride.size, txCount: txs.length, reward: 123_456_789 }, height);
		blockStore.reveal(height + 1);
	}

	// Release the decoded objects as soon as they're consumed — this is the
	// pipeline's memory high-water mark.
	pendingBlocks = [];

	return { type: "committed", blockCount };
}

// ── message handler ──────────────────────────────────────────────────────────

self.addEventListener("message", (event: MessageEvent<ConsumeRequest>) => {
	const data = event.data;
	try {
		switch (data.type) {
			case "decode": {
				self.postMessage(decode(data.chunk));
				break;
			}
			case "commit": {
				self.postMessage(commit());
				break;
			}
		}
	} catch (error) {
		// Keep this: an uncaught error here is fatal to the chunk and the chain
		// worker only sees a rejected promise, so this is the only place the
		// actual stack trace is visible.
		const err = error as Error;
		console.error(`[${NAME}] ERROR in ${data.type}:`, err?.stack ?? err);
		self.postMessage({ type: "error", phase: data.type, message: String(err?.message ?? err), stack: err?.stack });
	}
});

self.addEventListener("error", (event) => {
	console.error(`[${NAME}] uncaught error:`, (event as ErrorEvent).message);
});

self.postMessage({ type: "ready" });
