/**
 * subagent-defaults — the pi-subagents per-agent default for this pipeline's
 * agent types.
 *
 * The pi-subagents `/subagents` menu is the single place subagent models and
 * thinking levels are configured, and it lists `rpiv-advisor` / `rpiv-compressor`
 * among the definitions it manages. This pipeline spawns those agents through
 * pi-subagents' cross-extension RPC, so a default set there has to drive the
 * advisor too — otherwise `/subagents` would show a model for the advisor and
 * silently have no effect on it.
 *
 * Precedence on the advisor side is `/subagents` default > `/advisor` selection
 * > unconfigured: the explicit `/advisor` pick remains the fallback, so an
 * existing setup keeps working while `/subagents` is the override.
 *
 * Scope mirrors pi-subagents' own load: global `<agentDir>/subagents.json`
 * provides the base, project `<cwd>/.pi/subagents.json` overrides per agent and
 * per field.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const VALID_THINKING: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export interface SubagentDefault {
	model?: string;
	thinking?: ThinkingLevel;
	enabled?: boolean;
}

/** One agent's raw entry, before validation. */
interface RawOverride {
	model?: unknown;
	thinking?: unknown;
	enabled?: unknown;
}

/** Read `agentOverrides` from one pi-subagents settings file. {} when absent/corrupt. */
function readOverrides(path: string): Record<string, RawOverride> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as { agentOverrides?: unknown };
		const overrides = raw?.agentOverrides;
		if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return {};
		return overrides as Record<string, RawOverride>;
	} catch {
		return {};
	}
}

/** One agent's entry, matched exactly then by a unique case-insensitive name. */
function pick(map: Record<string, RawOverride>, agentType: string): RawOverride {
	const direct = map[agentType];
	if (direct) return direct;
	const lower = agentType.toLowerCase();
	const keys = Object.keys(map).filter((key) => key.toLowerCase() === lower);
	return keys.length === 1 ? map[keys[0]] : {};
}

function modelOf(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function thinkingOf(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && VALID_THINKING.has(value) ? (value as ThinkingLevel) : undefined;
}

/** Only a real boolean counts: `false` is a configured state, not an absence. */
function boolOf(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/**
 * The configured default for `agentType`, project over global, field by field.
 *
 * A missing `cwd` yields no default rather than reading the global file: a test
 * double (or a context before session bind) has no project scope, and reading
 * `<agentDir>/subagents.json` from a test process would let the developer's own
 * configuration change the outcome.
 */
export function readSubagentDefault(agentType: string, cwd: string | undefined): SubagentDefault {
	if (!cwd) return {};
	const globalEntry = pick(readOverrides(join(getAgentDir(), "subagents.json")), agentType);
	const projectEntry = pick(readOverrides(join(cwd, ".pi", "subagents.json")), agentType);
	// Only set keys that have a value, so an absent field is genuinely absent
	// (`in`/`Object.keys` checks downstream stay honest) rather than explicitly
	// undefined.
	const out: SubagentDefault = {};
	const model = modelOf(projectEntry.model) ?? modelOf(globalEntry.model);
	const thinking = thinkingOf(projectEntry.thinking) ?? thinkingOf(globalEntry.thinking);
	const enabled = boolOf(projectEntry.enabled) ?? boolOf(globalEntry.enabled);
	if (model !== undefined) out.model = model;
	if (thinking !== undefined) out.thinking = thinking;
	if (enabled !== undefined) out.enabled = enabled;
	return out;
}

/**
 * Resolve a `/subagents` model default to a registry model. Exact
 * `provider/modelId` first (what the picker writes), then a bare-id match, so a
 * hand-written alias still works. Undefined when it does not resolve — callers
 * fall back to their own selection rather than failing the tool.
 */
export function resolveSubagentDefaultModel(
	input: string | undefined,
	ctx: ExtensionContext,
): Model<Api> | undefined {
	if (!input) return undefined;
	const registry = ctx.modelRegistry as unknown as {
		find(provider: string, id: string): Model<Api> | undefined;
		getAvailable?(): { provider: string; id: string }[];
		getAll?(): { provider: string; id: string }[];
	};
	const slash = input.indexOf("/");
	if (slash > 0) {
		const found = registry.find(input.slice(0, slash), input.slice(slash + 1));
		if (found) return found;
	}
	const all = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
	const match = all.find((m) => m.id === input || `${m.provider}/${m.id}` === input);
	return match ? registry.find(match.provider, match.id) : undefined;
}
