import { ArrayCodec, Codec } from "@nomadshiba/codec";
import { decodeHex } from "@std/encoding";
import { RouterSchema } from "~/libs/routing/Router.ts";
import { endpointRouter } from "~/router.ts";
import { Block, Schema, TxSummary } from "~/routes.ts";
import { manifest } from "~/chain/manifest.ts";
import { StoredPubKey, StoredTx, WireTxInput, WireTxOutput } from "@project/codecs";
import { WireTx } from "@project/codecs";
import { sha256d } from "@project/hashes";

const MAX_BLOCK_TAKE = 210;
const MAX_TX_TAKE = 50;

function parseHashOrHeight(raw: string): { kind: "height"; height: number } | { kind: "hash"; hash: Uint8Array } {
	if (raw.length === 64) {
		return { kind: "hash", hash: decodeHex(raw).reverse() };
	}
	return { kind: "height", height: Number(raw) };
}

function resolveHeight(raw: string): number | undefined {
	const parsed = parseHashOrHeight(raw);
	if (parsed.kind === "height") return Number.isInteger(parsed.height) ? parsed.height : undefined;
	return manifest.stores.headerhash.get(parsed.hash);
}

// header.prevHash/merkleRoot alias the header store's mmap too (same reason
// as toWireTx below) — copy them at the boundary before a header escapes
// into an API response. Spread preserves the lazily-computed hash() method.
function cloneHeader<H extends { prevHash: Uint8Array; merkleRoot: Uint8Array }>(header: H): H {
	return { ...header, prevHash: header.prevHash.slice(), merkleRoot: header.merkleRoot.slice() };
}

function toWireTx(storedTx: StoredTx): Codec.InferInput<typeof WireTx> {
	const { version, locktime } = storedTx.lockTimeAndVersionPack;

	let anyWitness = false;
	for (const input of storedTx.inputs) {
		if (input.witness.kind !== "none") {
			anyWitness = true;
			break;
		}
	}

	// getPrevOutTxId/scriptSig/witness alias the underlying store's mmap
	// (SharedBytesCodec decodes are zero-copy views, not owned buffers). This
	// function's result escapes into an API response, so we copy those three
	// fields out here, at the boundary, instead of trusting every future
	// caller to know they're aliased. scriptPubKey needs no copy: toRaw()
	// always allocates a fresh buffer.
	const inputs: Codec.InferInput<typeof WireTxInput>[] = storedTx.inputs.map((input) => ({
		prevOut: { txId: manifest.stores.chain.getPrevOutTxId(input).slice(), output: input.prevOut.output },
		scriptSig: input.scriptSig.slice(),
		sequence: input.sequence,
	}));

	const outputs: Codec.InferInput<typeof WireTxOutput>[] = storedTx.outputs.map((output) => {
		const scriptPubKey = manifest.stores.chain.getPubkeyAtIndex(output.scriptPubKey);
		const value = BigInt(output.value);
		return { value, scriptPubKey: StoredPubKey.toRaw(scriptPubKey) };
	});

	const witness: Uint8Array[][] = anyWitness ? storedTx.inputs.map((input) => input.witness.raw().map((item) => item.slice())) : [];

	return { version, locktime, inputs, outputs, witness };
}

async function getBlockByHeight(height: number): Promise<RouterSchema.InferResultInput<Schema, "GET /v1/block/:hashOrHeight">> {
	const rawHeader = await manifest.stores.header.getAsync(height);
	if (!rawHeader) return null;
	const header = cloneHeader(rawHeader);
	const block = await manifest.stores.chain.block.getAsync(height);
	if (!block) return { header, height, info: null };
	const [coinbaseTx] = await manifest.stores.chain.tx.getAsync(block.txPointer, StoredTx);
	const coinbaseInput = coinbaseTx.inputs[0];
	if (!coinbaseInput) return { header, height, info: null };
	return {
		header,
		height,
		info: {
			wireSize: block.wireSize,
			fees: block.fees,
			txCount: block.txCount,
			// alias of the tx BlobStore's mmap — copy at the boundary, see toWireTx.
			coinbaseScriptSig: coinbaseInput.scriptSig.slice(),
		},
	};
}

