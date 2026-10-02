/**
 * restore — session_start restoration. Loads persisted config, re-applies both
 * model selections (advisor and compressor) plus the blocklist, activates the
 * tool when not blocked, and announces once per process. Wired via
 * registerAdvisorSessionStart.
 *
 * The two models are resolved independently, and a missing compressor does NOT
 * strip the tool. The advisor() call itself refuses with ERR_NO_COMPRESSOR, and
 * that refusal is the only place the executor learns what to do about it —
 * removing the tool would hide the remedy behind an absence.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey, parseModelKey } from "@juicesharp/rpiv-config";
import { loadAdvisorConfig, validateDisabledForModels, validateEffort } from "./config.js";
import { reconcileAdvisorTool } from "./handlers.js";
import {
	ADVISOR_TOOL_NAME,
	errModelUnavailable,
	msgAdvisorRestoredBoth,
	msgAdvisorRestoredBothInactive,
} from "./messages.js";
import { isExecutorBlocked, setDisabledForModels } from "./policy.js";
import { setAdvisorEffort, setAdvisorModel, setCompressorEffort, setCompressorModel } from "./state.js";

/**
 * Module-local "already announced" latch. Pi fires `session_start` for every
 * session including programmatic spawns (workflow stages, batch ops, any
 * extension's `newSession` call). State mutation belongs on every fire;
 * the user-facing announcement does NOT — repeating it per stage in a
 * `/wf` run just spams the status line. The latch flips on the first
 * notify and stays set until the module is reloaded (`/reload`) or the
 * process restarts. Test-resettable via `__resetAdvisorAnnounced()`.
 */
let restoreAnnounced = false;

/** Test reset — wired into test/setup.ts `beforeEach`. */
export function __resetAdvisorAnnounced(): void {
	restoreAnnounced = false;
}

export function restoreAdvisorState(ctx: ExtensionContext, pi: ExtensionAPI): void {
	const config = loadAdvisorConfig();

	setDisabledForModels(validateDisabledForModels(config.disabledForModels));

	// No usable advisor model → clear in-memory selection, then strip the tool
	// (and its prompt block) from the active set. Clearing state mirrors the
	// /advisor disable path (command.ts applyDisable): the selections are
	// module-level and persist across session_start fires, so leaving them stale
	// would let the per-turn before_agent_start strip read a truthy model and
	// re-add the very tool we just stripped (e.g. a configured model removed
	// from the registry mid-process). The tool is registered active-by-default
	// at load, so its promptSnippet/promptGuidelines otherwise linger in the
	// base system prompt even though every advisor() call would fail with
	// ERR_NO_MODEL. See issue #72.
	const deactivate = (): void => {
		setAdvisorModel(undefined);
		setAdvisorEffort(undefined);
		setCompressorModel(undefined);
		setCompressorEffort(undefined);
		reconcileAdvisorTool(pi, ctx, { blocked: true });
	};

	if (!config.modelKey) {
		deactivate();
		return;
	}

	const parsed = parseModelKey(config.modelKey);
	if (!parsed) {
		deactivate();
		return;
	}

	const notifyOnce = (msg: string, level: "info" | "warning" | "error"): void => {
		if (!ctx.hasUI || restoreAnnounced) return;
		ctx.ui.notify(msg, level);
		restoreAnnounced = true;
	};

	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		deactivate();
		notifyOnce(errModelUnavailable(config.modelKey), "warning");
		return;
	}

	setAdvisorModel(model);
	// Overwrite — never merge — the in-memory effort with the persisted value.
	// "Model present, effort absent" is a first-class persisted state (the
	// /advisor Esc and off choices both save it), and another process can
	// remove the field from the shared advisor.json mid-session; a guarded set
	// here would leave a stale module-level effort feeding `reasoning` on every
	// advisor call. A hand-edited value unknown to EFFORT_ORDINAL is dropped
	// with a warning rather than restored and sent as `reasoning`.
	const effort = validateEffort(config.effort, "effort");
	setAdvisorEffort(effort);

	// The compressor is resolved independently: a missing or stale compressor
	// does not strip the tool, because the refusal at call time is what tells the
	// executor to configure one.
	let compressorLabel: string | undefined;
	let compressorEffort = config.compressorEffort;
	if (config.compressorModelKey) {
		const parsedCompressor = parseModelKey(config.compressorModelKey);
		const compressor = parsedCompressor
			? ctx.modelRegistry.find(parsedCompressor.provider, parsedCompressor.modelId)
			: undefined;
		if (compressor) {
			setCompressorModel(compressor);
			compressorLabel = modelKey(compressor);
			compressorEffort = validateEffort(config.compressorEffort, "compressorEffort");
			setCompressorEffort(compressorEffort);
		} else {
			setCompressorModel(undefined);
			setCompressorEffort(undefined);
			compressorEffort = undefined;
			console.warn(
				`[rpiv-advisor] advisor.json: compressor model ${config.compressorModelKey} is not in the registry — advisor() will refuse until /advisor selects one`,
			);
		}
	} else {
		setCompressorModel(undefined);
		setCompressorEffort(undefined);
		compressorEffort = undefined;
	}

	if (isExecutorBlocked(ctx, pi.getThinkingLevel())) {
		reconcileAdvisorTool(pi, ctx, { blocked: true });
		notifyOnce(msgAdvisorRestoredBothInactive(modelKey(model), effort, compressorLabel, compressorEffort), "info");
		return;
	}

	const active = pi.getActiveTools();
	if (!active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
	}

	notifyOnce(msgAdvisorRestoredBoth(modelKey(model), effort, compressorLabel, compressorEffort), "info");
}

export function registerAdvisorSessionStart(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		restoreAdvisorState(ctx, pi);
	});
}
