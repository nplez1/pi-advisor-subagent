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
} from "./messages.js";
import { readSubagentDefault, resolveSubagentDefaultModel } from "./subagent-defaults.js";

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
	const effort = gradedEffortOf(entry.thinking);
	if (effort) stage.effort = effort;
	return stage;
}

export function resolveAdvisorSelection(ctx: ExtensionContext): AdvisorSelection {
	const advisor = resolveStage(ADVISOR_AGENT_TYPE, ctx);
	const compressor = resolveStage(COMPRESSOR_AGENT_TYPE, ctx);
	return { advisor, compressor, disabled: advisor.disabled || compressor.disabled };
}
