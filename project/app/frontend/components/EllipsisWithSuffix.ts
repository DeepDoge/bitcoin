import { tags } from "@purifyjs/core";
import { css } from "~/frontend/utils/dom/css.ts";

export function EllipsisWithSuffix(input: string, suffixLength = 8) {
	const { span } = tags;
	const prefix = input.slice(0, -suffixLength);
	const suffix = input.slice(-suffixLength);
	return span().$bind(EllipsisWithSuffixStyle.useScope()).append$(
		span().textContent(prefix),
		span().textContent(suffix),
	);
}

const EllipsisWithSuffixStyle = css`
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
