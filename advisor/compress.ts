/**
 * compress — the digest stage. Turns the executor's full branch into a short,
 * question-targeted packet for the premium reviewer.
 *
 * This is where the cost saving comes from: the bulky branch is read once by the
 * configured compressor model instead of by the advisor on every call. It is
 * also the pipeline's single point of failure, so nothing here throws — a
 * failure returns `{ error }` and the caller degrades to the deterministic
 * ground truth rather than erroring the tool call.
 *
 * The compressor reads the whole transcript and is trusted to *select*. It is
 * not trusted to be *complete*: the caller attaches the ground truth computed by
 * select.ts independently, so an omission here cannot hide the evidence of the
 * executor's own mistake from the reviewer.
 */

import type { Api, Message, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMPRESSOR_AGENT_TYPE, ERR_ABORTED_DETAIL, type GradedEffort } from "./messages.js";
import { COMPRESSOR_SYSTEM_PROMPT } from "./prompt.js";
import { RECENT_MESSAGE_COUNT } from "./select.js";
import { runChildAgent, serializeTranscript } from "./subagent.js";

export interface CompressionOutcome {
	/** The digest. Absent when compression failed. */
	packet?: string;
	usage?: Usage;
	error?: string;
	/** Characters of transcript handed to the compressor, for cost telemetry. */
	transcriptChars?: number;
}

/**
 * The executor's question, then an explicit statement of what the reviewer is
 * given independently of the digest. Telling the compressor what the reviewer
 * already has keeps it from spending its output reproducing the recent tail and
 * the user's own words, and aims it at the older material only it can see.
 */
export function buildCompressorRequest(question: string, transcript: string): string {
	return [
		"## The executor's question",
		"",
		question,
		"",
		"## What the reviewer receives independently of you",
		"",
		`Do not reproduce any of this — you would only be duplicating it. The reviewer gets, computed outside your control: every user message verbatim; the last ${RECENT_MESSAGE_COUNT} messages of the transcript verbatim, with long bodies clipped and every clip labelled; a deterministic one-line-per-message chronology of everything older, carrying message indices and tool-call IDs; and the executor's tool inventory.`,
		"",
		"Spend your digest on what that chronology cannot carry: the reasoning behind the approach, the causal chain from evidence to conclusion, conclusions the evidence does not support, and anything older than the recent tail that bears on the question.",
		"",
		"## The transcript",
		"",
		"<transcript-json>",
		transcript,
		"</transcript-json>",
	].join("\n");
}

export async function compressContext(
	pi: ExtensionAPI,
	options: {
		/** Already resolved and credentialed by the caller. */
		model: Model<Api>;
		effort: GradedEffort | undefined;
		question: string;
		messages: Message[];
		signal: AbortSignal | undefined;
		onStarted?: (agentId: string) => void;
	},
): Promise<CompressionOutcome> {
	const transcript = serializeTranscript(options.messages);
	const transcriptChars = transcript.length;
	const prompt = [COMPRESSOR_SYSTEM_PROMPT, buildCompressorRequest(options.question, transcript)].join("\n\n");

	try {
		const result = await runChildAgent(pi, {
			agentType: COMPRESSOR_AGENT_TYPE,
			runLabel: "Context compression",
			model: `${options.model.provider}/${options.model.id}`,
			effort: options.effort,
			prompt,
			signal: options.signal,
			onStarted: options.onStarted,
		});
		if (result.status === "aborted") {
			return { usage: result.usage, error: result.error ?? ERR_ABORTED_DETAIL, transcriptChars };
		}
		if (result.status === "failed") {
			return { usage: result.usage, error: result.error ?? "compression subagent failed", transcriptChars };
		}
		const packet = result.text.trim();
		if (!packet) return { usage: result.usage, error: "compressor returned no text", transcriptChars };
		return { packet, usage: result.usage, transcriptChars };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error), transcriptChars };
	}
}
