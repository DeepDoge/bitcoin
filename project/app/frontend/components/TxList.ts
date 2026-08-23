import { Member, ref, sync, tags } from "@purifyjs/core";
import { api } from "~/frontend/api.ts";
import { css } from "~/frontend/utils/dom/css.ts";
import { useReplaceChildren } from "~/frontend/utils/dom/bind.ts";
import { formatBytesDecimal, formatHash } from "~/frontend/utils/format.ts";
import { TxSummary } from "~/routes.ts";

const PAGE = 50;

export function TxList(props: { hashOrHeight: string | number | bigint; txCount: number }) {
	const { a, section, h2, ol, li, div, span, button } = tags;

	const from = ref(0);
	const total = props.txCount;

	const rows = sync<Member>((set) => {
		let cancelled = false;
		let token = 0;
		const unfollow = from.follow(async (from) => {
			if (total <= 0) {
				set(null);
				return;
			}
			const take = Math.min(PAGE, total - from);
			if (take <= 0) {
				set(null);
				return;
			}
			const myToken = ++token;
			const txs = await api.fetch("GET /v1/block/:hashOrHeight/txs", {
				params: { pathname: { hashOrHeight: props.hashOrHeight }, search: { from: `${from}`, take: `${take}` } },
			});
			if (cancelled || myToken !== token) return;
			set(
				ol().append$(
					txs.map((tx, i) => TxRow({ tx, index: from + i })),
				),
			);
		}, true);
		return () => {
			cancelled = true;
			unfollow();
		};
	});

	const canPrev = from.derive((from) => from > 0);
	const canNext = from.derive((from) => from + PAGE < total);
	const range = from.derive((from) => {
		if (total <= 0) return "none";
		const end = Math.min(from + PAGE, total);
		return `${from + 1}\u2013${end} of ${total}`;
	});

	const self = section().ariaLabel("Transactions").$bind(TxListStyle.useScope());

	self.append$(
		h2().textContent("Transactions"),
		div({ class: "pager" }).append$(
			button()
				.type("button")
				.textContent("Prev")
				.disabled(canPrev.derive((v) => !v))
				.onclick(() => from.set(Math.max(0, from.val - PAGE))),
			span({ class: "range" }).textContent(range),
			button()
				.type("button")
				.textContent("Next")
				.disabled(canNext.derive((v) => !v))
				.onclick(() => from.set(from.val + PAGE)),
		),
		div({ class: "rows" }).$bind(useReplaceChildren(rows)),
	);

	return self;
}

function TxRow(props: { tx: TxSummary; index: number }) {
	const { a, li, div, dl, dt, dd, span } = tags;

	const txIdHex = formatHash(props.tx.txId);

	const self = li().$bind(TxRowStyle.useScope());

	self.append$(
		div({ class: "head" }).append$(
			span({ class: "index" }).textContent(`${props.index}`),
			a({ class: "hash" }).href(`#/tx/${txIdHex}`).textContent(txIdHex),
		),
		dl().append$(
			div().append$(dt().textContent("Inputs"), dd().textContent(`${props.tx.inputs}`)),
			div().append$(dt().textContent("Outputs"), dd().textContent(`${props.tx.outputs}`)),
			div().append$(dt().textContent("Size"), dd().textContent(formatBytesDecimal(props.tx.wireSize))),
		),
	);

	return self;
}

const TxListStyle = css`
	:scope {
		display: block grid;
		gap: 0.9em;
	}

	h2 {
		display: block grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 0.75em;
		font-size: 0.8em;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: color-mix(in srgb, currentcolor 60%, transparent);
	}

	h2::after {
		content: "";
		block-size: 1px;
		background-image: linear-gradient(to right, color-mix(in srgb, currentcolor 20%, transparent), transparent);
	}

	.pager {
		display: flex;
		align-items: center;
		gap: 0.75em;
		font-size: 0.8em;
	}

	.pager button {
		padding: 0.3em 0.8em;
		border-radius: var(--radius-min);
		border: 1px solid color-mix(in srgb, currentcolor 18%, transparent);
		background-color: color-mix(in srgb, currentcolor 5%, transparent);
		color: inherit;
		font: inherit;
		cursor: pointer;
		&:hover:not(:disabled) {
			background-color: color-mix(in srgb, currentcolor 12%, transparent);
		}
		&:disabled {
			opacity: 0.4;
			cursor: not-allowed;
		}
	}

	.range {
		font-variant-numeric: tabular-nums;
		color: color-mix(in srgb, currentcolor 60%, transparent);
	}

	.rows {
		display: block grid;
		gap: 0.5em;
	}

	.rows:empty::before {
		content: "No transactions";
		font-size: 0.85em;
		color: color-mix(in srgb, currentcolor 55%, transparent);
	}
`;

const TxRowStyle = css`
	:scope {
		display: block grid;
		gap: 0.5em;
		padding-block: 0.7em;
		padding-inline: 0.9em;
		border-radius: var(--radius-min);
		background-color: color-mix(in srgb, currentcolor 3%, transparent);
	}

	.head {
		display: flex;
		align-items: baseline;
		gap: 0.75em;
		min-inline-size: 0;
	}

	.index {
		font-size: 0.7em;
		font-variant-numeric: tabular-nums;
		color: color-mix(in srgb, currentcolor 45%, transparent);
		flex: 0 0 auto;
	}

	.hash {
		font-size: 0.85em;
		word-break: break-all;
		color: color-mix(in srgb, currentcolor 82%, transparent);
		&:hover {
			color: var(--accent-base);
		}
	}

	dl {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25em 1.5em;
		font-size: 0.75em;
	}

	dl > div {
		display: block grid;
		gap: 0.1em;
	}

	dt {
		font-size: 0.85em;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: color-mix(in srgb, currentcolor 50%, transparent);
	}

	dd {
		font-variant-numeric: tabular-nums;
	}
`;
