import { Codec } from "@nomadshiba/codec";
import { U40 } from "~/primitives/U40.ts";

export type StoredHeaderHashPointer = Codec.InferOutput<typeof StoredHeaderHashPointer>;
export const StoredHeaderHashPointer = U40;