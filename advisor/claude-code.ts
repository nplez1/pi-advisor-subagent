/**
 * claude-code — the `claude/*` model spec, and the synthetic pi `Model` that
 * stands in for it.
 *
 * A stage whose `/subagents` model is `claude/opus` (or `claude/sonnet`,
 * `claude/haiku`, `claude/claude-sonnet-4-5-20250929`) is executed by the
 * external `claude` CLI, not by a pi session. No registry entry will ever exist
 * for such a spec — `enabledModels` never lists it, and `models-store.json`
 * claims no provider named `claude` — so resolving it through
 * `ctx.modelRegistry` reports a working configuration as stale.
 *
 * Deliberately a mirror of pi-subagents' `src/claude-code/model.ts`, which owns
 * this contract: the two plugins are installed as independent packages, and
 * this one must stay loadable without pi-subagents' sources on disk. The model
 * string that matters is the one handed to the spawn RPC
 * (`runChildAgent`), and `${provider}/${id}` for these specs is exactly the
 * `claude/opus` that pi-subagents resolves to the backend.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

/** Provider id for the synthetic model. Not a pi provider — nothing serves it. */
export const CLAUDE_CODE_PROVIDER = "claude";

const CLAUDE_CODE_PREFIX = `${CLAUDE_CODE_PROVIDER}/`;

/**
 * Shape test for a raw model string (`"claude/sonnet"`), before any resolution.
 * Requires a non-empty spec, so a bare `"claude/"` is not a CLI request and
 * falls through to the registry, where it fails loudly as an unknown model
 * instead of spawning a CLI whose `--model` is empty.
 */
export function isClaudeCodeModelSpec(input: string | undefined): boolean {
	if (typeof input !== "string") return false;
	const trimmed = input.trim();
	return trimmed.startsWith(CLAUDE_CODE_PREFIX) && trimmed.length > CLAUDE_CODE_PREFIX.length;
}

/**
 * Marker carried by the synthetic model, so the backend is recognized by what
 * this module built rather than by the provider string alone — a user may
 * define a real pi provider named `claude`, and it must not be mistaken for the
 * CLI.
 */
export const CLAUDE_CODE_BACKEND_MARKER = "claudeCodeBackend";

/** Whether a resolved model selects the Claude Code backend. */
export function isClaudeCodeModel(model: { provider?: string; id?: string; claudeCodeBackend?: boolean } | undefined): boolean {
	return model?.provider === CLAUDE_CODE_PROVIDER && model.claudeCodeBackend === true;
}

/**
 * Build the stand-in `Model` for a `claude/*` spec. Fields exist to satisfy
 * pi's `Model` shape rather than to be meaningful: the CLI reports its own usage
 * and pricing, and this object is never handed to a pi session. `reasoning` is
 * true because every current Claude model does, which keeps the effort surfaces
 * from hiding the control pi-subagents maps to `--effort`.
 */
export function createClaudeCodeModel(input: string): Model<Api> {
	const spec = input.trim().slice(CLAUDE_CODE_PREFIX.length);
	// SAFETY: `Model` has no slot for the backend marker, and the marker is what
	// `isClaudeCodeModel` keys on so a user-defined `claude` provider is not
	// mistaken for the CLI. The object is consumed only for provider/id/name.
	return {
		id: spec,
		name: spec,
		api: "anthropic-messages",
		provider: CLAUDE_CODE_PROVIDER,
		[CLAUDE_CODE_BACKEND_MARKER]: true,
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
	} as unknown as Model<Api>;
}
