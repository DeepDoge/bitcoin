import { Codec } from "@nomadshiba/codec";
import { U40 } from "~/primitives/U40.ts";

export type StoredOutputIndex = Codec.InferOutput<typeof StoredOutputIndex>;
export const StoredOutputIndex = U40;