import { Codec, Stride } from "@nomadshiba/codec";
import { type PeerMessage } from "~/p2p/Peer.ts";
import { Uint8ArrayView } from "@project/collections";

class PingPongCodec extends Codec<bigint> {
	public readonly stride: Stride<"fixed"> = { kind: "fixed", size: 8 };

	public encoder<TU extends Uint8Array = Uint8Array<ArrayBuffer>>(nonce: bigint, target?: TU, offset?: number): [TU, number] {
		if (target === undefined) {
			const buf = new Uint8Array(8);
			new Uint8ArrayView(buf).setBigUint64(0, nonce, true);
			return [buf as TU, 8];
		}
		new DataView(target.buffer, target.byteOffset + offset!).setBigUint64(0, nonce, true);
		return [target, 8];
	}

	public decoder(bytes: Uint8Array, offset: number): [bigint, number] {
		return [new Uint8ArrayView(bytes, offset).getBigUint64(0, true), 8];
	}
}

const codec = new PingPongCodec();

export const PingMessage: PeerMessage<PingPongCodec> = { command: "ping", codec };
export const PongMessage: PeerMessage<PingPongCodec> = { command: "pong", codec };
