import { MAX_BLOCK_SIZE, MIN_STANDARD_TX_NONWITNESS_SIZE, SECOND } from "@project/utils";
import { tags } from "@purifyjs/core";
import { encodeHex } from "@std/encoding";
import { EllipsisWithSuffix } from "~/frontend/components/EllipsisWithSuffix.ts";
import { TxList } from "~/frontend/components/TxList.ts";
import { TextTrimMixin, WideLetterSpacingMixin } from "~/frontend/style.ts";
import { css } from "~/frontend/utils/dom/css.ts";
import {
	formatBytesDecimal,
	formatCoinbaseScriptSig,
	formatHash,
	formatNumber,
	formatRelativeTime,
	LOCALE,
} from "~/frontend/utils/format.ts";
import { Block } from "~/routes.ts";
import { CoinbaseScriptSig } from "~/frontend/components/CoinbaseScriptSig.ts";
import { WireBlockHeader } from "@project/codecs";

const d = new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const t = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
const formatTimestamp = (timestamp: Date) => `${d.format(timestamp)} · ${t.format(timestamp)} UTC`;

export function BlockView(block: Block) {
	const { a, article, header, h1, small, data, label, meter, span, strong, section, h2, code, time } = tags;

	const hash = block.header.hash().toReversed();
	const hashHex = encodeHex(hash);
	const prevHashHex = formatHash(block.header.prevHash);
	const timestamp = new Date(block.header.timestamp * SECOND);

	const headroom = MAX_BLOCK_SIZE - (block.info?.wireSize ?? 0);
	const headroomFormatted = block.info ? (100 * (headroom / MAX_BLOCK_SIZE)).toFixed(0) : "-";

	const efficiencyRatio = ((block.info?.txCount ?? 0) * MIN_STANDARD_TX_NONWITNESS_SIZE) /
		((block.info?.wireSize ?? 0) - WireBlockHeader.stride.size);

	const self = article().$bind(BlockViewStyle.useScope());

	self.append$(
		header().append$(
			h1().append$(
				small().textContent("Block"),
				strong().textContent(formatNumber(block.height)),
				/* TODO:
					later when you have toast alerts,
				 	have a seperate copy function that we import and use here,
					that also shows "copied" alert
				*/
				code().onclick(() => navigator.clipboard.writeText(hashHex)).append$(EllipsisWithSuffix(hashHex)),
			),
			time().dateTime(timestamp.toISOString()).append$(
				strong().textContent(formatRelativeTime(timestamp)),
				small().textContent(formatTimestamp(timestamp)),
			),
		),
		section().id("block-pow").ariaLabel("Proof of work").append$(
			h2().textContent("Proof of work"),
		),
		section().id("block-content").ariaLabel("Content").append$(
			h2().textContent("Contents"),
			span({ class: "count" }).append$(
				strong({ class: "value" }).append$(
					data()
						.value(block.info ? String(block.info.txCount) : "")
						.textContent(block.info ? formatNumber(block.info.txCount) : "-"),
				),
				small({ class: "unit" }).textContent("txs"),
				small({ class: "size" }).append$(
					data().value(block.info ? String(block.info.wireSize) : "")
						.textContent(block.info ? `${formatBytesDecimal(block.info.wireSize)} on wire` : "-"),
				),
			),
			label().append$(
				meter().max(MAX_BLOCK_SIZE).value(headroom),
				span().textContent(`headroom: ${headroomFormatted}%`),
			),
			/* label().append$(
				meter().max(100_000).value(efficiencyRatio * 100_000),
				span().textContent(`efficiency: ${(efficiencyRatio * 100).toFixed(0)}%`),
			), */
		),
		section().id("block-reward").ariaLabel("Reward").append$(
			h2().textContent("Reward"),
		),
		section().id("block-coinbase").ariaLabel("Coinbase signature").append$(
			h2().textContent("Coinbase signature"),
			block.info ? CoinbaseScriptSig(block.info.coinbaseScriptSig) : "-",
		),
		TxList({ hashOrHeight: block.height, txCount: block.info ? block.info.txCount : 0 }).$bind(TransactionSectionStyle.useScope()),
	);

	return self;
}

const BlockViewStyle = css`
	:scope {
		display: block grid;
		gap: 1.5em;

		grid-template-columns: repeat(3, 1fr);

		@container (inline-size < 60em) {
			grid-template-columns: 1fr;
		}
	}

	header {
		grid-column: 1 / -1;
		display: block grid;
		grid-template-columns: minmax(0, 20em) 1fr;
		gap: 1em;
	}

	header h1 {
		display: block grid;
		gap: .75em;
		justify-items: start;

		small {
			opacity: .5;
			font-size: .9em;
			${WideLetterSpacingMixin};
			${TextTrimMixin};
			text-transform: uppercase;
		}

		strong {
			text-box: trim-both cap alphabetic;
			font-variant-numeric: tabular-nums slashed-zero;
			font-size: 3.5em;
		}
	}

	header time {
		display: block grid;
		gap: .75em;
		text-align: end;
		align-content: start;

		small {
			opacity: .5;
			text-box: trim-both cap alphabetic;
			font-size: .75em;
		}

		strong {
			font-weight: normal;
			text-box: trim-both cap alphabetic;
		}
	}

	@container (inline-size < 40em) {
		header {
			grid-template-columns: 1fr;
		}

		header time {
			text-align: center;
		}
	}

	section {
		display: block grid;
		align-content: start;
		gap: 1.5em;
		padding-block: 1.5em;
		padding-inline: 2em;
		border-radius: var(--radius-max);
		background-color: var(--surface);
	}

	h2 {
		display: block grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 0.75em;
		font-size: 0.8em;
		color: color-mix(in srgb, currentcolor 60%, transparent);

		${WideLetterSpacingMixin};
		${TextTrimMixin};
		text-transform: uppercase;
	}

	h2::after {
		content: "";
		block-size: 1px;
		background-image: linear-gradient(to right, color-mix(in srgb, currentcolor 20%, transparent), transparent);
	}

	section#block-content {
		.count {
			display: block grid;
			grid-template-columns: auto 1fr;
			row-gap: 1em;
			align-items: baseline;

			& > * {
				${TextTrimMixin};
			}

			.value {
				font-size: 2.5em;
			}

			.unit {
				opacity: 0.65;
				font-size: 1em;
			}

			.size {
				grid-column: 1 / -1;
				opacity: 0.5;
				font-size: 1em;
			}
		}

		label:has(> meter) {
			display: block grid;
			gap: 0.5em;

			color: var(--positive-base);

			span {
				font-size: 0.8em;
				${WideLetterSpacingMixin};
				${TextTrimMixin};
				text-transform: uppercase;
			}
		}
	}

	section#block-coinbase {
		grid-column: 1 / -1;

		code {
			overflow-wrap: break-word;
			white-space: normal;
			min-inline-size: 0;
		}
	}
`;

const TransactionSectionStyle = css`
	:scope {
		grid-column: 1 / -1;
	}
`;
