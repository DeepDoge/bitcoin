import { equals } from "@std/bytes";
import { GENESIS_BLOCK_HASH, GENESIS_BLOCK_HEADER_DECODED } from "~/chain/genesis.ts";
import { manifest } from "~/chain/manifest.ts";

import { verifyProofOfWork, workFromHeader } from "@project/bitcoin";
import { StoredTx, StoredTxInput, StoredTxOutput, WireBlockHeader, WireBlockHeaders, WireTxs } from "@project/codecs";
import { Codec } from "@nomadshiba/codec";
import { Queue } from "@project/collections";
import { blockSubsidy, COINBASE_VOUT, MAX_BLOCK_SIZE, SECOND } from "@project/utils";
import { delay } from "@std/async/delay";

console.log("[chain] booting");

type P2PMessage = { type: "blocks"; data: Uint8Array } | { type: "headers"; data: Uint8Array };

const p2pMessageQueue = new Queue<P2PMessage>(1000);

function tipHeight(): number {
	return manifest.stores.header.size() - 1;
}

function headerHashAt(height: number): Uint8Array | undefined {
	return manifest.stores.header.get(height)?.hash();
}

export type ChainWorkerResult = { adopted: number; rewind?: number };

function handleHeaders(headers: WireBlockHeader[]): ChainWorkerResult {
	const head = headers[0];
	if (!head) return { adopted: 0 };

	const tipHeightValue = tipHeight();
	const tip = tipHeightValue < 0 ? undefined : headerHashAt(tipHeightValue);
	if (tip === undefined) return { adopted: 0 };

	let splitHeight: number;
	if (equals(head.prevHash, tip)) {
		splitHeight = tipHeightValue;
	} else {
		const forked = manifest.stores.headerhash.get(head.prevHash);
		if (forked === undefined) return { adopted: 0 };
		const at = headerHashAt(forked);
		if (!(at && equals(at, head.prevHash))) return { adopted: 0 };
		splitHeight = forked;
	}

	const branch: WireBlockHeader[] = [];
	let prevHash = headerHashAt(splitHeight);
	if (!prevHash) return { adopted: 0 };
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
	for (let height = splitHeight + 1; height <= currentTip; height++) {
		const header = manifest.stores.header.get(height);
		if (header) ourWork += workFromHeader(header);
	}

	const isReorg = splitHeight < currentTip;
	if (isReorg && branchWork <= ourWork) return { adopted: 0 };

	let rewind: number | undefined;
	if (isReorg) {
		console.log(`[chain] header reorg: dropping height ${tipHeight()} -> ${splitHeight}, applying ${branch.length} headers`);
		manifest.stores.header.truncate(splitHeight + 1);

		if (splitHeight < manifest.stores.chain.block.size() - 1) {
			throw new Error(
				`header reorg to ${splitHeight} is below committed block tip ${manifest.stores.chain.block.size() - 1}; ` +
					`block-domain rewind is not implemented`,
			);
		}

		rewind = splitHeight;
	}

	for (const header of branch) {
		const height = manifest.stores.header.size();
		manifest.stores.header.item.encodeInto(header, manifest.stores.header.mmap(height));
		manifest.stores.header.reveal(height + 1);
		manifest.stores.headerhash.put(header.hash(), height);
	}
	manifest.pin();
	return { adopted: branch.length, rewind };
}

// ── single-pass inline block consumption ─────────────────────────────────────
// No consume workers, no pipeline workers, no staging buffers. The chain thread
// decodes wire blocks directly into storage in one pass, exactly like the old
// single-worker version. The serial txid gate makes parallelism pointless —
// 16 cores don't help when all work funnels through one serial writer. This
// eliminates the double-decode + IPC + allocation overhead that was making the
// multi-worker architecture 2-3x slower than the old single-threaded version.

let port: MessagePort;
let nextTxPointer = 0;
let nextOutputCount = 0;

