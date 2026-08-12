import { Codec } from "@nomadshiba/codec";
import { U40 } from "~/primitives/U40.ts";

export type StoredTxIdIndex = Codec.InferOutput<typeof StoredTxIdIndex>;
export const StoredTxIdIndex = U40;