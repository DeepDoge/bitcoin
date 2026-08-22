import { MAX_BLOCK_SIZE, SECOND } from "@project/utils";
import { tags } from "@purifyjs/core";
import { encodeHex } from "@std/encoding";
import { HashCode } from "~/frontend/components/HashCode.ts";
import { TxList } from "~/frontend/components/TxList.ts";
import { css } from "~/frontend/utils/dom/css.ts";
import { formatBytesDecimal, formatHash, formatNumber, formatRelativeTime, LOCALE } from "~/frontend/utils/format.ts";
import { Block } from "~/routes.ts";

const d = new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const t = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
const formatTimestamp = (timestamp: Date) => `${d.format(timestamp)} · ${t.format(timestamp)} UTC`;

export function BlockView(block: Block) {
	const { a, article, header, h1, small, dl, dt, dd, label, meter, span, strong, section, h2, code, time } = tags;

	const hash = block.header.hash().toReversed();
	const hashHex = encodeHex(hash);
	const prevHashHex = formatHash(block.header.prevHash);
	const timestamp = new Date(block.header.timestamp * SECOND);

	const meterValue = MAX_BLOCK_SIZE - (block.info?.wireSize ?? 0);
	const meterLabel = block.info ? `${(100 * ((MAX_BLOCK_SIZE - block.info.wireSize) / MAX_BLOCK_SIZE)).toFixed(0)}% headroom` : "-";

	const self = article().$bind(BlockViewStyle.useScope());

	self.append$(
		header().append$(
			h1().append$(
				small().textContent("Block"),
				strong().textContent(formatNumber(block.height)),
				HashCode(hashHex),
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
			h2().textContent("Content"),
			span({ class: "count" }).append$(
				strong().textContent(block.info ? formatNumber(block.info.txCount) : "-"),
				small().textContent("txs"),
			),
			small({ class: "size" }).textContent(`${block.info ? formatBytesDecimal(block.info.wireSize) : "-"} size`),
			label().append$(
				meter().max(MAX_BLOCK_SIZE).value(meterValue),
				span().textContent(meterLabel),
			),
		),
		section().id("block-reward").ariaLabel("Reward").append$(
			h2().textContent("Reward"),
		),
		section().id("block-coinbase").ariaLabel("Coinbase signature").append$(
			h2().textContent("Coinbase signature"),
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
			text-box: trim-both cap alphabetic;
			text-transform: uppercase;
			font-size: .9em;
		}

		strong {
			font-variant-numeric: tabular-nums slashed-zero;
			font-size: 3.5em;
			text-box: trim-both cap alphabetic;
			text-transform: uppercase;
			/* Pull left by the digit's side bearing so its ink aligns with the label above.
			In em, so it tracks font-size. Safe as a constant: tabular-nums gives every
			digit the same bearing, so no per-glyph drift. Tune against the rendered "0". */
			margin-inline-start: -0.05em;
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

	section {
		display: block grid;
		gap: 0.9em;
		align-content: start;
		padding-block: 1.1em;
		padding-inline: 1.15em;
		border-radius: var(--radius-max);
		background-color: var(--surface);
	}

	section#block-coinbase {
		grid-column: 1 / -1;
	}
`;

const TransactionSectionStyle = css`
	:scope {
		grid-column: 1 / -1;
	}
`;
