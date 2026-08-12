import { RouterClient } from "~/libs/routing/RouterClient.ts";
import { SCHEMA } from "~/routes.ts";

export const api = RouterClient.create<typeof SCHEMA>({
	baseUrl: new URL("/", location.href),
	schema: SCHEMA,
	fetch: (...args) => fetch(...args),
});
