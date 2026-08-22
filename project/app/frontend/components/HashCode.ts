import { tags } from "@purifyjs/core";
import { css } from "~/frontend/utils/dom/css.ts";

export function HashCode(input: string, suffixLength = 8) {
	const { span, code } = tags;
	const prefix = input.slice(0, -suffixLength);
	const suffix = input.slice(-suffixLength);
	return code().$bind(HashCodeStyle.useScope()).append$(
		span().textContent(prefix),
		span().textContent(suffix),
	);
}

const HashCodeStyle = css`
	:scope {
		display: block grid;
		justify-content: start;
		white-space: nowrap;
		grid-auto-flow: column;
	}

	:scope > :first-child {
		overflow: hidden;
		text-overflow: ellipsis;
		opacity: .5;
	}
`;
