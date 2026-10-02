/**
 * register — the advisor tool registration: the question parameter, curated
 * description / promptSnippet / promptGuidelines, and an execute that delegates
 * to executeAdvisor. The guidance overrides are read from persisted config.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateGuidanceFields } from "@juicesharp/rpiv-config";
import { Type } from "typebox";
import { loadAdvisorConfig } from "./config.js";
import { executeAdvisor } from "./execute.js";
import { renderAdvisorToolResult } from "./render.js";
import { ADVISOR_TOOL_NAME, QUESTION_PARAM, TOOL_LABEL } from "./messages.js";

const AdvisorParams = Type.Object({
	[QUESTION_PARAM]: Type.String({
		description:
			"The specific decision, assumption, or problem you want reviewed, in one or two sentences. " +
			"The reviewer's context is compressed down to a digest aimed at this question, so state any " +
			"detail that must be weighed (an exact error, a value, a file and line) here rather than " +
			"assuming it survives compression.",
	}),
});

const ADVISOR_DESCRIPTION =
	"Escalate to a stronger reviewer model for guidance. When you need stronger " +
	"judgment — a complex decision, an ambiguous failure, a problem you're circling " +
	"without progress — escalate to the advisor model, then resume. Pass `question`: " +
	"the specific thing you want reviewed. A cheaper compressor model reads your " +
	"conversation and writes a digest aimed at that question; the reviewer receives " +
	"that digest plus your user's messages, your recent turns, and a one-line " +
	"chronology of everything older. The reviewer does NOT see your raw transcript.";

export const DEFAULT_PROMPT_SNIPPET =
	"Escalate to a stronger reviewer model with a specific `question` when stuck, before substantive work, or before declaring done";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Pass a specific `question` to `advisor` — the decision, assumption, or failure you want reviewed, in a sentence or two. The reviewer gets a compressed digest of your context aimed at that question, plus your user's messages verbatim, your recent turns, and a one-line chronology of everything older. It does NOT see the raw transcript, so if a particular detail must be weighed (an exact error string, a value, a file and line), put it in the question.",
	"Call `advisor` BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. Orientation (finding files, fetching a source, seeing what's there) is not substantive work; writing, editing, and declaring an answer are.",
	"Also call `advisor` when you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.",
	"Also call `advisor` when stuck — errors recurring, approach not converging, results that don't fit — or when considering a change of approach.",
	"On tasks longer than a few steps, call `advisor` at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.",
	"Give the advisor's advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt — a passing self-test is not evidence the advice is wrong, it's evidence your test doesn't check what the advice is checking.",
	"If you've already retrieved data pointing one way and the advisor points another, don't silently switch — surface the conflict in one more `advisor` call (\"I found X, you suggest Y, which constraint breaks the tie?\"). A reconcile call is cheaper than committing to the wrong branch.",
	"After each `advisor` result, put the advisor's key guidance into your next visible reply to the user before continuing — quote or paraphrase the plan, correction, or stop signal. The full result is visible in the TUI, but a concise synthesis in your reply makes the next action clear.",
];

export function registerAdvisorTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadAdvisorConfig().guidance);
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: TOOL_LABEL,
		description: ADVISOR_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: AdvisorParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeAdvisor(ctx, pi, params as { question?: string }, signal, onUpdate);
		},

		// Show the completed guidance even when Pi has the tool result collapsed.
		// The child is also available in FleetView for live progress and details.
		renderResult(result, { isPartial }, _theme, _context) {
			return renderAdvisorToolResult(result, isPartial);
		},
	});
}
