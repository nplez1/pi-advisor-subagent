/**
 * command — the /advisor slash command. Reads top-down as one four-step pass:
 * advisor model → advisor effort → compressor model → compressor effort, then a
 * single enable (applyEnable).
 *
 * The flow persists once, at the end, so an abandoned run leaves nothing
 * half-configured — which is the point of walking all four steps rather than
 * exposing the compressor as a separate key. Two escapes still behave like the
 * original command: Esc at an *effort* step keeps the model that was just picked
 * and saves it with no explicit effort (announced by MSG_EFFORT_NOT_SET), while
 * Esc at the compressor *model* step aborts the whole run, because the advisor
 * model alone cannot drive a working pipeline.
 *
 * The apply helpers persist before mutating in-memory state — a save failure
 * must never leave memory ahead of disk.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { modelKey } from "@juicesharp/rpiv-config";
import { showAdvisorPicker, showEffortPicker, type PickerStage } from "../advisor-ui.js";
import { saveAdvisorConfig } from "./config.js";
import { reconcileAdvisorTool } from "./handlers.js";
import {
	ADVISOR_TOOL_NAME,
	CHECKMARK,
	DEFAULT_EFFORT,
	EFFORT_ORDINAL,
	errSelectionNotFound,
	type GradedEffort,
	MSG_ADVISOR_DISABLED,
	MSG_EFFORT_NOT_SET,
	MSG_PERSIST_FAILED,
	MSG_REQUIRES_INTERACTIVE,
	MSG_SELECTION_ABANDONED,
	msgAdvisorEnabled,
	msgAdvisorEnabledInactive,
	NO_ADVISOR_LABEL,
	NO_ADVISOR_VALUE,
	NO_COMPRESSOR_LABEL,
	NO_COMPRESSOR_VALUE,
	OFF_VALUE,
	RECOMMENDED_EFFORT_SUFFIX,
} from "./messages.js";
import { isExecutorBlocked } from "./policy.js";
import {
	getAdvisorEffort,
	getAdvisorModel,
	getCompressorEffort,
	getCompressorModel,
	setAdvisorEffort,
	setAdvisorModel,
	setCompressorEffort,
	setCompressorModel,
} from "./state.js";

// Mirror: packages/rpiv-pi/extensions/rpiv-core/rpiv-models/items.ts
// buildModelItems — structural twin kept in a separate package by the
// zero-cross-imports contract; evolve model-picker semantics together.
// `noneValue`/`noneLabel` let the same builder serve the compressor step, whose
// "none" row is a real state (the pipeline refuses) rather than a disable.
function buildModelItems(
	availableModels: Model<Api>[],
	currentKey: string | undefined,
	noneValue: string,
	noneLabel: string,
): SelectItem[] {
	const items: SelectItem[] = availableModels.map((m) => {
		const key = modelKey(m);
		const check = key === currentKey ? CHECKMARK : "";
		return { value: key, label: `${m.name}  (${m.provider})${check}` };
	});
	items.push({
		value: noneValue,
		label: currentKey === undefined ? `${noneLabel}${CHECKMARK}` : noneLabel,
	});
	return items;
}

// Mirror: packages/rpiv-pi/extensions/rpiv-core/rpiv-models/items.ts
// buildEffortItems — same filter-in/map-out shape, different sentinels and
// persist target; evolve level-picker semantics together.
function buildEffortItems(picked: Model<Api>): SelectItem[] {
	// Intersect with EFFORT_ORDINAL (which excludes "off") so the picker can
	// never offer — hence saveAdvisorConfig can never persist — a level that
	// minEffort blocklist comparisons don't rank.
	const levels = getSupportedThinkingLevels(picked).filter((level): level is GradedEffort =>
		EFFORT_ORDINAL.includes(level as GradedEffort),
	);
	return [
		// "off (no reasoning sent)" ≠ /rpiv-models' "off (disable reasoning)":
		// this row sends NO reasoning option; /rpiv-models persists thinking:"off".
		{ value: OFF_VALUE, label: "off (no reasoning sent)" },
		...levels.map((level) => ({
			value: level,
			label: level === DEFAULT_EFFORT ? `${level}${RECOMMENDED_EFFORT_SUFFIX}` : level,
		})),
	];
}

/**
 * Run one effort picker. Returns `undefined` for "off"/no explicit effort, or
 * `null` when the user pressed Esc — the two are different: Esc at an effort
 * step keeps the model selection and saves it without effort, announced by the
 * caller.
 */
async function pickEffort(
	ctx: ExtensionContext,
	picked: Model<Api>,
	current: GradedEffort | undefined,
	stage: PickerStage,
): Promise<GradedEffort | undefined | null> {
	if (!picked.reasoning) return undefined;
	const result = await showEffortPicker(ctx, buildEffortItems(picked), current, DEFAULT_EFFORT, stage);
	if (!result) return null;
	return result === OFF_VALUE ? undefined : (result as GradedEffort);
}

