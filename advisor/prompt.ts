/**
 * prompt — the system prompts for both pipeline stages, loaded once at module
 * init from prompts/. The URLs are anchored one level up (../prompts/) because
 * this module sits in advisor/ while the assets ship at the package root.
 * ESM-safe, cache-stable.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function load(name: string): string {
	return readFileSync(fileURLToPath(new URL(`../prompts/${name}`, import.meta.url)), "utf-8").trimEnd();
}

/** The reviewer's replacing prompt (profile: prompt_mode: replace). */
export const ADVISOR_SYSTEM_PROMPT = load("advisor-system.txt");

/** The digest stage's replacing prompt (profile: prompt_mode: replace). */
export const COMPRESSOR_SYSTEM_PROMPT = load("compressor-system.txt");
