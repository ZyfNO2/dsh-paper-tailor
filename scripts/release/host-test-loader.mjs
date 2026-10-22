/** Actual pinned SDK packages for service tests; this does not start a live Host. */
import { registerHooks, createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
const sdk = createRequire(
  new URL("../../tools/host-test/package.json", import.meta.url),
);
const entries = new Map(
  readdirSync(
    new URL(
      "../../tools/host-test/node_modules/@deepseek-ai/",
      import.meta.url,
    ),
  ).map((name) => [
    `@deepseek-ai/${name}`,
    pathToFileURL(sdk.resolve(`@deepseek-ai/${name}`)).href,
  ]),
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = entries.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});
