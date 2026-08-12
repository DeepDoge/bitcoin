import { Codec, Stride, U32LE } from "@nomadshiba/codec";

export type LockTime =
	| { kind: "none" }
	| { kind: "block"; height: number }
	| { kind: "time"; timestamp: number };

// Wire-format codec for LockTime
// Encodes as U32LE where:
// - 0 = none
// - < 500_000_000 = block height
// - >= 500_000_000 = timestamp
export class LockTimeCodec extends Codec<LockTime> {
	public readonly stride: Stride<"fixed"> = { kind: "fixed", size: 4 };

	public static toU32(value: LockTime): number {
		switch (value.kind) {
			case "none":
				return 0;
			case "block":
				return value.height;
			case "time":
				return value.timestamp;
		}
	}

	public static fromU32(value: number): LockTime {
		if (value === 0) return { kind: "none" };
		if (value < 500_000_000) return { kind: "block", height: value };
		return { kind: "time", timestamp: value };
	}

	public encoder<TU extends Uint8Array = Uint8Array<ArrayBuffer>>(value: LockTime, target?: TU, offset?: number): [TU, number] {
		const u32 = LockTimeCodec.toU32(value);
		return U32LE.encoder(u32, target, offset);
	}

	public decoder(data: Uint8Array, offset: number): [LockTime, number] {
		const [locktime] = U32LE.decode(data, offset);
		const value = locktime >>> 0;
		return [LockTimeCodec.fromU32(value), 4];
	}
}

export const LockTime = new LockTimeCodec();
