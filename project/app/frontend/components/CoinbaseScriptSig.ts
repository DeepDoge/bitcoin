import { tags } from "@purifyjs/core";
import { useClassToggle } from "~/frontend/utils/dom/bind.ts";
import { css } from "~/frontend/utils/dom/css.ts";

export function CoinbaseScriptSig(bytes: Uint8Array) {
	const { code, span } = tags;
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const parts: { bytes: number[]; readable: boolean }[] = [];

	for (const b of bytes) {
		const readable = b >= 0x20 && b <= 0x7e;
		const last = parts[parts.length - 1];
		if (last && last.readable === readable) {
			last.bytes.push(b);
		} else {
			parts.push({ bytes: [b], readable });
		}
	}

	return code().$bind(CoinbaseScriptSigStyle.useScope()).append$(
		parts.map((part) =>
			span()
				.$bind(useClassToggle({ readable: part.readable }))
				.textContent(decoder.decode(new Uint8Array(part.bytes)))
		),
	);
}

const CoinbaseScriptSigStyle = css`
	:scope {
		white-space: pre-wrap;
		overflow-wrap: break-word;
		font-family: monospace;
	}

	:not(.readable) {
		opacity: .25;
	}
`;