const RATE_REPORT_INTERVAL_MS = 2_000;
const bootAt = performance.now();
let totalBlocks = 0;
let windowBlocks = 0;
let lastReportAt = bootAt;
let lastPinTime = 0;

function recordBlocks(n: number, tipHeight: number): void {
	totalBlocks += n;
	windowBlocks += n;
	const now = performance.now();
	const windowMs = now - lastReportAt;
	if (windowMs < RATE_REPORT_INTERVAL_MS) return;
	const windowRate = windowBlocks / (windowMs / 1000);
	const avgRate = totalBlocks / ((now - bootAt) / 1000);
	console.log(`[chain] ${windowRate.toFixed(0)} blocks/s (avg ${avgRate.toFixed(0)}/s) height=${tipHeight} total=${totalBlocks}`);
	windowBlocks = 0;
	lastReportAt = now;
}

function consumeChunk(chunk: Uint8Array): void {
	const chain = manifest.stores.chain;
	let txPointer = nextTxPointer;
	let totalOutput = nextOutputCount;
	let blocksInChunk = 0;
	let offset = 0;

	while (offset < chunk.length) {
		const [block, size] = WireTxs.decode(chunk, offset);
		offset += size;
		blocksInChunk++;

		txPointer = chain.tx.next(MAX_BLOCK_SIZE, txPointer);
		const blockRegionEnd = txPointer + MAX_BLOCK_SIZE;
		const height = chain.block.size();

		// fees = coinbase outputs - block subsidy (some early miners didn't claim the full subsidy)
		const coinbase = block[0];
		let coinbaseValue = 0n;
		if (coinbase) {
			for (const out of coinbase.outputs) coinbaseValue += out.value;
		}
		const fees = Math.max(0, Number(coinbaseValue - blockSubsidy(height)));

		// Write block record
		chain.block.item.encodeInto(
			{ wireSize: size + WireBlockHeader.stride.size, txPointer, txCount: block.length, fees } satisfies Codec.InferInput<
				typeof chain.block.item
			>,
			chain.block.mmap(height),
		);
		chain.block.reveal(height + 1);

		for (const [txIndex, tx] of block.entries()) {
			const totalOutputBase = totalOutput;

			// txid: put entry (write + link + reveal in one call)
			const txIdIndex = chain.txid.put(tx.txId, { txPointer, totalOutput: totalOutputBase });

			// Encode tx directly into tx.mmap
			const storedTx: Codec.InferInput<typeof StoredTx> = {
				lockTimeAndVersionPack: { locktime: tx.locktime, version: tx.version },
				inputs: tx.inputs.map((input, i): Codec.InferInput<typeof StoredTxInput> => {
					const isCoinbase = txIndex === 0 && i === 0;
					if (isCoinbase) {
						return {
							prevOut: { txId: null, output: COINBASE_VOUT },
							scriptSig: input.scriptSig,
							sequence: input.sequence,
							witness: tx.witness[i] ?? [],
						};
					}
					// Resolve prevout immediately from txid index
					const resolved = chain.txid.getIndex(input.prevOut.txId);
					if (resolved === undefined) {
						throw new Error("prevOut references a txid not present in the index");
					}
					const [, spentTxInfo] = chain.txid.getEntryAtIndex(resolved);
					const prevOutputIndex = spentTxInfo.totalOutput + input.prevOut.output;
					// Check against totalOutput (includes outputs created earlier
					// in this chunk) not spender.size() (which only grows at chunk
					// end). Same-chunk spends do happen on mainnet.
					if (prevOutputIndex < totalOutput) {
						if (chain.spender.get(prevOutputIndex) === null) {
							chain.spender.set(prevOutputIndex, txIdIndex);
						}
					}
					return {
						prevOut: { txId: resolved, output: input.prevOut.output },
						scriptSig: input.scriptSig,
						sequence: input.sequence,
						witness: tx.witness[i] ?? [],
					};
				}),
				outputs: tx.outputs.map((output): Codec.InferInput<typeof StoredTxOutput> => {
					const existing = chain.getPubkeyIndex(output.scriptPubKey);
					const pubkeyIndex = existing ?? chain.putPubkey(output.scriptPubKey);
					return { value: Number(output.value), scriptPubKey: pubkeyIndex };
				}),
			};

			// Write outputs
			for (let i = 0; i < tx.outputs.length; i++) {
				const pubkeyIndex = storedTx.outputs[i]!.scriptPubKey;
				const absoluteIndex = totalOutput + i;
				const prevSame = chain.getPubkeyLastOutput(pubkeyIndex);
				chain.output.item.encodeInto(
					{ ownerTx: txIdIndex, prevSamePubkeyOutputIndex: prevSame } satisfies Codec.InferInput<typeof chain.output.item>,
					chain.output.mmap(absoluteIndex),
				);
				chain.setPubkeyLastOutput(pubkeyIndex, absoluteIndex);
			}

			totalOutput += tx.outputs.length;
			// Eagerly grow spender so same-chunk spends can mark it
			chain.spender.resize(totalOutput);
			txPointer += StoredTx.encodeInto(storedTx, chain.tx.mmap(blockRegionEnd - txPointer, txPointer));
		}
	}

	// Reveal tx blob + output array
	chain.tx.reveal(txPointer);
	chain.output.reveal(totalOutput);

	// Update running cursors
	nextTxPointer = chain.tx.next(MAX_BLOCK_SIZE, txPointer);
	nextOutputCount = totalOutput;

	// Batched pin
	if (Date.now() - lastPinTime >= 5 * SECOND) {
		manifest.pin();
		lastPinTime = Date.now();
	}

	recordBlocks(blocksInChunk, chain.block.size() - 1);
}

