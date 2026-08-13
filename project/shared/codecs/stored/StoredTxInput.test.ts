import { assertEquals } from "@std/assert";
import { Codec } from "@nomadshiba/codec";
import { StoredTxInput } from "~/stored/StoredTxInput.ts";

type Input = Codec.InferInput<typeof StoredTxInput>;

const cases: Input[] = [
	{
		prevOut: { txId: 1234, output: 0 },
		scriptSig: new Uint8Array([1, 2, 3, 4, 5]),
		sequence: { kind: "final" },
		witness: [],
	},
	{
		prevOut: { txId: null, output: 0 },
		scriptSig: new Uint8Array(0),
		sequence: { kind: "final" },
		witness: [],
	},
	{
		prevOut: { txId: 99, output: 3 },
		scriptSig: new Uint8Array(0),
		sequence: { kind: "enable", relativeLock: { kind: "block", blocks: 10 }, unused: 0 },
		witness: [new Uint8Array(72).fill(9), new Uint8Array(33).fill(3)], // p2wpkh-shaped
	},
];

Deno.test("StoredTxInput: target-provided encodeInto is byte-identical to the allocating encode", () => {
	for (const input of cases) {
		const allocated = StoredTxInput.encode(input);

		const scratch = new Uint8Array(4096);
		const written = StoredTxInput.encodeInto(input, scratch, 10); // non-zero offset on purpose
		const inPlace = scratch.subarray(10, 10 + written);

		assertEquals(written, allocated.length);
		assertEquals(inPlace, allocated);

		const [decoded] = StoredTxInput.decode(inPlace);
		assertEquals(decoded.prevOut.txId, input.prevOut.txId);
		assertEquals(decoded.scriptSig, input.scriptSig);
	}
});
