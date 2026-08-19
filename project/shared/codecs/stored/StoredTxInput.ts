import { Codec, Stride, StructCodec, U32, VarInt } from "@nomadshiba/codec";
import { SharedBytes, SharedBytesCodec } from "~/primitives/SharedBytes.ts";
import { SequenceLock, SequenceLockCodec } from "~/SequenceLock.ts";
import { StoredPrevOutTxId } from "~/stored/StoredPrevOutTxId.ts";
import { StoredWitness } from "~/stored/StoredWitness.ts";
import { COINBASE_VOUT } from "@project/utils";

type T = StructCodec<{
	prevOut: StructCodec<{
		txId: typeof StoredPrevOutTxId;
		output: typeof VarInt;
	}>;
	scriptSig: typeof SharedBytes;
	sequence: typeof SequenceLock;
	witness: typeof StoredWitness;
}>;

type Input = Codec.InferInput<T>;
type Output = Codec.InferOutput<T>;

/**
 * StoredTxInput binary layout
 *
 * -- prevOut txId (ALWAYS FIRST, fixed 6-byte u48 slot) --
 *   StoredPrevOutTxId encoding. Sits at the very start of the input, so an
 *   input's patch offset is simply the input's own offset.
 *
 * -- vout (conditional) --
 *   VarInt, present ONLY when the txId slot decodes to a pointer.
 *   Coinbase stores no vout (implied COINBASE_VOUT).
 *
 * -- 1-byte tag --
 * bits 0-1 : sequence tag    0=0xFFFFFFFF, 1=0xFFFFFFFE, 2=0xFFFFFFFD (RBF),
 *                            3=explicit u32 follows
 * bits 2-7 : spare
 *
 * -- sequence (conditional) --
 *   present ONLY when sequence tag is 3 (explicit): 4-byte u32.
 *   The three common constants are encoded in the tag and store 0 bytes here.
 *
 * -- scriptSig (variable) --
 *   length-prefixed bytes
 *
 * -- witness (variable, LAST) --
 *   StoredWitness encoding
 */

// Use SharedBytesCodec for scriptSig length prefix (zero-copy decode)
const scriptSigCodec = new SharedBytesCodec();

// --- Tag byte layout ---
// bits 0-1: sequence tag   0=0xFFFFFFFF, 1=0xFFFFFFFE, 2=0xFFFFFFFD, 3=explicit u32 follows
// bits 2-7: spare
const SEQ_SHIFT = 0;
const SEQ_MASK = 0b0000_0011;

const SEQ_FINAL = 0; // 0xFFFFFFFF
const SEQ_FE = 1; // 0xFFFFFFFE
const SEQ_FD = 2; // 0xFFFFFFFD (RBF)
const SEQ_EXPLICIT = 3;

const SEQ_VALUE_FINAL = 0xffffffff;
const SEQ_VALUE_FE = 0xfffffffe;
const SEQ_VALUE_FD = 0xfffffffd;

function sequenceTagForU32(seq: number): number {
	switch (seq >>> 0) {
		case SEQ_VALUE_FINAL:
			return SEQ_FINAL;
		case SEQ_VALUE_FE:
			return SEQ_FE;
		case SEQ_VALUE_FD:
			return SEQ_FD;
		default:
			return SEQ_EXPLICIT;
	}
}

function sequenceU32ForTag(tag: number): number | null {
	switch (tag) {
		case SEQ_FINAL:
			return SEQ_VALUE_FINAL;
		case SEQ_FE:
			return SEQ_VALUE_FE;
		case SEQ_FD:
			return SEQ_VALUE_FD;
		default:
			return null; // explicit: read 4 bytes
	}
}

// StoredTxInput codec that decodes to plain TxInput data
export class StoredTxInputCodec extends Codec<Output, Input> {
	public readonly stride: Stride<"variable"> = { kind: "variable" };

