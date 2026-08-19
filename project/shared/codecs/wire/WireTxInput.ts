import { Codec, StructCodec, U32LE } from "@nomadshiba/codec";
import { SharedBytesCodec } from "~/primitives/SharedBytes.ts";
import { Bytes32 } from "~/primitives/Bytes32.ts";
import { CompactSize } from "~/primitives/CompactSize.ts";
import { SequenceLock } from "~/SequenceLock.ts";

// Wire format TxInput - EXACTLY what's on the wire
// - prevOut: { txId (32 bytes), vout (4 bytes) }
// - scriptSig: CompactSize + bytes
// - sequence: 4 bytes
// NO witness - witness is at transaction level

export type WireTxInput = Codec.InferOutput<typeof WireTxInput>;
export const WireTxInput = new StructCodec({
	prevOut: new StructCodec({
		txId: Bytes32,
		output: U32LE,
	}),
	scriptSig: new SharedBytesCodec({ sizer: CompactSize }),
	sequence: SequenceLock,
});
