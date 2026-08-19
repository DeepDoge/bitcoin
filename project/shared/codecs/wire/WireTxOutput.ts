import { Codec, StructCodec, U64LE } from "@nomadshiba/codec";
import { SharedBytesCodec } from "~/primitives/SharedBytes.ts";
import { CompactSize } from "~/primitives/CompactSize.ts";

export type WireTxOutput = Codec.InferOutput<typeof WireTxOutput>;
export const WireTxOutput = new StructCodec({
	value: U64LE,
	scriptPubKey: new SharedBytesCodec({ sizer: CompactSize }),
});
