import { U32 } from "@nomadshiba/codec";
import type { LockTime, SequenceLock } from "@project/codecs";
import { DAY, HOUR, MINUTE, MONTH, SECOND, WEEK, YEAR } from "@project/utils";
import { encodeHex } from "@std/encoding";
import { BigNumberFormat } from "~/frontend/utils/intl/BigNumberFormat.ts";

export const LOCALE = new Intl.Locale("en-US");

export function formatHash(bytes: Uint8Array): string {
	return encodeHex(bytes.toReversed());
}

export function formatLocktime(lock: LockTime): string {
	switch (lock.kind) {
		case "none":
			return "none";
		case "block":
			return `block ${lock.height}`;
		case "time":
			return `time ${new Date(lock.timestamp * SECOND).toISOString()}`;
	}
}

export function formatSequence(seq: SequenceLock): string {
	switch (seq.kind) {
		case "final":
			return "final (0xffffffff)";
		case "disable":
			return `disabled (raw: 0x${((seq.unused | 0x80000000) >>> 0).toString(16)})`;
		case "enable":
			if (seq.relativeLock.kind === "block") {
				return `relative lock: ${seq.relativeLock.blocks} blocks`;
			} else {
				return `relative lock: ${seq.relativeLock.seconds}s`;
			}
	}
}

const bytesBinaryFormatter = new BigNumberFormat(LOCALE, { base: 1024, units: ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] });
export function formatBytesBinary(bytes: number): string {
	return bytesBinaryFormatter.format(bytes);
}

const bytesDecimalFormatter = new BigNumberFormat(LOCALE, { base: 1000, units: ["B", "KB", "MB", "GB", "TB", "PB"] });
export function formatBytesDecimal(bytes: number): string {
	return bytesDecimalFormatter.format(bytes);
}

const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE);
export function formatDateTime(value: number | Date | string): string {
	const date = value instanceof Date ? value : new Date(value);
	return dateTimeFormatter.format(date);
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
const RELATIVE_TIME_UNITS = [
	["year", YEAR],
	["month", MONTH],
	["week", WEEK],
	["day", DAY],
	["hour", HOUR],
	["minute", MINUTE],
	["second", SECOND],
] as const;
export function formatRelativeTime(to: Date, from: Date = new Date()): string {
	const diff = to.getTime() - from.getTime();
	for (const [unit, msInUnit] of RELATIVE_TIME_UNITS) {
		const diffInUnits = diff / msInUnit;
		if (Math.abs(diffInUnits) >= 1) {
			return relativeTimeFormatter.format(Math.round(diffInUnits), unit);
		}
	}
	return relativeTimeFormatter.format(0, "second"); // fallback: "now"
}

const numberFormatter = new Intl.NumberFormat(LOCALE, { style: "decimal" });
export function formatNumber(height: number | bigint | Intl.StringNumericLiteral): string {
	return numberFormatter.format(height);
}

export function formatBlockVersion(version: number): string {
	return `0x${encodeHex(U32.encode(version))}`;
}

const difficultyFormatter = new BigNumberFormat(LOCALE);
export function formatDifficulty(n: number): string {
	return difficultyFormatter.format(n);
}

const hashrateFormatter = new BigNumberFormat(LOCALE);
export function formatHashrate(n: number): string {
	return hashrateFormatter.format(n);
}

const SATS_PER_BTC = 100_000_000;
const intFormatter = new Intl.NumberFormat(LOCALE);
const DECIMAL_SEP = intFormatter.formatToParts(1.1).find((p) => p.type === "decimal")!.value;

export function formatBTC(sats: number): string {
	const negative = sats < 0;
	const abs = negative ? -sats : sats;
	const intPart = Math.floor(abs / SATS_PER_BTC);
	const fracPart = abs % SATS_PER_BTC;
	const sign = negative ? "-" : "";

	let decimals: number;
	if (intPart >= 10 || fracPart === 0) {
		decimals = 0;
	} else {
		const fs = fracPart.toString().padStart(8, "0");
		const firstNonZero = fs.search(/[^0]/);
		decimals = intPart > 0 ? 2 : Math.min(8, firstNonZero + 2);
	}

	const frac = fracPart.toString().padStart(8, "0").slice(0, decimals).replace(/0+$/, "");
	return `₿${sign}${intFormatter.format(intPart)}${frac ? DECIMAL_SEP + frac : ""}`;
}

export function formatSats(sats: number): string {
	return `${intFormatter.format(sats)} sats`;
}

export function formatBitcoin(sats: number, satsThreshold = 1_000_000): string {
	return sats < satsThreshold ? formatSats(sats) : formatBTC(sats);
}

export function formatCoinbaseScriptSig(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
