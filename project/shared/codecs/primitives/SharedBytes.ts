import { Codec, type Stride, VarInt } from "@nomadshiba/codec";

export type BytesOptions =
	| {
		size: number;
		sizer?: undefined;
	}
	| {
		sizer: Codec<number>;
		size?: undefined;
	};

/**
 * Zero-copy variant of `BytesCodec`.
 *
 * Identical to `@nomadshiba/codec`'s `BytesCodec` except that `decoder`
 * returns a **view** into the input buffer (via `subarray`) rather than a
 * **copy** (via `slice`). Use this when the decoded bytes are consumed
 * transiently and the source buffer remains alive for the duration of use,
 * to avoid an extra allocation and copy on every decode.
 *
 * Same two framing modes as `BytesCodec`:
 *
 * - **Fixed** (`O extends { size: number }`) — encodes/decodes exactly
 *   `options.size` bytes with no length prefix.
 * - **Variable** (default / `O` is `undefined` or `{ sizer }`) — prefixes the
 *   payload with its byte-length encoded by `sizer` (defaults to
 *   `VarInt`).
 */
export class SharedBytesCodec<const O extends BytesOptions | undefined = undefined> extends Codec<Uint8Array, Uint8Array> {
	public readonly stride: O extends { size: number } ? Stride<"fixed">
		: Stride<"variable">;

	public readonly sizer: Codec<number>;

	public constructor(options?: O) {
		super();
		this.stride = (options?.size !== undefined ? { kind: "fixed", size: options.size } : { kind: "variable" }) as typeof this.stride;
		this.sizer = options?.sizer ?? VarInt;
	}

	public encoder<TU extends Uint8Array = Uint8Array>(value: Uint8Array, target?: TU, offset?: number): [TU, number] {
		if (this.stride.kind === "fixed") {
			if (value.length !== this.stride.size) {
				throw new RangeError(
					`Expected byte array of length ${this.stride.size}, got ${value.length}`,
				);
			}
			if (target === undefined) {
				const result = new Uint8Array(this.stride.size);
				result.set(value);
				return [result as TU, this.stride.size];
			}
			target.set(value, offset!);
			return [target, this.stride.size];
		}
		if (target === undefined) {
			const prefix = this.sizer.encode(value.length);
			const result = new Uint8Array(prefix.length + value.length);
			result.set(prefix);
			result.set(value, prefix.length);
			return [result as TU, result.length];
		}
		const prefixSize = this.sizer.encodeInto(value.length, target, offset!);
		target.set(value, offset! + prefixSize);
		return [target, prefixSize + value.length];
	}

	public decoder(data: Uint8Array, offset: number): [Uint8Array, number] {
		if (this.stride.kind === "fixed") {
			if (data.length - offset < this.stride.size) {
				throw new RangeError(
					`Expected at least ${this.stride.size} bytes, got ${data.length - offset}`,
				);
			}
			return [data.subarray(offset, offset + this.stride.size), this.stride.size];
		} else {
			const [length, bytesRead] = this.sizer.decode(data, offset);
			const decoded = data.subarray(offset + bytesRead, offset + bytesRead + length);
			return [decoded, bytesRead + length];
		}
	}
}

/**
 * Default variable-length zero-copy bytes codec using `VarInt` as the length
 * prefix sizer.
 */
export const SharedBytes: SharedBytesCodec<undefined> = new SharedBytesCodec();
export type SharedBytes = Codec.InferOutput<typeof SharedBytes>;
