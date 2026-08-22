import { tags, toChild } from "@purifyjs/core";
import { encodeHex } from "@std/encoding";
import { api } from "~/frontend/api.ts";
import { BlockView } from "~/frontend/components/BlockView.ts";
import { ChainTimeline } from "~/frontend/components/ChainTimeline.ts";
import { TxView } from "~/frontend/components/TxView.ts";
import { fragment } from "~/frontend/fragment.ts";
import { GlobalStyle } from "~/frontend/style.ts";
import { awaited } from "~/frontend/utils/dom/awaited.ts";
import { useReplaceChildren } from "~/frontend/utils/dom/bind.ts";
import { css } from "~/frontend/utils/dom/css.ts";
import { unroll } from "~/frontend/utils/dom/unroll.ts";

await import("@ungap/custom-elements");

const { body, main, header, progress } = tags;

function App() {
	const self = body().$bind(AppStyle.useScope());

	const view = fragment.derive((fragment) => {
		if (fragment.kind === "home") {
			return null;
		}
		if (fragment.kind === "block.hash") {
			const hashOrHeight = encodeHex(fragment.hash.toReversed());
			return awaited(
				api.fetch("GET /v1/block/:hashOrHeight", { params: { pathname: { hashOrHeight } } })
					.then((block) => (block ? BlockView(block) : null)),
			);
		}
		if (fragment.kind === "block.height") {
			const hashOrHeight = `${fragment.height}`;
			return awaited(
				api.fetch("GET /v1/block/:hashOrHeight", { params: { pathname: { hashOrHeight } } })
					.then((block) => (block ? BlockView(block) : null)),
			);
		}
		if (fragment.kind === "tx") {
			const txId = encodeHex(fragment.txId.toReversed());
			return awaited(
				api.fetch("GET /v1/tx/:txId", { params: { pathname: { txId } } })
					.then((tx) => (tx ? TxView(tx) : null)),
			);
		}
	}).pipe(unroll);

	self.append$(
		header().$bind(useReplaceChildren(awaited(ChainTimeline(), progress()))),
		main().$bind(useReplaceChildren(view)),
	);

	return self;
}

const AppStyle = css`
	:scope {
		display: block grid;
		min-block-size: 100dvb;

		grid-template-areas: "main header";
		grid-template-columns: 1fr minmax(0, 30em);
	}

	main {
		grid-area: main;
		container-type: inline-size;
		display: block grid;
		align-content: start;

		padding-block: 3em;
		padding-inline: 3.25em;
	}

	header {
		grid-area: header;
		display: block grid;
		container-type: inline-size;
		max-block-size: 100dvb;
		position: sticky;
		inset-block-start: 0;
	}
`;

document.adoptedStyleSheets.push(GlobalStyle.sheet());
document.body.replaceWith(toChild(App()));
