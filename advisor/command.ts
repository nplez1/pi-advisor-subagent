/**
 * command — the /advisor slash command, now a read-only status report.
 *
 * Model and reasoning selection live in `/subagents` (pi-subagents'
 * `agentOverrides` in subagents.json), which is the single store this plugin
 * reads. This command therefore writes nothing: it reports what the pipeline
 * resolved for each stage, so "what will advisor() actually run on?" is
 * answerable without opening the menu — and cannot disagree with it.
 *
 * The picker was removed rather than repointed at the same store: two editors
 * writing two files need either a sync step or a precedence rule, and both leave
 * room for the reported model to differ from the model used. One store, one
 * writer, no way to drift.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	MSG_REQUIRES_INTERACTIVE,
	MSG_STATUS_DISABLED,
	MSG_STATUS_HINT,
	MSG_STATUS_UNCONFIGURED,
	msgAdvisorStatus,
	msgStageStatus,
	msgStageUnavailable,
} from "./messages.js";
import { isExecutorBlocked } from "./policy.js";
import { resolveAdvisorSelection, type StageSelection } from "./selection.js";

/** How one stage reads in the report. */
function describe(stage: StageSelection): string {
	if (stage.disabled) return MSG_STATUS_DISABLED;
	if (stage.model) return `${stage.model.provider}:${stage.model.id}`;
	// A configured but unknown model is a stale setting, not an empty one; naming
	// the key is what lets the report point at the row to fix.
	if (stage.modelKey) return msgStageUnavailable(stage.modelKey);
	return MSG_STATUS_UNCONFIGURED;
}

export function registerAdvisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("advisor", {
		description: "Report the advisor and compressor models resolved from /subagents",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}

			const selection = resolveAdvisorSelection(ctx);
			const text = msgAdvisorStatus(
				msgStageStatus(
					"Advisor",
					describe(selection.advisor),
					selection.advisor.disabled ? undefined : selection.advisor.effort,
				),
				msgStageStatus(
					"Compressor",
					describe(selection.compressor),
					selection.compressor.disabled ? undefined : selection.compressor.effort,
				),
				isExecutorBlocked(ctx, pi.getThinkingLevel()),
			);
			const level = selection.advisor.disabled || !selection.advisor.model ? "warning" : "info";
			ctx.ui.notify(`${text} • ${MSG_STATUS_HINT}`, level);
		},
	});
}
