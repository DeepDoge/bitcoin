import { tags } from "@purifyjs/core";
import { encodeHex } from "@std/encoding";
import { css } from "~/frontend/utils/dom/css.ts";
import {
	formatBitcoin,
	formatBytesDecimal,
	formatHash,
	formatLocktime,
	formatSequence,
} from "~/frontend/utils/format.ts";
import { Tx } from "~/routes.ts";

export function TxView(tx: Tx) {
	const { a, article, header, h1, dl, dt, dd, div, section, h2, code, ol, li } = tags;

	const txIdHex = formatHash(tx.txId);
	const wtxIdHex = tx.witness.length > 0 ? formatHash(tx.wtxId) : null;

	const totalIn = sumInputs(tx);
	const totalOut = sumOutputs(tx);
	const fee = totalIn - totalOut;

	const row = (term: string, ...value: Parameters<ReturnType<typeof dd>["append$"]>) =>
		div().append$(dt().textContent(term), dd().append$(...value));

	const self = article().$bind(TxViewStyle.useScope());

	self.append$(
		header().append$(
			div({ class: "eyebrow" }).textContent("Transaction"),
			h1().textContent(txIdHex),
			wtxIdHex ? code({ class: "hash" }).textContent(`wtxid: ${wtxIdHex}`) : null,
		),
		section().append$(
			h2().textContent("Summary"),
			dl().append$(
				div({ class: "summary-rows" }).append$(
					row("Version", `${tx.version}`),
					row("Locktime", formatLocktime(tx.locktime)),
					row("Inputs", `${tx.inputs.length}`),
					row("Outputs", `${tx.outputs.length}`),
					row("Size", formatBytesDecimal(WireTxSize(tx))),
					row("Fee", formatBitcoin(fee)),
					row("Total in", formatBitcoin(totalIn)),
					row("Total out", formatBitcoin(totalOut)),
				),
			),
		),
		section().append$(
			h2().textContent("Inputs"),
			ol().append$(
				...tx.inputs.map((input, i) =>
					li().append$(
						InputView({ input, index: i }),
					)
				),
			),
		),
		section().append$(
			h2().textContent("Outputs"),
			ol().append$(
				...tx.outputs.map((output, i) =>
					li().append$(
						OutputView({ output, index: i }),
					)
				),
			),
		),
	);

	return self;
}

function InputView(props: { input: Tx["inputs"][number]; index: number }) {
	const { a, div, code, dl, dt, dd, span } = tags;
	const { input, index } = props;

	const isCoinbase = input.prevOut.txId.every((b) => b === 0) && input.prevOut.output === 0xffffffff;
	const txIdHex = formatHash(input.prevOut.txId);

	const self = div().$bind(InputRowStyle.useScope());

	self.append$(
		span({ class: "index" }).textContent(`${index}`),
		dl().append$(
			div().append$(
				dt().textContent("Previous"),
				isCoinbase
					? dd().textContent("Coinbase")
					: dd().append$(
						a({ class: "hash" })
							.href(`#/tx/${txIdHex}`)
							.textContent(`${txIdHex}:${input.prevOut.output}`),
					),
			),
			div().append$(dt().textContent("ScriptSig"), dd().append$(code({ class: "script" }).textContent(encodeHex(input.scriptSig)))),
			div().append$(dt().textContent("Sequence"), dd().textContent(formatSequence(input.sequence))),
		),
	);

	return self;
}

function OutputView(props: { output: Tx["outputs"][number]; index: number }) {
	const { div, code, dl, dt, dd, span } = tags;
	const { output, index } = props;

	const self = div().$bind(OutputRowStyle.useScope());

	self.append$(
		span({ class: "index" }).textContent(`${index}`),
		dl().append$(
			div().append$(dt().textContent("Value"), dd().textContent(formatBitcoin(output.value))),
			div().append$(dt().textContent("ScriptPubKey"), dd().append$(code({ class: "script" }).textContent(encodeHex(output.scriptPubKey)))),
		),
	);

	return self;
}

function sumInputs(tx: Tx): bigint {
	// Coinbase inputs have no real prevOut value; we can't resolve prev txs here, return 0n
	if (tx.inputs.length === 1) {
		const input = tx.inputs[0]!;
		if (input.prevOut.txId.every((b) => b === 0) && input.prevOut.output === 0xffffffff) {
			return 0n;
		}
	}
	return 0n;
}

