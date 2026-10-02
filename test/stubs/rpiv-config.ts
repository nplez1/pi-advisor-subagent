/**
 * Test double for `@juicesharp/rpiv-config`.
 *
 * The real package ships raw TypeScript (`node_modules/@juicesharp/rpiv-config/index.ts`),
 * and Node refuses to strip types for files under `node_modules`. Without this
 * stub, config.ts / command.ts / restore.ts / handlers.ts cannot be loaded at
 * all outside Pi, which would leave the rewritten four-step `/advisor` flow and
 * the compressor restore path completely unverified — and `/advisor` is now the
 * only way to unblock `advisor()`, so breaking it is expensive.
 *
 * Semantics mirror the real module (see its config.ts), with ONE deliberate
 * divergence for safety:
 *
 *   This stub REFUSES to resolve a config directory unless XDG_CONFIG_HOME is
 *   set to an absolute path, and it never falls back to the real `~/.config`.
 *   The real module defaults to `~/.config` and reads a legacy path there. A
 *   test that forgot to set XDG_CONFIG_HOME would otherwise read and overwrite
 *   the developer's live advisor.json. Failing loudly is the correct trade.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export function readEnvVar(key: string, fallback?: string): string | undefined {
	return process.env[key]?.trim() || fallback;
}

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function resolveConfigDir(): string {
	const xdg = readEnvVar("XDG_CONFIG_HOME");
	if (!xdg) throw new Error("test stub: XDG_CONFIG_HOME must be set — refusing to touch the real ~/.config");
	const expanded = expandTilde(xdg);
	if (!isAbsolute(expanded)) throw new Error("test stub: XDG_CONFIG_HOME must be absolute");
	return expanded;
}

export function configPath(name: string, file = "config.json"): string {
	return join(resolveConfigDir(), name, file);
}

/** Kept inside the temp XDG dir so the real legacy path is never read. */
function legacyConfigPath(name: string, file = "config.json"): string {
	return join(resolveConfigDir(), "legacy", name, file);
}

export function loadJsonConfig<T>(path: string): T {
	if (!existsSync(path)) return {} as T;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
		return parsed as T;
	} catch {
		return {} as T;
	}
}

export function loadJsonConfigWithLegacyFallback<T>(name: string, file = "config.json"): T {
	const xdgPath = configPath(name, file);
	if (existsSync(xdgPath)) return loadJsonConfig<T>(xdgPath);
	return loadJsonConfig<T>(legacyConfigPath(name, file));
}

export function saveJsonConfig(path: string, data: unknown): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	} catch {
		return false;
	}
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort, mirrors the real module.
	}
	return true;
}

export function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
	const slashIdx = key.indexOf("/");
	if (slashIdx >= 1) return { provider: key.slice(0, slashIdx), modelId: key.slice(slashIdx + 1) };
	const colonIdx = key.indexOf(":");
	if (colonIdx >= 1) return { provider: key.slice(0, colonIdx), modelId: key.slice(colonIdx + 1) };
	return undefined;
}

export function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const record = fields as Record<string, unknown>;
	const out: GuidanceFields = {};
	if (typeof record.promptSnippet === "string" && record.promptSnippet.length > 0) {
		out.promptSnippet = record.promptSnippet;
	}
	if (
		Array.isArray(record.promptGuidelines) &&
		record.promptGuidelines.length > 0 &&
		record.promptGuidelines.every((g) => typeof g === "string" && g.length > 0)
	) {
		out.promptGuidelines = record.promptGuidelines as string[];
	}
	return out;
}
