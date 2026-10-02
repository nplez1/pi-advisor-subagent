/**
 * select — deterministic context selection for the advisor payload.
 *
 * This module is the *ground truth* half of the pipeline and it never consults a
 * model. It produces three things from the resolved branch:
 *
 *   userRequests — every ask the user actually made, verbatim and untruncated
 *   recent       — the last few turns, per-message capped with labelled elisions
 *   skeleton     — a one-line-per-message chronology of everything older
 *
 * The compressor's packet is sent *alongside* these, never instead of them: the
 * packet says what the compressor judges important, the skeleton proves what
 * happened, and the advisor can check one against the other. A compression stage
 * that silently dropped the evidence of the executor's own mistake would be
 * undetectable if the skeleton were not computed independently of it.
 *
 * Every elision carries an explicit marker (`… [+N chars omitted]`). A silently
 * shortened tool result reads as "this was the whole output", which would have
 * the reviewer reasoning from a false premise — worse than sending less.
 *
 * Division of labour with the compressor: thinking blocks are *not* reproduced
 * in the skeleton (only their size is noted). Ground truth means what the
 * executor did and observed; private reasoning is the compressor's half of the
 * job, which is why it reads the branch in full.
 */

import type { Message } from "@earendil-works/pi-ai";
import { ADVISOR_TOOL_NAME, markerOmitted, markerPriorAdvisor, markerSkeletonElided } from "./messages.js";

/** Turns kept verbatim-ish at the tail. The live decision usually lives here. */
export const RECENT_MESSAGE_COUNT = 6;
/** Per-message cap inside the recent window. Not a window-wide budget: a window
 * of small messages stays small, and one huge tool result gets clipped rather
 * than crowding out its neighbours. It is per *message*, not per content block —
 * an assistant turn carrying text, reasoning, and a tool call shares one budget
 * across all three, or a six-message window could reach 27k characters while
 * claiming a 9k bound. */
export const RECENT_MESSAGE_MAX_CHARS = 1500;
/** Per-line excerpt length in the skeleton. */
export const SKELETON_EXCERPT_CHARS = 120;
/**
 * Cap on the whole chronology. The skeleton is a deterministic floor, not a
 * model-authored payload, so it must not grow without bound: at ~250 chars per
 * message an uncapped skeleton reaches the full-branch cost it exists to avoid
 * somewhere around a thousand messages. When the cap bites, the middle is elided
 * with a labelled marker and both ends are kept — the oldest messages carry the
 * task setup, the newest sit adjacent to the recent window, and the middle is
 * what the compressor's digest is for.
 */
export const SKELETON_MAX_CHARS = 24_000;
/** Head share of a clipped message; the tail keeps the rest. Command output puts
 * its payload at the top and its errors and summaries at the bottom. */
const HEAD_SHARE = 0.6;

interface Block {
	type?: string;
	text?: string;
	/** Thinking blocks carry their body here, not in `text`. */
	thinking?: string;
	name?: string;
	id?: string;
	arguments?: unknown;
}

interface MessageRecord {
	role?: string;
	content?: unknown;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}

function record(message: Message): MessageRecord {
	return message as unknown as MessageRecord;
}

function blocksOf(message: Message): Block[] {
	const content = record(message).content;
	if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	return content as Block[];
}

function textOf(blocks: Block[]): string {
	return blocks
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Clip to `max`, keeping both ends, and label exactly how much was dropped. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * HEAD_SHARE);
	const tail = max - head;
	return `${text.slice(0, head)}${markerOmitted(text.length - max)}${text.slice(-tail)}`;
}

function excerpt(text: string, max: number): string {
	return clip(collapse(text), max);
}

/**
 * Keep both ends of an over-long chronology, replacing the middle with a
 * labelled marker. Line-aware rather than a character slice so no line is ever
 * cut in half.
 */
function capLines(lines: string[], maxChars: number): string {
	const total = lines.reduce((n, line) => n + line.length + 1, 0);
	if (total <= maxChars) return lines.join("\n");

	// Reserve the marker's own line so the returned chronology honours the cap
	// rather than overshooting it by exactly the text announcing the elision.
	const marker = markerSkeletonElided(lines.length);
	const budget = Math.max(0, maxChars - marker.length - 1);
	const headBudget = Math.floor(budget / 2);
	let headChars = 0;
	const head: string[] = [];
	for (const line of lines) {
		if (headChars + line.length + 1 > headBudget) break;
		head.push(line);
		headChars += line.length + 1;
	}

	const tailBudget = budget - headChars;
	let tailChars = 0;
	const tail: string[] = [];
	for (let i = lines.length - 1; i >= head.length; i--) {
		const line = lines[i] as string;
		if (tailChars + line.length + 1 > tailBudget) break;
		tail.unshift(line);
		tailChars += line.length + 1;
	}

	const elided = lines.length - head.length - tail.length;
	return [...head, markerSkeletonElided(elided), ...tail].join("\n");
}

/** A prior advisor consultation. Its guidance was already acted on and already
 * sits in the executor's context, so re-sending it double-charges. */
export function isPriorAdvisorResult(message: Message): boolean {
	return record(message).role === "toolResult" && record(message).toolName === ADVISOR_TOOL_NAME;
}

/** Index of the first message belonging to the recent window. */
function recentStart(messages: Message[], count: number): number {
	return Math.max(0, messages.length - count);
}

/**
 * Every user message in the branch, verbatim and never truncated — the task
 * statement is the one thing that must survive windowing intact. Messages inside
 * the recent window are skipped because the window already reproduces them.
 */
