import { ArrayCodec, Codec } from "@nomadshiba/codec";
import { WireTx } from "~/wire/WireTx.ts";
import { CompactSize } from "~/primitives/CompactSize.ts";

export type WireTxs = Codec.InferOutput<typeof WireTxs>;
export const WireTxs = new ArrayCodec(WireTx, { counter: CompactSize });
