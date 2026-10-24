/**
 * messages — advisor vocabulary: tool identity, selector sentinels, effort
 * levels, UI labels, and every user-facing string (static + parameterized).
 * Pure declarations, no logic; consumed across the advisor/ modules.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { isClaudeCodeModel } from "./claude-code.js";

// Tool identity
export const ADVISOR_TOOL_NAME = "advisor";
export const TOOL_LABEL = "Advisor";

// Agent identity — the pi-subagents profiles the two stages spawn. The compressor
// distils the branch into a question-targeted packet; the advisor reviews it. Both
// constants live here so the agent vocabulary has a single home.
export const ADVISOR_AGENT_TYPE = "rpiv-advisor";
export const COMPRESSOR_AGENT_TYPE = "rpiv-compressor";
export const COMPRESSOR_LABEL = "Compressor";

// The advisor tool's one required parameter. The primary model states the focal
// question; without it the compressor has nothing to target.
export const QUESTION_PARAM = "question";

// Effort levels. GradedEffort is the ordinal's domain: the graded levels only,
// never "off" — an "off" element would corrupt the indexOf ranking that
// minEffort thresholds compare against. Today pi-ai's ThinkingLevel already
// excludes "off" (the Exclude is a defensive no-op); the alias keeps that
// exclusion structural if the upstream universe ever re-widens.
export type GradedEffort = Exclude<ThinkingLevel, "off">;
export const EFFORT_ORDINAL: readonly GradedEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

// Messages (static)
export const MSG_ADVISOR_DISABLED = "Advisor disabled";
export const MSG_REQUIRES_INTERACTIVE = "/advisor requires interactive mode";
export const MSG_ADVISOR_NUDGE = "Please advise on the executor's situation above.";
export const MSG_ADVISOR_UNCONFIGURED =
	"No advisor model is configured. Set one in /subagents (agentOverrides → rpiv-advisor).";

// Status report (/advisor). Both stages are named because a compressor you
// cannot see is a compressor you forget is driving the payload.
export const MSG_STATUS_DISABLED = "disabled in /subagents";
export const MSG_STATUS_UNCONFIGURED = "not configured — set it in /subagents";
export const MSG_STATUS_HINT = "models and reasoning levels live in /subagents";
export const msgStageUnavailable = (key: string) => `${key} (not in the model registry)`;
export const msgStageBackendDisabled = (key: string) =>
	`${key} (Claude Code backend disabled — pick a provider model, or turn it back on in /agents → Settings)`;
export const msgStageStatus = (label: string, state: string, effort: ThinkingLevel | undefined) =>
	`${label}: ${state}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorStatus = (advisor: string, compressor: string, inactive: boolean) =>
	`${advisor} • ${compressor}${inactive ? " (inactive for current executor)" : ""}`;

/**
 * How a resolved stage is named in every report. pi models keep the plugin's
 * `provider:id` form; a `claude/*` backend keeps its slash spec, because that is
 * the only spelling it has — `claude:opus` is what nothing else will accept, and
 * the value the user sets in /subagents is `claude/opus`.
 */
export const modelLabel = (model: { provider: string; id: string; claudeCodeBackend?: boolean }) =>
	isClaudeCodeModel(model) ? `${model.provider}/${model.id}` : `${model.provider}:${model.id}`;

// Errors (static)
export const ERR_NO_MODEL =
	"No advisor model is configured. The user can set one in /subagents (agentOverrides → rpiv-advisor).";
export const ERR_NO_COMPRESSOR =
	"No compressor model is configured, so the advisor context cannot be built. Set one in /subagents (agentOverrides → rpiv-compressor).";
export const ERR_ADVISOR_DISABLED =
	"The advisor is switched off in /subagents (agentOverrides → rpiv-advisor → enabled = false). Re-enable it there to use advisor().";
export const ERR_ADVISOR_DISABLED_DETAIL = "advisor disabled in /subagents";
export const ERR_NO_COMPRESSOR_DETAIL = "no compressor model selected";
export const ERR_QUESTION_REQUIRED =
	"advisor() needs a `question`. State the specific decision, assumption, or problem you want reviewed — the reviewer receives a compressed digest of your context plus this question, so a vague call gets vague guidance.";
