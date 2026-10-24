/**
 * restore — session_start restoration. Loads the persisted policy
 * (`disabledForModels`), resolves both stages from `/subagents`, and activates
 * the tool when the pipeline is usable, announcing once per process.
 *
 * There is no in-memory selection to restore any more: the model and effort for
 * both stages are read from `agentOverrides` wherever they are needed
 * (selection.ts), so `session_start` only decides whether the tool is active and
 * reports what it resolved. A mid-session `/subagents` change therefore reaches
 * the next advisor() call without this hook having run again.
 *
 * The two stages are resolved independently, and a missing compressor does NOT
 * strip the tool. The advisor() call itself refuses with ERR_NO_COMPRESSOR, and
 * that refusal is the only place the executor learns what to do about it —
 * removing the tool would hide the remedy behind an absence.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAdvisorConfig, validateDisabledForModels } from "./config.js";
import { reconcileAdvisorTool } from "./handlers.js";
import {
	ADVISOR_TOOL_NAME,
	MSG_ADVISOR_DISABLED,
	MSG_ADVISOR_UNCONFIGURED,
	errBackendDisabled,
	errModelUnavailable,
	modelLabel,
	msgAdvisorRestoredBoth,
	msgAdvisorRestoredBothInactive,
} from "./messages.js";
import { isExecutorBlocked, setDisabledForModels } from "./policy.js";
import { describeStage, resolveAdvisorSelection } from "./selection.js";

/**
 * Module-local "already announced" latch. Pi fires `session_start` for every
 * session including programmatic spawns (workflow stages, batch ops, any
 * extension's `newSession` call). The tool-state reconciliation belongs on every
 * fire; the user-facing announcement does NOT — repeating it per stage in a
 * `/wf` run just spams the status line. The latch flips on the first notify and
 * stays set until the module is reloaded (`/reload`) or the process restarts.
 * Test-resettable via `__resetAdvisorAnnounced()`.
 */
let restoreAnnounced = false;

/** Test reset — wired into test/setup.ts `beforeEach`. */
export function __resetAdvisorAnnounced(): void {
	restoreAnnounced = false;
}

export function restoreAdvisorState(ctx: ExtensionContext, pi: ExtensionAPI): void {
	setDisabledForModels(validateDisabledForModels(loadAdvisorConfig().disabledForModels));

	const notifyOnce = (msg: string, level: "info" | "warning" | "error"): void => {
		if (!ctx.hasUI || restoreAnnounced) return;
		ctx.ui.notify(msg, level);
		restoreAnnounced = true;
	};

	const { advisor, compressor } = resolveAdvisorSelection(ctx);

	// Off switch, then the two ways the pipeline can be unusable. `enabled: false`
	// is a deliberate choice and is reported as one; a configured-but-unknown
	// model is a stale setting worth naming; no setting at all means the menu has
	// never been used.
	if (advisor.disabled) {
		reconcileAdvisorTool(pi, ctx, { blocked: true });
		notifyOnce(MSG_ADVISOR_DISABLED, "info");
		return;
	}
	if (!advisor.model) {
		reconcileAdvisorTool(pi, ctx, { blocked: true });
		// A switched-off backend and a key that no longer resolves are both
		// "configured but unusable", and they need different remedies.
		const message =
			advisor.unavailable === "claude-code-disabled" && advisor.modelKey
				? errBackendDisabled(advisor.modelKey)
				: advisor.modelKey
					? errModelUnavailable(advisor.modelKey)
					: MSG_ADVISOR_UNCONFIGURED;
		notifyOnce(message, advisor.modelKey ? "warning" : "info");
		return;
	}

	const advisorLabel = modelLabel(advisor.model);
	// An unusable compressor is still a CONFIGURED compressor: reporting it as
	// unconfigured would send the executor to pick a model it already picked, and
	// hide the switch that is actually stopping it. Same reason the off switch is
	// named rather than described as a missing model.
	const compressorLabel = compressor.disabled
		? undefined
		: compressor.model
			? modelLabel(compressor.model)
			: compressor.modelKey
				? describeStage(compressor)
				: undefined;
	const compressorEffort = compressor.disabled ? undefined : compressor.effort;

	if (isExecutorBlocked(ctx, pi.getThinkingLevel())) {
		reconcileAdvisorTool(pi, ctx, { blocked: true });
		notifyOnce(msgAdvisorRestoredBothInactive(advisorLabel, advisor.effort, compressorLabel, compressorEffort), "info");
		return;
	}

	const active = pi.getActiveTools();
	if (!active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
	}

	notifyOnce(msgAdvisorRestoredBoth(advisorLabel, advisor.effort, compressorLabel, compressorEffort), "info");
}

export function registerAdvisorSessionStart(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		restoreAdvisorState(ctx, pi);
	});
}