export function buildUserRequests(messages: Message[], count = RECENT_MESSAGE_COUNT): string {
	const start = recentStart(messages, count);
	const parts: string[] = [];
	messages.forEach((message, index) => {
		if (index >= start) return;
		if (record(message).role !== "user") return;
		const text = textOf(blocksOf(message));
		if (text.trim()) parts.push(`#${index} [user] ${text.trim()}`);
	});
	return parts.join("\n\n");
}

/** One line per message: chronology, tool identity, outcome, and citable IDs. */
export function buildSkeleton(
	messages: Message[],
	count = RECENT_MESSAGE_COUNT,
	maxChars = SKELETON_MAX_CHARS,
): string {
	const start = recentStart(messages, count);
	const lines: string[] = [];
	messages.forEach((message, index) => {
		if (index >= start) return;
		const rec = record(message);
		const id = `#${index}`;

		if (rec.role === "system") return;

		if (isPriorAdvisorResult(message)) {
			lines.push(`${id} [advisor] ${markerPriorAdvisor(textOf(blocksOf(message)).length)}`);
			return;
		}

		if (rec.role === "user") {
			const text = collapse(textOf(blocksOf(message)));
			if (text) lines.push(`${id} [user] ${excerpt(text, SKELETON_EXCERPT_CHARS)}`);
			return;
		}

		if (rec.role === "assistant") {
			const blocks = blocksOf(message);
			const text = collapse(textOf(blocks));
			if (text) lines.push(`${id} [assistant] ${excerpt(text, SKELETON_EXCERPT_CHARS)}`);
			// Thinking is deliberately absent: it is private reasoning, not ground
			// truth, and it is 37% of a long branch. The compressor reads it in full
			// and carries anything load-bearing into the digest, so the advisor still
			// learns about a flawed line of reasoning — just as a claim it can weigh
			// against this chronology, rather than as bulk it must re-read.
			for (const call of blocks.filter((b) => b.type === "toolCall")) {
				const label = [call.name, call.id].filter(Boolean).join(" ");
				lines.push(
					`${id} [toolCall ${label}] ${excerpt(JSON.stringify(call.arguments ?? {}), SKELETON_EXCERPT_CHARS)}`,
				);
			}
			return;
		}

		if (rec.role === "toolResult") {
			const text = textOf(blocksOf(message));
			const status = rec.isError ? "ERROR" : "ok";
			const label = [rec.toolName ?? "?", rec.toolCallId ?? "?", status].join(" ");
			lines.push(
				`${id} [toolResult ${label} ${text.length}c] ${excerpt(text, SKELETON_EXCERPT_CHARS)}`,
			);
		}
	});
	return capLines(lines, maxChars);
}

/**
 * The tail of the conversation, per-message capped. Prior advisor guidance
 * collapses to its marker; everything else keeps both ends of an over-long body.
 */
export function buildRecentWindow(
	messages: Message[],
	count = RECENT_MESSAGE_COUNT,
	maxChars = RECENT_MESSAGE_MAX_CHARS,
): string {
	const start = recentStart(messages, count);
	const parts: string[] = [];
	messages.forEach((message, index) => {
		if (index < start) return;
		const rec = record(message);
		const id = `#${index}`;

		if (rec.role === "system") return;

		if (isPriorAdvisorResult(message)) {
			parts.push(`${id} [advisor] ${markerPriorAdvisor(textOf(blocksOf(message)).length)}`);
			return;
		}

		if (rec.role === "user") {
			const text = textOf(blocksOf(message)).trim();
			if (text) parts.push(`${id} [user]\n${clip(text, maxChars)}`);
			return;
		}

		if (rec.role === "assistant") {
			const blocks = blocksOf(message);
			// Renderable units of this one message, before budgeting.
			const units: Array<{ label: string; text: string }> = [];
			const text = textOf(blocks).trim();
			if (text) units.push({ label: "", text });
			for (const block of blocks.filter((b) => b.type === "thinking")) {
				const thinking = (block.thinking ?? "").trim();
				if (thinking) units.push({ label: "[thinking] ", text: thinking });
			}
			for (const call of blocks.filter((b) => b.type === "toolCall")) {
				const label = [call.name, call.id].filter(Boolean).join(" ");
				units.push({
					label: `[toolCall ${label}] `,
					text: collapse(JSON.stringify(call.arguments ?? {})),
				});
			}
			if (units.length === 0) return;
			// One budget for the whole message, shared evenly across its units, so a
			// turn with several blocks cannot spend the cap several times over.
			const perUnit = Math.max(1, Math.floor(maxChars / units.length));
			const body = units.map((unit) => `${unit.label}${clip(unit.text, perUnit)}`);
			parts.push(`${id} [assistant]\n${body.join("\n")}`);
			return;
		}

		if (rec.role === "toolResult") {
			const text = textOf(blocksOf(message));
			const status = rec.isError ? "ERROR" : "ok";
			const label = [rec.toolName ?? "?", rec.toolCallId ?? "?", status].join(" ");
			parts.push(`${id} [toolResult ${label}]\n${clip(text, maxChars)}`);
		}
	});
	return parts.join("\n\n");
}

export interface GroundTruth {
	/** Older user asks, verbatim and untruncated (recent ones live in `recent`). */
	userRequests: string;
	/** The last few turns, per-message capped with labelled elisions. */
	recent: string;
	/** One line per older message, with the message index as a citable ID. */
	skeleton: string;
}

export function buildGroundTruth(messages: Message[], count = RECENT_MESSAGE_COUNT): GroundTruth {
	return {
		userRequests: buildUserRequests(messages, count),
		recent: buildRecentWindow(messages, count),
		skeleton: buildSkeleton(messages, count),
	};
}