function sumOutputs(tx: Tx): bigint {
	let sum = 0n;
	for (const out of tx.outputs) sum += out.value;
	return sum;
}

function WireTxSize(tx: Tx): number {
	// version(4) + inputs count + outputs count + locktime(4)
	let size = 4;
	size += varIntSize(tx.inputs.length);
	for (const input of tx.inputs) {
		size += 32 + 4; // prevOut
		size += varIntSize(input.scriptSig.length) + input.scriptSig.length;
		size += 4; // sequence
	}
	size += varIntSize(tx.outputs.length);
	for (const output of tx.outputs) {
		size += 8; // value
		size += varIntSize(output.scriptPubKey.length) + output.scriptPubKey.length;
	}
	if (tx.witness.length > 0) {
		size += 2; // marker + flag
		for (const inputWitness of tx.witness) {
			size += varIntSize(inputWitness.length);
			for (const item of inputWitness) {
				size += varIntSize(item.length) + item.length;
			}
		}
	}
	size += 4; // locktime
	return size;
}

function varIntSize(n: number): number {
	if (n < 0xfd) return 1;
	if (n <= 0xffff) return 3;
	if (n <= 0xffffffff) return 5;
	return 9;
}

const TxViewStyle = css`
	:scope {
		display: block grid;
		gap: 1.5em;
		align-content: start;
		padding-block: 1.5em;
		padding-inline: 1.25em;
		inline-size: 100%;
		max-inline-size: 60em;
	}

	header {
		display: block grid;
		gap: 0.35em;
		padding-block: 1.35em;
		padding-inline: 1.25em;
		border-radius: var(--panel-radius);
		background-image: var(--panel-surface);
		box-shadow: var(--panel-shadow);
	}

	.eyebrow {
		font-size: 0.7em;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: color-mix(in srgb, currentcolor 50%, transparent);
	}

	h1 {
		font-size: 1.4em;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		background-image: linear-gradient(180deg, var(--pop), color-mix(in srgb, var(--pop), var(--base) 45%));
		background-clip: text;
		color: transparent;
		word-break: break-all;
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

	.hash {
		font-size: 0.85em;
		word-break: break-all;
		color: color-mix(in srgb, currentcolor 82%, transparent);
	}

	a.hash:hover {
		color: var(--accent-base);
	}

	section {
		display: block grid;
		gap: 0.9em;
		padding-block: 1.1em;
		padding-inline: 1.15em;
		border-radius: var(--panel-radius);
		background-image: var(--panel-surface);
		box-shadow: var(--panel-shadow);
	}

	dl,
	.summary-rows {
		display: block grid;
		gap: 0.65em 1.25em;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 16em), 1fr));
	}

	dl > div,
	.summary-rows > div {
		display: block grid;
		gap: 0.15em;
		overflow: hidden;
	}

	dt {
		font-size: 0.65em;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: color-mix(in srgb, currentcolor 50%, transparent);
	}

	dd {
		font-variant-numeric: tabular-nums;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	ol {
		display: block grid;
		gap: 0.5em;
	}

	li {
		display: block grid;
		gap: 0.5em;
		padding-block: 0.7em;
		padding-inline: 0.9em;
		border-radius: var(--radius-min);
		background-color: color-mix(in srgb, currentcolor 3%, transparent);
	}

	.script {
		font-size: 0.8em;
		word-break: break-all;
		color: color-mix(in srgb, currentcolor 70%, transparent);
	}
`;

const InputRowStyle = css`
	:scope {
		display: block grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.75em;
		align-items: start;
	}

	.index {
		font-size: 0.7em;
		font-variant-numeric: tabular-nums;
		color: color-mix(in srgb, currentcolor 45%, transparent);
	}

	dl {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25em 1.5em;
		font-size: 0.8em;
	}

	dl > div {
		display: block grid;
		gap: 0.1em;
	}
`;

const OutputRowStyle = css`
	:scope {
		display: block grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.75em;
		align-items: start;
	}

	.index {
		font-size: 0.7em;
		font-variant-numeric: tabular-nums;
		color: color-mix(in srgb, currentcolor 45%, transparent);
	}

	dl {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25em 1.5em;
		font-size: 0.8em;
	}

	dl > div {
		display: block grid;
		gap: 0.1em;
	}
`;