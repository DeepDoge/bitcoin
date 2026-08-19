import { SharedBytesCodec } from "~/primitives/SharedBytes.ts";

export const Bytes32 = new SharedBytesCodec({ size: 32 });
