import { Codec, StructCodec, VarInt } from "@nomadshiba/codec";
import { StoredPubKeyIndex } from "~/stored/StoredPubKeyIndex.ts";

export type StoredTxOutput = Codec.InferOutput<typeof StoredTxOutput>;
export const StoredTxOutput = new StructCodec({
	value: VarInt,
	scriptPubKey: StoredPubKeyIndex,
});
