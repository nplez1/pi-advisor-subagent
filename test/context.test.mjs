/**
 * Context-pipeline tests: the deterministic selection that forms the reviewer's
 * ground truth, and the payload assembly around it. These are the guarantees the
 * whole cost-reduction design rests on — a digest may be wrong, but the floor
 * must not be.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildAdvisorPayload } from "../advisor/payload.ts";
import {
	buildGroundTruth,
	buildRecentWindow,
	buildSkeleton,
	buildUserRequests,
	isPriorAdvisorResult,
	SKELETON_MAX_CHARS,
} from "../advisor/select.ts";

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistantText = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 });
const assistantCall = (id, name, args) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
	timestamp: 0,
});
const toolResult = (id, name, text, isError = false) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	isError,
	content: [{ type: "text", text }],
	timestamp: 0,
});
const thinking = (text) => ({ role: "assistant", content: [{ type: "thinking", thinking: text }], timestamp: 0 });

test("every user request is preserved verbatim, never clipped", () => {
	const long = "x".repeat(4000);
	const messages = [user("first ask"), assistantText("ok"), toolResult("t1", "bash", "out"), user(long), assistantText("recent")];

	// Window of 1 puts every user message in the "older" region.
	const requests = buildUserRequests(messages, 1);
	assert.match(requests, /first ask/);
	assert.ok(requests.includes(long), "an over-long user request must survive intact");
	assert.doesNotMatch(requests, /chars omitted/);

	const groundTruth = buildGroundTruth(messages, 1);
	assert.ok(groundTruth.userRequests.includes(long));
});

test("recent window clips long bodies and labels the omission at both ends", () => {
	const body = `HEAD${"m".repeat(6000)}TAIL`;
	const messages = [assistantCall("t1", "bash", { command: "dump" }), toolResult("t1", "bash", body)];

	const groundTruth = buildGroundTruth(messages, 2);
	assert.match(groundTruth.recent, /chars omitted/);
	assert.match(groundTruth.recent, /HEAD/);
	assert.match(groundTruth.recent, /TAIL/, "the tail must survive so errors at the end of output are visible");
});

test("the recent-window cap is per message, not per content block", () => {
	// An assistant turn carrying text, reasoning, and a tool call is three blocks.
	// A per-block cap would let this single message spend the budget three times
	// over, so a six-message window could reach 27k characters while claiming a
	// 9k bound.
	const long = "z".repeat(40000);
	const multiBlock = {
		role: "assistant",
		content: [
			{ type: "text", text: long },
			{ type: "thinking", thinking: long },
			{ type: "toolCall", id: "tc-multi", name: "write", arguments: { content: long } },
		],
		timestamp: 0,
	};

	const maxChars = 1500;
	const recent = buildRecentWindow([multiBlock], 1, maxChars);
	// Label overhead only; the bodies must share the one budget.
	assert.ok(
		recent.length <= maxChars + 200,
		`a three-block message produced ${recent.length} chars against a ${maxChars} per-message budget`,
	);
});

test("skeleton is chronological, citable, and carries tool identity and outcome", () => {
	const messages = [
		user("do the thing"),
		assistantCall("tc-1", "bash", { command: "npm test" }),
		toolResult("tc-1", "bash", "Error: 3 failing", true),
		thinking("this reasoning must not appear"),
		assistantText("I will fix the three failures"),
		user("carry on"),
		assistantText("done"),
	];

	const skeleton = buildSkeleton(messages, 1);
	assert.match(skeleton, /#0 \[user\] do the thing/);
	assert.match(skeleton, /#1 \[toolCall bash tc-1\]/);
	assert.match(skeleton, /#2 \[toolResult bash tc-1 ERROR 16c\]/);
	assert.match(skeleton, /#4 \[assistant\] I will fix the three failures/);
	// Reasoning is the compressor's material, not chronology: the thinking-only
	// message gets no line at all, so #3 is absent rather than empty.
	assert.doesNotMatch(skeleton, /#3/);
	assert.doesNotMatch(skeleton, /this reasoning must not appear/);
});

test("prior advisor guidance collapses to a marker and its body is not re-sent", () => {
	const guidance = "A very long previous consultation that must not be paid for twice.";
	const prior = toolResult("tc-9", "advisor", guidance);
	const messages = [prior, assistantText("acted on it"), user("next question"), assistantText("working")];

	assert.equal(isPriorAdvisorResult(prior), true);

	const groundTruth = buildGroundTruth(messages, 1);
	assert.match(groundTruth.skeleton, /prior advisor consultation omitted/);
	assert.doesNotMatch(groundTruth.skeleton, /must not be paid for twice/);
	assert.doesNotMatch(groundTruth.recent, /must not be paid for twice/);
});

test("skeleton stays inside its cap and labels the elided middle", () => {
	const messages = [];
	for (let i = 0; i < 400; i++) messages.push(assistantText(`step ${i} ${"y".repeat(200)}`));
	messages.push(user("tail"));

	const cap = 3000;
	const skeleton = buildSkeleton(messages, 1, cap);
	assert.ok(skeleton.length <= cap, `skeleton ${skeleton.length} exceeded cap ${cap}`);
	assert.match(skeleton, /earlier messages elided/);
	// Both ends survive: the opening of the chronology and the run-up to the
	// recent window.
	assert.match(skeleton, /#0 \[assistant\] step 0/);
	assert.match(skeleton, /#398 \[assistant\] step 398/);
});

test("a small history leaves the skeleton uncapped and unmarked", () => {
	const skeleton = buildSkeleton([user("a"), assistantText("b")], 1);
	assert.doesNotMatch(skeleton, /elided/);
});

test("payload carries question, digest, ground truth, inventory, and trust notes", () => {
	const messages = [user("please fix the parser"), assistantText("looking"), toolResult("t1", "bash", "ok"), assistantText("recent turn")];
	const groundTruth = buildGroundTruth(messages, 1);
	const inventory = { role: "user", content: [{ type: "text", text: "- bash: Execute bash commands" }] };

	const payload = buildAdvisorPayload({
		question: "Is the token-budget approach sound?",
		compressorLabel: "deepseek:flash",
		packet: "## Digest\n\nMeasured 135k chars.",
		groundTruth,
		inventory,
	});

	assert.equal(payload.compression, "ok");
	assert.match(payload.text, /## Question under review\n\nIs the token-budget approach sound\?/);
	assert.match(payload.text, /Question-targeted digest \(compressed by deepseek:flash\)/);
	assert.match(payload.text, /## Timeline/);
	assert.match(payload.text, /## User requests, verbatim and complete/);
	assert.match(payload.text, /please fix the parser/);
	assert.match(payload.text, /## Recent turns, verbatim/);
	assert.match(payload.text, /## Executor tool inventory/);
	// The reviewer must be told the digest is fallible and the chronology is not.
	assert.match(payload.text, /may be incomplete, imprecise, or wrong/);
	assert.match(payload.text, /chronology is what happened/);
	assert.ok(payload.stats.chars > 0);
	assert.equal(
		payload.stats.question + payload.stats.digest + payload.stats.timeline + payload.stats.userRequests + payload.stats.recent + payload.stats.inventory <= payload.stats.chars,
		true,
	);
});

test("a failed compression still ships the full ground truth with an explicit marker", () => {
	const messages = [user("the ask"), assistantText("a"), assistantText("b"), assistantText("recent")];
	const groundTruth = buildGroundTruth(messages, 1);

	const payload = buildAdvisorPayload({
		question: "what broke?",
		compressorLabel: "deepseek:flash",
		compressionError: "provider unavailable",
		groundTruth,
		inventory: undefined,
	});

	assert.equal(payload.compression, "failed");
	assert.match(payload.text, /Compression unavailable \(provider unavailable\)/);
	// Degrading must lose the digest, never the evidence.
	assert.match(payload.text, /the ask/);
	assert.match(payload.text, /## Timeline/);
	assert.doesNotMatch(payload.text, /Question-targeted digest/);
});

test("the skeleton cap is a named, tunable constant", () => {
	assert.equal(typeof SKELETON_MAX_CHARS, "number");
	assert.ok(SKELETON_MAX_CHARS > 0);
});
