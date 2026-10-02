/**
 * payload — assembles what the reviewer actually receives.
 *
 * Structure is deliberate: the question first, then the model-written digest,
 * then the mechanically-computed ground truth, then the assembly notes. The
 * notes exist because the reviewer must know which sections it is allowed to
 * trust when they disagree — the digest is a model's selection and can be wrong
 * or incomplete, while the chronology is derived from the session itself. A
 * reviewer that cannot tell those apart will reason from the digest as if it
 * were the record.
 */

import type { Message } from "@earendil-works/pi-ai";
import { markerCompressorFailed, markerCompressorPacket } from "./messages.js";
import type { GroundTruth } from "./select.js";

export interface PayloadStats {
	/** Total characters handed to the reviewer. */
	chars: number;
	question: number;
	digest: number;
	timeline: number;
	userRequests: number;
	recent: number;
	inventory: number;
}

export interface AdvisorPayload {
	text: string;
	stats: PayloadStats;
	compression: "ok" | "failed";
}

function inventoryText(inventory: Message | undefined): string {
	if (!inventory) return "";
	const content = (inventory as unknown as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => {
			const b = block as { type?: string; text?: string };
			return b.type === "text" && typeof b.text === "string";
		})
		.map((block) => block.text)
		.join("\n");
}

export function buildAdvisorPayload(options: {
	question: string;
	compressorLabel: string;
	/** The digest, when compression succeeded. */
	packet?: string;
	/** Why compression failed, when it did. */
	compressionError?: string;
	groundTruth: GroundTruth;
	inventory: Message | undefined;
}): AdvisorPayload {
	const { question, packet, compressionError, groundTruth, compressorLabel } = options;
	const inventory = inventoryText(options.inventory);
	const compression: "ok" | "failed" = packet ? "ok" : "failed";

	const digestSection = packet
		? `${markerCompressorPacket(compressorLabel)}\n\n${packet}`
		: markerCompressorFailed(compressionError ?? "unknown error");

	const sections: Array<[keyof Omit<PayloadStats, "chars">, string]> = [
		["question", `## Question under review\n\n${question}`],
		["digest", digestSection],
		["timeline", `## Timeline (one line per message)\n\n${groundTruth.skeleton || "(no earlier messages)"}`],
		["userRequests", `## User requests, verbatim and complete\n\n${groundTruth.userRequests || "(none)"}`],
		["recent", `## Recent turns, verbatim\n\n${groundTruth.recent}`],
		["inventory", inventory ? `## Executor tool inventory\n\n${inventory}` : ""],
	];

	const stats: PayloadStats = {
		chars: 0,
		question: 0,
		digest: 0,
		timeline: 0,
		userRequests: 0,
		recent: 0,
		inventory: 0,
	};
	const rendered: string[] = [];
	for (const [key, text] of sections) {
		if (!text) continue;
		stats[key] = text.length;
		stats.chars += text.length;
		rendered.push(text);
	}

	// The assembly notes are the reviewer's licence to distrust the digest. They
	// are appended last so they read as instructions about everything above.
	rendered.push(
		[
			"## How this context was assembled",
			"",
			"- The digest is model-written. It selects what it judged relevant to the question and may be incomplete, imprecise, or wrong about the record. Treat it as a brief to interrogate, not as established fact.",
			"- The Timeline and Recent sections are computed mechanically from the executor's session and are authoritative. Where the digest and the chronology disagree, the chronology is what happened.",
			"- `#12`-style markers are message indices, valid in both the Timeline and the Recent sections. Tool-call IDs are stable.",
			"- `… [+N chars omitted]` marks a clip, not the end of a body — the text resumes after the marker. Nothing is silently shortened.",
			"- The Timeline records actions, results, and prose, but not private reasoning. The executor's internal deliberation appears only where the digest quotes it, so absence of reasoning in the chronology does not mean none occurred.",
		].join("\n"),
	);

	const text = rendered.join("\n\n");
	stats.chars = text.length;
	return { text, stats, compression };
}
