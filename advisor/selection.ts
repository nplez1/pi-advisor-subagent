/**
 * selection — the advisor pipeline's resolved configuration.
 *
 * `subagents.json` → `agentOverrides` is the ONLY place these selections live,
 * for both stages. `/subagents` writes it; this module reads it and nothing
 * else persists a model, so "what /subagents shows" and "what the advisor runs
 * on" cannot drift — there is one store and one writer, not two stores with a
 * precedence rule or a sync step.
 *
 * `advisor.json` still owns what `/subagents` cannot express: `guidance` and the
 * `disabledForModels` blocklist (policy.ts). Its legacy `modelKey` /
 * `compressorModelKey` / `effort` / `compressorEffort` keys are ignored here;
 * install.sh migrates them once and deletes them.
 *
 * Resolution is live rather than cached on purpose: a mid-session change in
 * `/subagents` has to apply to the next advisor() call, and a module-level cache
 * is exactly the thing that would silently disagree with the menu.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ADVISOR_AGENT_TYPE,
	COMPRESSOR_AGENT_TYPE,
	EFFORT_ORDINAL,
	type GradedEffort,
	MSG_STATUS_DISABLED,
	MSG_STATUS_UNCONFIGURED,
	modelLabel,
	msgStageBackendDisabled,
	msgStageUnavailable,
} from "./messages.js";
import {
	readSubagentDefault,
	isClaudeCodeEnabled,
	registryOwnsClaudePrefix,
	resolveSubagentDefaultModel,
} from "./subagent-defaults.js";
import { isClaudeCodeModelSpec } from "./claude-code.js";

/** One stage's resolved setting. Shared shape: both stages configure alike. */
export interface StageSelection {
	/** The resolved model, absent when unset or no longer in the registry. */
	model?: Model<Api>;
	/** The graded effort, absent when unset or configured as `off`. */
	effort?: GradedEffort;
	/** The configured `provider/modelId` (or alias), for messages. */
	modelKey?: string;
	/** `enabled: false` in agentOverrides — the off switch. */
	disabled: boolean;
	/**
	 * Why a configured `modelKey` did not resolve, when it did not. The two causes
	 * need different remedies — a stale key versus a backend switched off on this
	 * machine — so they are distinguished here rather than at each report.
	 */
	unavailable?: "registry" | "claude-code-disabled";
}

export interface AdvisorSelection {
	advisor: StageSelection;
	compressor: StageSelection;
	/** True when either stage is switched off; the pipeline needs both. */
	disabled: boolean;
}

/**
 * A `/subagents` thinking level in this pipeline's effort vocabulary.
 *
 * `off` means "send no reasoning option", which is the same thing an unset
 * level does here — the pipeline ranks efforts with EFFORT_ORDINAL, which
 * deliberately excludes `off` because it is not a level to compare against a
 * `minEffort` threshold. Both therefore resolve to `undefined` rather than
 * being forwarded as an unrankable value.
 */
function gradedEffortOf(thinking: string | undefined): GradedEffort | undefined {
	if (thinking === undefined) return undefined;
	return EFFORT_ORDINAL.includes(thinking as GradedEffort) ? (thinking as GradedEffort) : undefined;
}

function resolveStage(agentType: string, ctx: ExtensionContext): StageSelection {
	const entry = readSubagentDefault(agentType, ctx.cwd);
	const stage: StageSelection = { disabled: entry.enabled === false };
	if (entry.model !== undefined) stage.modelKey = entry.model;
	const model = resolveSubagentDefaultModel(entry.model, ctx);
	if (model) stage.model = model;
	else if (stage.modelKey) {
		// A `claude/*` spec can fail for two reasons and only one of them is the
		// switch: when a registry provider named `claude` owns the prefix, the
		// switch plays no part in this spec failing to resolve.
		const backendOff =
			isClaudeCodeModelSpec(stage.modelKey) &&
			!registryOwnsClaudePrefix(ctx) &&
			!isClaudeCodeEnabled(ctx.cwd);
		stage.unavailable = stage.disabled ? undefined : backendOff ? "claude-code-disabled" : "registry";
	}
	const effort = gradedEffortOf(entry.thinking);
	if (effort) stage.effort = effort;
	return stage;
}

/**
 * How one stage reads in any report.
 *
 * One function because `/advisor` and the session-start notice must not phrase
 * the same state differently: a stage that is off, unset, stale, or blocked by a
 * switched-off backend needs its own words and its own remedy.
 */
export function describeStage(stage: StageSelection): string {
	if (stage.disabled) return MSG_STATUS_DISABLED;
	if (stage.model) return modelLabel(stage.model);
	// A configured but unusable model is not an empty one; naming the key is what
	// lets the report point at the row to fix.
	if (stage.unavailable === "claude-code-disabled") return msgStageBackendDisabled(stage.modelKey ?? "");
	if (stage.modelKey) return msgStageUnavailable(stage.modelKey);
	return MSG_STATUS_UNCONFIGURED;
}

export function resolveAdvisorSelection(ctx: ExtensionContext): AdvisorSelection {
	const advisor = resolveStage(ADVISOR_AGENT_TYPE, ctx);
	const compressor = resolveStage(COMPRESSOR_AGENT_TYPE, ctx);
	return { advisor, compressor, disabled: advisor.disabled || compressor.disabled };
}
