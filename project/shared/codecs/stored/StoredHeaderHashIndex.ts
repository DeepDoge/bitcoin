import { Codec } from "@nomadshiba/codec";
import { U40 } from "~/primitives/U40.ts";

export type StoredHeaderHashIndex = Codec.InferOutput<typeof StoredHeaderHashIndex>;
export const StoredHeaderHashIndex = U40;