import { ArrayCodec, Codec, StructCodec, VarInt } from "@nomadshiba/codec";
import { LockTimeAndVersionPack } from "~/stored/StoredLockTimeVersionPack.ts";
import { StoredTxInput } from "~/stored/StoredTxInput.ts";
import { StoredTxOutput } from "~/stored/StoredTxOutput.ts";

const Shape = {
	lockTimeAndVersionPack: LockTimeAndVersionPack,
	inputs: new ArrayCodec(StoredTxInput, { counter: VarInt }),
	outputs: new ArrayCodec(StoredTxOutput, { counter: VarInt }),
};

export type StoredTx = Codec.InferOutput<typeof StoredTx>;
export const StoredTx = new StructCodec(Shape);