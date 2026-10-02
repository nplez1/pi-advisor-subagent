/**
 * state — in-memory selection for both stages of the advisor pipeline: the
 * advisor model itself and the compressor model that distils the branch before
 * the advisor sees it. Resets each session; the persisted form lives in
 * config.ts, the blocklist cache in policy.ts.
 *
 * Both selections are module-level and intentionally symmetric: the compressor
 * is configured exactly like the advisor (picker → persist → restore), so it
 * gets the same getter/setter pair rather than a second-class config lookup.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { GradedEffort } from "./messages.js";

let selectedAdvisor: Model<Api> | undefined;
let selectedAdvisorEffort: GradedEffort | undefined;
let selectedCompressor: Model<Api> | undefined;
let selectedCompressorEffort: GradedEffort | undefined;

export function getAdvisorModel(): Model<Api> | undefined {
	return selectedAdvisor;
}

export function setAdvisorModel(model: Model<Api> | undefined): void {
	selectedAdvisor = model;
}

export function getAdvisorEffort(): GradedEffort | undefined {
	return selectedAdvisorEffort;
}

export function setAdvisorEffort(effort: GradedEffort | undefined): void {
	selectedAdvisorEffort = effort;
}

export function getCompressorModel(): Model<Api> | undefined {
	return selectedCompressor;
}

export function setCompressorModel(model: Model<Api> | undefined): void {
	selectedCompressor = model;
}

export function getCompressorEffort(): GradedEffort | undefined {
	return selectedCompressorEffort;
}

export function setCompressorEffort(effort: GradedEffort | undefined): void {
	selectedCompressorEffort = effort;
}
