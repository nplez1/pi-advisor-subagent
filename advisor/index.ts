/**
 * advisor — Advisor-strategy pattern: a zero-param `advisor` tool + `/advisor`
 * command that forward the serialized conversation branch to a separately-
 * configured reviewer model. Advisor has no tools, never emits user-facing
 * output, and returns guidance the executor resumes with.
 *
 * The implementation is one concern per file under this directory; this barrel
 * re-exports the package's public surface (consumed by ../index.ts, the repo-
 * root test/setup.ts, and the advisor.*.test.ts suite via "./advisor/index.js").
 *
 * Module map:
 *   messages   — tool identity, sentinels, effort vocabulary, all strings
 *   config     — persisted policy (guidance + disabledForModels)
 *   selection  — the resolved model/effort/enabled for both stages, from /subagents
 *   subagent-defaults — reads pi-subagents' agentOverrides (+ the claudeCode switch)
 *   claude-code — the `claude/*` backend spec and its synthetic model
 *   policy     — disabledForModels blocklist + blocked predicates
 *   inventory  — globalThis tool-inventory cache + serializer
 *   context    — branch-message massaging
 *   select     — deterministic ground truth: user asks, recent window, skeleton
 *   prompt     — system-prompt loaders for both stages
 *   subagent   — the pi-subagents RPC runner both stages share
 *   compress   — the digest stage
 *   payload    — assembles what the reviewer actually receives
 *   execute    — the two-stage advisor side-call
 *   register   — advisor tool registration
 *   handlers   — mid-session lifecycle handlers
 *   restore    — session_start activation and the startup report
 *   command    — /advisor status report (models are set in /subagents)
 */

export { registerAdvisorCommand } from "./command.js";
export { loadAdvisorConfig, validateDisabledForModels, validateEffort } from "./config.js";
export { ensureUserTailForAdvisor, stripInflightAdvisorCall } from "./context.js";
export {
	registerAdvisorBeforeAgentStart,
	registerClaudeCodeSettingSync,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
} from "./handlers.js";
export { getInventoryMessage, stableStringify } from "./inventory.js";
export { ADVISOR_TOOL_NAME, COMPRESSOR_AGENT_TYPE } from "./messages.js";
export { buildAdvisorPayload } from "./payload.js";
export { setDisabledForModels } from "./policy.js";
export { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET, registerAdvisorTool } from "./register.js";
export { __resetAdvisorAnnounced, registerAdvisorSessionStart, restoreAdvisorState } from "./restore.js";
export {
	buildGroundTruth,
	buildRecentWindow,
	buildSkeleton,
	buildUserRequests,
	isPriorAdvisorResult,
} from "./select.js";
export { clearPublishedClaudeCode, setClaudeCodeFromSettings } from "./subagent-defaults.js";
export { describeStage, resolveAdvisorSelection, type AdvisorSelection, type StageSelection } from "./selection.js";
export { runChildAgent, serializeTranscript } from "./subagent.js";
