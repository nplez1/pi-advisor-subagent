/**
 * Test-only ESM resolver hook. Two jobs:
 *
 * 1. Map the TypeScript ESM convention — `./messages.js` meaning `./messages.ts`
 *    — which Pi's own loader resolves and bare `node --experimental-strip-types`
 *    does not. Without this, only modules free of sibling imports are testable,
 *    which would exclude select.ts / payload.ts / execute.ts.
 * 2. Alias `@juicesharp/rpiv-config` to a test double, because that dependency
 *    ships raw TypeScript under node_modules and Node refuses to strip types
 *    there. See test/stubs/rpiv-config.ts for why this matters.
 *
 * Uses the synchronous registerHooks API rather than module.register, which is
 * deprecated on current Node.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const CONFIG_STUB = new URL("./stubs/rpiv-config.ts", import.meta.url).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@juicesharp/rpiv-config") {
			return nextResolve(CONFIG_STUB, context);
		}
		if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
			const asTypeScript = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
			if (existsSync(fileURLToPath(asTypeScript))) return nextResolve(asTypeScript.href, context);
		}
		return nextResolve(specifier, context);
	},
});
