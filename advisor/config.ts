/**
 * config — persisted advisor config (~/.config/rpiv-advisor/advisor.json) and
 * the provider:id key codec. Owns the AdvisorConfig shape and load/validate/save.
 * The modelKey (join) / parseModelKey (split) inverse pair the codec relies on
 * lives in @juicesharp/rpiv-config.
 */

import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { configPath, loadJsonConfigWithLegacyFallback, saveJsonConfig } from "@juicesharp/rpiv-config";
import { EFFORT_ORDINAL, type GradedEffort } from "./messages.js";

const ADVISOR_CONFIG_PATH = configPath("rpiv-advisor", "advisor.json");

export type DisabledForModelsEntry = string | { model: string; minEffort?: GradedEffort };

interface AdvisorConfig {
	modelKey?: string;
	effort?: GradedEffort;
	compressorModelKey?: string;
	compressorEffort?: GradedEffort;
	guidance?: GuidanceFields;
	disabledForModels?: DisabledForModelsEntry[];
}

/**
 * One complete /advisor selection. The four-step flow always writes all four
 * fields together, but every field is independently optional: an absent key is
 * persisted as absent (deleted), never as a stale leftover.
 */
export interface AdvisorSelection {
	modelKey?: string;
	effort?: GradedEffort;
	compressorModelKey?: string;
	compressorEffort?: GradedEffort;
}

export function loadAdvisorConfig(): AdvisorConfig {
	return loadJsonConfigWithLegacyFallback<AdvisorConfig>("rpiv-advisor", "advisor.json");
}

export function validateDisabledForModels(value: unknown): DisabledForModelsEntry[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is DisabledForModelsEntry => {
		if (typeof entry === "string") return entry.length > 0;
		if (typeof entry !== "object" || entry === null) return false;
		const obj = entry as Record<string, unknown>;
		if (typeof obj.model !== "string" || obj.model.length === 0) return false;
		if (obj.minEffort !== undefined && !EFFORT_ORDINAL.includes(obj.minEffort as GradedEffort)) {
			// Warn before dropping — the entry's model identity is discarded along
			// with the bad threshold (mirrors models-config's warn-on-miss posture).
			console.warn(
				`[rpiv-advisor] advisor.json: unknown minEffort "${String(obj.minEffort)}" — dropping disabledForModels entry for "${obj.model}"`,
			);
			return false;
		}
		return true;
	});
}

/**
 * Drop a hand-edited effort value the ordinal cannot rank, warning rather than
 * restoring it — an unknown level would be sent as `reasoning` and rejected by
 * the provider. Shared by the advisor and compressor keys so both degrade the
 * same way in the face of a hand-edited advisor.json.
 */
export function validateEffort(value: unknown, field: string): GradedEffort | undefined {
	if (value === undefined) return undefined;
	if (EFFORT_ORDINAL.includes(value as GradedEffort)) return value as GradedEffort;
	console.warn(
		`[rpiv-advisor] advisor.json: unknown ${field} "${String(value)}" — ignoring (valid values: ${EFFORT_ORDINAL.join(", ")})`,
	);
	return undefined;
}

export function saveAdvisorConfig(selection: AdvisorSelection): boolean {
	const existing = loadAdvisorConfig();
	const config: AdvisorConfig = { ...existing };
	// Delete (rather than omit) to clear fields that may exist in the spread
	// from a prior read. JSON.parse always produces configurable properties,
	// so delete is safe in strict mode.
	if (selection.modelKey) config.modelKey = selection.modelKey;
	else delete config.modelKey;
	if (selection.effort) config.effort = selection.effort;
	else delete config.effort;
	if (selection.compressorModelKey) config.compressorModelKey = selection.compressorModelKey;
	else delete config.compressorModelKey;
	if (selection.compressorEffort) config.compressorEffort = selection.compressorEffort;
	else delete config.compressorEffort;
	return saveJsonConfig(ADVISOR_CONFIG_PATH, config);
}