self.onmessage = async (event) => {
	console.log("[chain] main-port message event, ports:", event.ports.length, "data:", event.data);
	port = event.ports[0]!;
	if (!port) throw new Error("[chain] main-port message arrived without a MessagePort");

	port.addEventListener("message", (e) => p2pMessageQueue.enqueue(e.data));
	port.start();
	{
		const target = manifest.stores.chain.block.size() - 1;
		console.log(`[chain] sync port received, blocks committed up to height ${target}, requesting from p2p`);
		port.postMessage({ type: "seek", data: target });
		port.postMessage({ type: "start" });
	}

	if (manifest.stores.header.size() === 0) {
		const height = manifest.stores.header.size();
		manifest.stores.header.item.encodeInto(GENESIS_BLOCK_HEADER_DECODED, manifest.stores.header.mmap(height));
		manifest.stores.header.reveal(height + 1);
		manifest.stores.headerhash.put(GENESIS_BLOCK_HASH, height);
		manifest.pin();
		console.log("[chain] seeded genesis header");
	}

	nextTxPointer = manifest.stores.chain.tx.size();
	nextOutputCount = manifest.stores.chain.output.size();
	lastPinTime = Date.now();
	lastReportAt = performance.now();

	while (true) {
		try {
			const message = p2pMessageQueue.peek();
			if (!message) {
				await delay(0);
				continue;
			}
			switch (message.type) {
				case "blocks": {
					p2pMessageQueue.dequeue();
					consumeChunk(message.data);
					port.postMessage({ type: "blocks" });
					break;
				}
				case "headers": {
					p2pMessageQueue.dequeue();
					const [headers] = WireBlockHeaders.decode(message.data);
					try {
						port.postMessage({ type: "headers", data: handleHeaders(headers) });
					} catch (reason) {
						console.error("[chain] applyHeaders failed:", reason);
						Deno.kill(Deno.pid);
					}
					break;
				}
			}
		} catch (reason) {
			console.error(`[chain] consume loop error:`, reason);
			Deno.kill(Deno.pid);
		}
	}
};
self.onunhandledrejection = (event) => console.error("[chain] unhandledrejection:", event.reason);
self.postMessage(null);