	public encoder<TU extends Uint8Array = Uint8Array<ArrayBuffer>>(input: Input, target?: TU, offset?: number): [TU, number] {
		const seqU32 = SequenceLockCodec.toU32(input.sequence) >>> 0;
		const seqTag = sequenceTagForU32(seqU32);
		const seqExplicit = seqTag === SEQ_EXPLICIT;

		if (target === undefined) {
			// No target: sizes must be known upfront for a single allocation, so
			// scriptSig/witness have to be pre-encoded here to measure them.
			const scriptSigEncoded = scriptSigCodec.encode(input.scriptSig);
			const witnessEncoded = StoredWitness.encode(input.witness);
			const outputSize = input.prevOut.txId === null ? 0 : VarInt.encode(input.prevOut.output).length;

			const totalLength = StoredPrevOutTxId.stride.size + outputSize + 1 + (seqExplicit ? 4 : 0) +
				scriptSigEncoded.length + witnessEncoded.length;
			const result = new Uint8Array(totalLength);
			this.writeIntoPrecomputed(input, result, 0, seqU32, seqTag, seqExplicit, scriptSigEncoded, witnessEncoded);
			return [result as TU, result.length];
		}

		// Target provided: write every field straight into it via encodeInto —
		// no throwaway scriptSig/witness buffers, no copy.
		return [target, this.writeInto(input, target, offset!, seqU32, seqTag, seqExplicit)];
	}

	private writeInto(
		input: Input,
		target: Uint8Array,
		offset: number,
		seqU32: number,
		seqTag: number,
		seqExplicit: boolean,
	): number {
		const start = offset;

		offset += StoredPrevOutTxId.encodeInto(input.prevOut.txId, target, offset);
		if (input.prevOut.txId !== null) {
			offset += VarInt.encodeInto(input.prevOut.output, target, offset);
		}

		const tagByte = (seqTag << SEQ_SHIFT) & SEQ_MASK;
		target[offset++] = tagByte;

		if (seqExplicit) {
			offset += U32.encodeInto(seqU32, target, offset);
		}

		offset += scriptSigCodec.encodeInto(input.scriptSig, target, offset);
		offset += StoredWitness.encodeInto(input.witness, target, offset);

		return offset - start;
	}

	private writeIntoPrecomputed(
		input: Input,
		target: Uint8Array,
		offset: number,
		seqU32: number,
		seqTag: number,
		seqExplicit: boolean,
		scriptSigEncoded: Uint8Array<ArrayBuffer>,
		witnessEncoded: Uint8Array<ArrayBuffer>,
	): number {
		const start = offset;

		offset += StoredPrevOutTxId.encodeInto(input.prevOut.txId, target, offset);
		if (input.prevOut.txId !== null) {
			offset += VarInt.encodeInto(input.prevOut.output, target, offset);
		}

		const tagByte = (seqTag << SEQ_SHIFT) & SEQ_MASK;
		target[offset++] = tagByte;

		if (seqExplicit) {
			offset += U32.encodeInto(seqU32, target, offset);
		}

		target.set(scriptSigEncoded, offset);
		offset += scriptSigEncoded.length;

		target.set(witnessEncoded, offset);
		offset += witnessEncoded.length;

		return offset - start;
	}

	public decoder(data: Uint8Array, offset: number): [Output, number] {
		let currentOffset = offset;

		const [txId, txIdBytes] = StoredPrevOutTxId.decode(data, currentOffset);
		currentOffset += txIdBytes;

		let output: number;
		if (txId !== null) {
			let outputSize: number;
			[output, outputSize] = VarInt.decode(data, currentOffset);
			currentOffset += outputSize;
		} else {
			output = COINBASE_VOUT;
		}

		const tagByte = data[currentOffset]!;
		currentOffset += 1;

		const seqTag = (tagByte & SEQ_MASK) >>> SEQ_SHIFT;

		let seqU32 = sequenceU32ForTag(seqTag);
		if (seqU32 === null) {
			seqU32 = U32.decode(data, currentOffset)[0] >>> 0;
			currentOffset += 4;
		}

		const [scriptSig, scriptSigBytes] = scriptSigCodec.decode(data, currentOffset);
		currentOffset += scriptSigBytes;

		const [witness, witnessBytes] = StoredWitness.decode(data, currentOffset);
		currentOffset += witnessBytes;

		const input: Output = {
			prevOut: { txId, output: output },
			sequence: SequenceLockCodec.fromU32(seqU32),
			scriptSig,
			witness,
		};

		return [input, currentOffset - offset];
	}
}

export type StoredTxInput = Codec.InferOutput<typeof StoredTxInput>;
export const StoredTxInput = new StoredTxInputCodec();
