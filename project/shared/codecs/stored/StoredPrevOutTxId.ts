import { Codec } from "@nomadshiba/codec";
import { NullableNumaricCodec } from "~/primitives/NullableNumaric.ts";
import { StoredTxIdIndex } from "~/stored/StoredTxIdIndex.ts";

export type StoredPrevOutTxId = Codec.InferOutput<typeof StoredPrevOutTxId>;
export const StoredPrevOutTxId = new NullableNumaricCodec(StoredTxIdIndex);