async function getHeaderByRangeAsync(from: number, to: number): Promise<Block[]> {
	const [headers, blocks] = await Promise.all([
		manifest.stores.header.sliceAsync(from, to + 1),
		manifest.stores.chain.block.sliceAsync(from, to + 1),
	]);
	return await Promise.all(headers.map(async (rawHeader, index): Promise<Block> => {
		const header = cloneHeader(rawHeader);
		const height = from + index;
		const block = blocks[index];
		if (!block) return { header, height, info: null };
		const [coinbaseTx] = await manifest.stores.chain.tx.getAsync(block.txPointer, StoredTx);
		const coinbaseInput = coinbaseTx.inputs[0];
		if (!coinbaseInput) return { header, height, info: null };
		return {
			header,
			height,
			info: {
				wireSize: block.wireSize,
				fees: block.fees,
				txCount: block.txCount,
				// alias of the tx BlobStore's mmap — copy at the boundary, see toWireTx.
				coinbaseScriptSig: coinbaseInput.scriptSig.slice(),
			},
		};
	}));
}

endpointRouter.registerHandler("GET /v1/block?from=:from&take=:take", async ({ params }) => {
	const from = Math.max(0, Number(params.search.from));
	if (isNaN(from)) {
		return { status: "BadRequest", message: "Invalid 'from' parameter" };
	}
	const take = Math.min(MAX_BLOCK_TAKE, Number(params.search.take));
	if (isNaN(take)) {
		return { status: "BadRequest", message: "Invalid 'take' parameter" };
	}
	return { status: "OK", data: await getHeaderByRangeAsync(from, from + take - 1) };
});

endpointRouter.registerHandler("GET /v1/block?to=:to&take=:take", async ({ params }) => {
	const to = Math.max(0, Number(params.search.to));
	if (isNaN(to)) {
		return { status: "BadRequest", message: "Invalid 'to' parameter" };
	}
	const take = Math.min(MAX_BLOCK_TAKE, Number(params.search.take));
	if (isNaN(take)) {
		return { status: "BadRequest", message: "Invalid 'take' parameter" };
	}
	return { status: "OK", data: await getHeaderByRangeAsync(Math.max(0, to - take + 1), to) };
});

endpointRouter.registerHandler("GET /v1/block/tip", async () => {
	const height = manifest.stores.header.size() - 1;
	if (height < 0) throw new Error("not suppose to happen");
	return { status: "OK", data: await getBlockByHeight(height) };
});

endpointRouter.registerHandler("GET /v1/block/:hashOrHeight", async ({ params }) => {
	const height = resolveHeight(params.pathname.hashOrHeight);
	if (height === undefined) return { status: "OK", data: null };
	return { status: "OK", data: await getBlockByHeight(height) };
});

endpointRouter.registerHandler("GET /v1/block/:hashOrHeight/txs", async ({ params }) => {
	const height = resolveHeight(params.pathname.hashOrHeight);
	if (height === undefined) return { status: "OK", data: [] };
	const block = await manifest.stores.chain.block.getAsync(height);
	if (block === undefined) return { status: "OK", data: [] };
	const [txs] = await manifest.stores.chain.tx.getAsync(block.txPointer, new ArrayCodec(StoredTx, { size: block.txCount }));

	const fromRaw = params.search && "from" in params.search ? Number(params.search["from"]) : 0;
	const takeRaw = params.search && "take" in params.search ? Number(params.search["take"]) : MAX_TX_TAKE;
	const from = Number.isFinite(fromRaw) ? Math.max(0, Math.trunc(fromRaw)) : 0;
	const take = Number.isFinite(takeRaw) && takeRaw > 0 ? Math.min(MAX_TX_TAKE, Math.trunc(takeRaw)) : MAX_TX_TAKE;

	// TODO: this can be better probably? instead of making it from, to based we can make it cursor based. like get next.
	// so we dont have to read everything from the store.
	const slice = txs.slice(from, from + take);
	return {
		status: "OK",
		data: slice.map((tx): TxSummary => {
			const wireTx = toWireTx(tx);
			const encodedWire = WireTx.encode(wireTx); // TODO: we shouldnt need this for txId
			return {
				txId: sha256d(encodedWire) as Uint8Array<ArrayBuffer>, // TODO: we shouldnt have to cast this.
				inputs: tx.inputs.length,
				outputs: tx.outputs.length,
				wireSize: encodedWire.length,
			};
		}),
	};
});

endpointRouter.registerHandler("GET /v1/tx/:txId", async ({ params }) => {
	const txId = Uint8Array.from(decodeHex(params.pathname.txId).reverse());
	const txInfo = manifest.stores.chain.txid.get(txId);
	if (txInfo === undefined) return { status: "OK", data: null };
	const [tx] = await manifest.stores.chain.tx.getAsync(txInfo.txPointer, StoredTx);
	return { status: "OK", data: toWireTx(tx) };
});
