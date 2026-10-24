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
import { createClaudeCodeModel, isClaudeCodeModelSpec } from "./claude-code.js";

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

/** Read one settings file whole. {} when absent, unreadable, or not an object. */
function readFileObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return raw as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Read `agentOverrides` from one pi-subagents settings file. {} when absent/corrupt. */
function readOverrides(path: string): Record<string, RawOverride> {
	const overrides = readFileObject(path).agentOverrides;
	if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return {};
	return overrides as Record<string, RawOverride>;
}

/**
 * The switch value pi-subagents applied but could NOT persist, when it has one.
 *
 * That is the only thing the files cannot tell this plugin, so it is the only
 * thing taken from the events. Adopting the platform's EFFECTIVE value instead
 * would be adopting a copy of the file's, and would outlive the line it came
 * from: delete `"claudeCode": false` mid-session and this plugin would keep
 * refusing a stage pi-subagents now runs.
 *
 * `undefined` means "nothing published", which is also what a successful write
 * (and every startup) publishes.
 */
let publishedClaudeCode: boolean | undefined;

/** Take the session-only value from pi-subagents' settings events. */
export function setClaudeCodeFromSettings(value: unknown): void {
	publishedClaudeCode = typeof value === "boolean" ? value : undefined;
}

/** Test hook: drop back to reading the files. */
export function clearPublishedClaudeCode(): void {
	publishedClaudeCode = undefined;
}

/**
 * The switch as the two `subagents.json` files state it, or `undefined`.
 *
 * Project over global, absent meaning "no file says" — the same precedence
 * pi-subagents applies, so the advisor's report and the spawn read one answer.
 *
 * No `cwd` means the caller has no project scope; only the global file applies.
 */
function fileClaudeCode(cwd: string | undefined): boolean | undefined {
	const project = cwd ? readFileObject(join(cwd, ".pi", "subagents.json")).claudeCode : undefined;
	if (typeof project === "boolean") return project;
	const global = readFileObject(join(getAgentDir(), "subagents.json")).claudeCode;
	return typeof global === "boolean" ? global : undefined;
}

/**
 * Whether `claude/*` may select the Claude Code backend on this machine.
 *
 * Files first, then the session-only value pi-subagents published, then the
 * default. The files decide because they are what the spawn reads; the published
 * value covers the one state a file cannot express, a setting applied but not
 * saved.
 */
export function isClaudeCodeEnabled(cwd: string | undefined): boolean {
	return (fileClaudeCode(cwd) ?? publishedClaudeCode) !== false;
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

interface RegistryRef {
	find(provider: string, id: string): Model<Api> | undefined;
	getAvailable?(): { provider: string; id: string }[];
	getAll?(): { provider: string; id: string }[];
}

/**
 * Whether the registry knows a provider literally named `claude`.
 *
 * A user-defined provider with that name owns `claude/*` specs; the Claude Code
 * backend only claims them when nothing else answers to the prefix. Mirrors
 * pi-subagents' own `resolveModel`, which is what actually executes the spawn —
 * if the two disagreed, `/advisor` would report one model and the run would use
 * another.
 */
function registryHasClaudeProvider(all: { provider: string }[]): boolean {
	return all.some((m) => m?.provider?.toLowerCase() === "claude");
}

/**
 * Whether the registry defines a provider literally named `claude`.
 *
 * A user-defined provider with that name owns `claude/*` specs; the Claude Code
 * backend only claims them when nothing else answers to the prefix. Exported so
 * the selection can blame the switch only when the switch is actually involved.
 */
export function registryOwnsClaudePrefix(ctx: ExtensionContext): boolean {
	const registry = ctx.modelRegistry as unknown as RegistryRef;
	const all = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
	return registryHasClaudeProvider(all);
}

/**
 * Resolve a `/subagents` model default to a model. A `claude/*` spec is answered
 * before the registry is consulted — no entry will ever exist for it, because
 * the run is executed by the external `claude` CLI rather than a pi session, so
 * treating it as an unknown registry model reports a working setup as stale.
 *
 * Everything else: exact `provider/modelId` first (what the picker writes), then
 * a bare-id match, so a hand-written alias still works. Undefined when it does
 * not resolve — callers report it as stale rather than failing the tool.
 */
export function resolveSubagentDefaultModel(
	input: string | undefined,
	ctx: ExtensionContext,
): Model<Api> | undefined {
	if (!input) return undefined;
	const registry = ctx.modelRegistry as unknown as RegistryRef;
	const all = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
	if (isClaudeCodeModelSpec(input) && !registryHasClaudeProvider(all) && isClaudeCodeEnabled(ctx.cwd)) {
		return createClaudeCodeModel(input);
	}
	const slash = input.indexOf("/");
	if (slash > 0) {
		const found = registry.find(input.slice(0, slash), input.slice(slash + 1));
		if (found) return found;
	}
	const match = all.find((m) => m.id === input || `${m.provider}/${m.id}` === input);
	return match ? registry.find(match.provider, match.id) : undefined;
}