export const ERR_QUESTION_REQUIRED_DETAIL = "missing question";
export const ERR_CALL_ABORTED = "Advisor call was cancelled before it completed.";
export const ERR_EMPTY_RESPONSE = "Advisor returned no text content.";
export const ERR_NO_MODEL_SELECTED = "no advisor model selected";
export const ERR_EMPTY_RESPONSE_DETAIL = "empty response";
export const ERR_ABORTED_DETAIL = "aborted";
export const ERR_UNKNOWN = "unknown error";

// Errors/messages (parameterized)
export const errMisconfigured = (label: string, err: string) => `Advisor (${label}) is misconfigured: ${err}`;
export const errNoApiKey = (label: string) => `Advisor (${label}) has no API key available.`;
export const errNoApiKeyDetail = (provider: string) => `no API key for ${provider}`;
export const errCallFailed = (err: string | undefined) => `Advisor call failed: ${err ?? ERR_UNKNOWN}`;
export const errCallThrew = (msg: string) => `Advisor call threw: ${msg}`;
export const errModelUnavailable = (key: string) => `Previously configured advisor model ${key} is no longer available`;
export const errBackendDisabled = (key: string) =>
	`Advisor model ${key} runs on the Claude Code CLI, which is disabled on this machine (claudeCode: false in subagents.json — /agents → Settings → Claude Code). Set rpiv-advisor to a provider model in /subagents — the same Claude models are usually reachable there through Copilot or Anthropic — or turn the backend back on.`;
export const errCompressorBackendDisabled = (key: string) =>
	`Compressor model ${key} runs on the Claude Code CLI, which is disabled on this machine (claudeCode: false in subagents.json — /agents → Settings → Claude Code), so the advisor context cannot be built. Set rpiv-compressor to a provider model in /subagents, or turn the backend back on.`;
export const ERR_BACKEND_DISABLED_DETAIL = "claude code backend disabled";
export const msgAdvisorRestored = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorRestoredInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
export const msgConsulting = (label: string, effort: ThinkingLevel | undefined) =>
	`Consulting advisor (${label}${effort ? `, ${effort}` : ""})…`;
export const msgCompressing = (label: string, effort: ThinkingLevel | undefined) =>
	`Compressing context (${COMPRESSOR_LABEL}: ${label}${effort ? `, ${effort}` : ""})…`;
// Restore-time variants. Both stages are reported, and the compressor is named
// even when it is missing, because "no compressor configured" is the difference
// between an advisor() call that works and one that refuses — silently omitting
// it would leave the user guessing why the tool errors.
const compressorPart = (label: string, effort: ThinkingLevel | undefined) =>
	`Compressor: ${label}${effort ? `, ${effort}` : ""}`;
const compressorStatus = (label: string | undefined, effort: ThinkingLevel | undefined) =>
	label
		? compressorPart(label, effort)
		: "no compressor configured — advisor() refuses until one is set in /subagents";
export const msgAdvisorRestoredBoth = (
	advisorLabel: string,
	advisorEffort: ThinkingLevel | undefined,
	compressorLabel: string | undefined,
	compressorEffort: ThinkingLevel | undefined,
) =>
	`Advisor restored: ${advisorLabel}${advisorEffort ? `, ${advisorEffort}` : ""} • ${compressorStatus(compressorLabel, compressorEffort)}`;
export const msgAdvisorRestoredBothInactive = (
	advisorLabel: string,
	advisorEffort: ThinkingLevel | undefined,
	compressorLabel: string | undefined,
	compressorEffort: ThinkingLevel | undefined,
) => `${msgAdvisorRestoredBoth(advisorLabel, advisorEffort, compressorLabel, compressorEffort)} (inactive for current executor)`;

// Ground-truth markers (select.ts). Every elision is labelled on purpose: a
// silently shortened tool result reads as "this was the whole output", which
// would have the reviewer reasoning from a false premise. The advisor is also
// told, in its system prompt, that these markers are authoritative.
export const markerPriorAdvisor = (chars: number) => `[prior advisor consultation omitted; ${chars} chars]`;
export const markerOmitted = (chars: number) => `… [+${chars} chars omitted]`;
export const markerSkeletonElided = (messages: number) =>
	`… [${messages} earlier messages elided from this chronology for length — they are covered by the digest above]`;
export const markerCompressorFailed = (err: string) =>
	`_Compression unavailable (${err}). The skeleton below is the complete context._`;
export const markerCompressorPacket = (label: string) =>
	`## Question-targeted digest (compressed by ${label})`;
export const errCompressorFailed = (err: string | undefined) => err ?? ERR_UNKNOWN;
