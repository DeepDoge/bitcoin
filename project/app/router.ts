import { Router } from "~/libs/routing/Router.ts";
import { SCHEMA } from "~/routes.ts";

export const endpointRouter = new Router({ schema: SCHEMA });