// Disable path — persist BEFORE mutating in-memory state so a save failure
// can't strand "model=undefined + tool still registered". "No advisor" clears
// the whole pipeline: the two models are one coherent unit, and a lingering
// compressor key would only resurface in a state that cannot use it. The strip
// is unconditional-on-presence (no advisor at all), so it stays inline rather
// than routing through reconcileAdvisorTool's blocked-conditional path.
function applyDisable(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!saveAdvisorConfig({})) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setAdvisorModel(undefined);
	setAdvisorEffort(undefined);
	setCompressorModel(undefined);
	setCompressorEffort(undefined);
	const active = pi.getActiveTools();
	if (active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
	}
	ctx.ui.notify(MSG_ADVISOR_DISABLED, "info");
}

// Enable path — persist first, set in-memory state, activate via
// reconcileAdvisorTool (which re-reads the active-tool list post-picker-await),
// and notify. Silent reconcile — the enable/inactive notify is the single
// trailing notify call here.
function applyEnable(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	picked: Model<Api>,
	effort: GradedEffort | undefined,
	compressor: Model<Api> | undefined,
	compressorEffort: GradedEffort | undefined,
): void {
	const saved = saveAdvisorConfig({
		modelKey: modelKey(picked),
		effort,
		compressorModelKey: compressor ? modelKey(compressor) : undefined,
		compressorEffort: compressor ? compressorEffort : undefined,
	});
	if (!saved) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setAdvisorEffort(effort);
	setAdvisorModel(picked);
	setCompressorModel(compressor);
	setCompressorEffort(compressor ? compressorEffort : undefined);

	const blocked = isExecutorBlocked(ctx, pi.getThinkingLevel());
	reconcileAdvisorTool(pi, ctx, { blocked });
	ctx.ui.notify(
		blocked
			? msgAdvisorEnabledInactive(
					modelKey(picked),
					effort,
					compressor ? modelKey(compressor) : "none — advisor() will refuse",
					compressorEffort,
				)
			: msgAdvisorEnabled(
					modelKey(picked),
					effort,
					compressor ? modelKey(compressor) : "none — advisor() will refuse",
					compressorEffort,
				),
		"info",
	);
}

export function registerAdvisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("advisor", {
		description: "Configure the advisor model, its effort, and the compressor model",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}

			const availableModels = ctx.modelRegistry.getAvailable();
			const current = getAdvisorModel();
			const currentKey = current ? modelKey(current) : undefined;

			const choice = await showAdvisorPicker(
				ctx,
				buildModelItems(availableModels, currentKey, NO_ADVISOR_VALUE, NO_ADVISOR_LABEL),
				"advisor",
			);
			if (!choice) return;

			if (choice === NO_ADVISOR_VALUE) {
				applyDisable(pi, ctx);
				return;
			}

			const picked = availableModels.find((m) => modelKey(m) === choice);
			if (!picked) {
				ctx.ui.notify(errSelectionNotFound(choice), "error");
				return;
			}

			// Advisor effort — Esc keeps the model, saving it with no explicit effort.
			const effortChoice = await pickEffort(ctx, picked, getAdvisorEffort(), "advisor");
			if (effortChoice === null) ctx.ui.notify(MSG_EFFORT_NOT_SET, "info");

			// Compressor model — required for the pipeline to run at all, so Esc here
			// abandons the run rather than persisting an advisor model that every call
			// would then refuse to use.
			const currentCompressor = getCompressorModel();
			const compressorChoice = await showAdvisorPicker(
				ctx,
				buildModelItems(
					availableModels,
					currentCompressor ? modelKey(currentCompressor) : undefined,
					NO_COMPRESSOR_VALUE,
					NO_COMPRESSOR_LABEL,
				),
				"compressor",
			);
			if (!compressorChoice) {
				ctx.ui.notify(MSG_SELECTION_ABANDONED, "warning");
				return;
			}

			let compressor: Model<Api> | undefined;
			let compressorEffort: GradedEffort | undefined;
			if (compressorChoice !== NO_COMPRESSOR_VALUE) {
				compressor = availableModels.find((m) => modelKey(m) === compressorChoice);
				if (!compressor) {
					ctx.ui.notify(errSelectionNotFound(compressorChoice), "error");
					return;
				}
				// Compressor effort — same Esc semantics as the advisor's.
				const compressorEffortChoice = await pickEffort(ctx, compressor, getCompressorEffort(), "compressor");
				if (compressorEffortChoice === null) ctx.ui.notify(MSG_EFFORT_NOT_SET, "info");
				else compressorEffort = compressorEffortChoice;
			}

			applyEnable(pi, ctx, picked, effortChoice ?? undefined, compressor, compressorEffort);
		},
	});
}
