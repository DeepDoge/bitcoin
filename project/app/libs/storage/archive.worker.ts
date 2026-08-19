import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

export type Job = {
	id: number;
	index: number;
	rawPath: string;
	tmpPath: string;
	params: zlib.ZstdOptions["params"];
};

export type Done = { id: number; index: number; ok: true; archivedSize: number };
export type Failed = { id: number; index: number; ok: false; error: string };
export type Result = Done | Failed;

self.onmessage = async (event: MessageEvent<Job>) => {
	const { id, index, rawPath, tmpPath, params } = event.data;
	try {
		const source = createReadStream(rawPath);
		const transform = zlib.createZstdCompress({ params });
		const sink = createWriteStream(tmpPath);
		await pipeline(source, transform, sink);
		const archivedSize = Deno.statSync(tmpPath).size;
		const result: Done = { id, index, ok: true, archivedSize };
		self.postMessage(result);
	} catch (reason) {
		const result: Failed = { id, index, ok: false, error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) };
		self.postMessage(result);
	}
};
