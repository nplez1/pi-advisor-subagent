/**
 * config — persisted advisor policy (~/.config/rpiv-advisor/advisor.json).
 * Owns the two things pi-subagents' `agentOverrides` cannot express:
 *
 *   guidance            — the tool's promptSnippet / promptGuidelines overrides
 *   disabledForModels   — the executor blocklist and its effort thresholds
 *
 * The model and reasoning selections are NOT here. They belong to
 * `agentOverrides` in subagents.json, written by `/subagents` and read by
 * selection.ts, so a stage has exactly one configurable home. Legacy
 * `modelKey` / `compressorModelKey` / `effort` / `compressorEffort` keys are
 * ignored on read; install.sh migrates them into agentOverrides once and then
 * deletes them.
 *
 * The provider:id key codec (`modelKey` / `parseModelKey`) now lives only where
 * it is used: selection.ts for resolution and messages for the blocklist.
 */

import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { loadJsonConfigWithLegacyFallback } from "@juicesharp/rpiv-config";
import { EFFORT_ORDINAL, type GradedEffort } from "./messages.js";

export type DisabledForModelsEntry = string | { model: string; minEffort?: GradedEffort };

interface AdvisorConfig {
	guidance?: GuidanceFields;
	disabledForModels?: DisabledForModelsEntry[];
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
 * the provider. Kept for the blocklist's `minEffort` comparisons.
 */
export function validateEffort(value: unknown, field: string): GradedEffort | undefined {
	if (value === undefined) return undefined;
	if (EFFORT_ORDINAL.includes(value as GradedEffort)) return value as GradedEffort;
	console.warn(
		`[rpiv-advisor] advisor.json: unknown ${field} "${String(value)}" — ignoring (valid values: ${EFFORT_ORDINAL.join(", ")})`,
	);
	return undefined;
}
