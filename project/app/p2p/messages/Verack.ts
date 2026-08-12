import { Codec, Stride } from "@nomadshiba/codec";
import { type PeerMessage } from "~/p2p/Peer.ts";

class VerackCodec extends Codec<null> {
	public readonly stride: Stride<"fixed"> = { kind: "fixed", size: 0 };

	public encoder<TU extends Uint8Array = Uint8Array<ArrayBuffer>>(_data: null, target?: TU, _offset?: number): [TU, number] {
		if (target === undefined) return [new Uint8Array(0) as TU, 0];
		return [target, 0];
	}

	public decoder(_bytes: Uint8Array, _offset: number): [null, number] {
		return [null, 0];
	}
}

export const VerackMessage: PeerMessage<VerackCodec> = {
	command: "verack",
	codec: new VerackCodec(),
};
