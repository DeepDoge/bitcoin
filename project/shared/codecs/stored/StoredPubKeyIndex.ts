import { Codec } from "@nomadshiba/codec";
import { U40 } from "~/primitives/U40.ts";

export type StoredPubKeyIndex = Codec.InferOutput<typeof StoredPubKeyIndex>;
export const StoredPubKeyIndex = U40;