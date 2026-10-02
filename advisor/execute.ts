/**
 * execute — the advisor side-call, in two stages.
 *
 *   1. The configured compressor model reads the executor's full resolved branch
 *      and returns a digest aimed at the executor's question.
 *   2. The configured advisor model reviews the question, that digest, and a
 *      deterministic ground-truth floor computed by select.ts.
 *
 * The point of the split is that the bulky branch is read once by the cheaper
 * model instead of by the premium one. The point of the floor is that the
 * premium model is never dependent on the cheaper model's judgement for the
 * basic facts of what was asked and what just happened.
 *
 * Every failure path returns a normal tool result — the executor reads the text
 * and keeps going rather than crashing the turn.
 */

import type { Message, StopReason, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { compressContext } from "./compress.js";
import { stripInflightAdvisorCall } from "./context.js";
import { getInventoryMessage } from "./inventory.js";
import {
	ADVISOR_AGENT_TYPE,
	ERR_ABORTED_DETAIL,
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_RESPONSE_DETAIL,
	ERR_NO_COMPRESSOR,
	ERR_NO_COMPRESSOR_DETAIL,
	ERR_NO_MODEL,
	ERR_NO_MODEL_SELECTED,
	ERR_QUESTION_REQUIRED,
	ERR_QUESTION_REQUIRED_DETAIL,
	errCallFailed,
	errCallThrew,
	errMisconfigured,
	msgCompressing,
	msgConsulting,
} from "./messages.js";
import { buildAdvisorPayload, type PayloadStats } from "./payload.js";
import { buildGroundTruth } from "./select.js";
import { runChildAgent } from "./subagent.js";
import {
	getAdvisorEffort,
	getAdvisorModel,
	getCompressorEffort,
	getCompressorModel,
} from "./state.js";

interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	compressorModel?: string;
	compressorEffort?: ThinkingLevel;
	/** Whether the reviewer got a digest or fell back to the chronology alone. */
	compression?: "ok" | "failed";
	compressionError?: string;
	/** Characters handed to the reviewer, and the same for the compressor input. */
	payloadChars?: number;
	payloadStats?: PayloadStats;
	branchChars?: number;
	usage?: Usage;
	compressorUsage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

export interface AdvisorParams {
	question?: string;
}

// Single result-envelope builder — every executeAdvisor branch and the pre-call
// error paths funnel through here. `effort` and `compressorEffort` are
// snapshotted once at entry so the returned details always match the values sent
// to the children.
function buildAdvisorResult(opts: {
	text: string;
	effort: ThinkingLevel | undefined;
	advisorLabel?: string;
	compressorLabel?: string;
	compressorEffort?: ThinkingLevel;
	compression?: "ok" | "failed";
	compressionError?: string;
	payloadChars?: number;
	payloadStats?: PayloadStats;
	branchChars?: number;
	usage?: Usage;
	compressorUsage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}): AgentToolResult<AdvisorDetails> {
	const details: AdvisorDetails = { effort: opts.effort, compressorEffort: opts.compressorEffort };
	if (opts.advisorLabel !== undefined) details.advisorModel = opts.advisorLabel;
	if (opts.compressorLabel !== undefined) details.compressorModel = opts.compressorLabel;
	if (opts.compression !== undefined) details.compression = opts.compression;
	if (opts.compressionError !== undefined) details.compressionError = opts.compressionError;
	if (opts.payloadChars !== undefined) details.payloadChars = opts.payloadChars;
	if (opts.payloadStats !== undefined) details.payloadStats = opts.payloadStats;
	if (opts.branchChars !== undefined) details.branchChars = opts.branchChars;
	if (opts.usage !== undefined) details.usage = opts.usage;
	if (opts.compressorUsage !== undefined) details.compressorUsage = opts.compressorUsage;
	if (opts.stopReason !== undefined) details.stopReason = opts.stopReason;
	if (opts.errorMessage !== undefined) details.errorMessage = opts.errorMessage;
	return { content: [{ type: "text", text: opts.text }], details };
}

function buildErrorResult(
	advisorLabel: string | undefined,
	effort: ThinkingLevel | undefined,
	userText: string,
	errorMessage: string,
): AgentToolResult<AdvisorDetails> {
	return buildAdvisorResult({ text: userText, effort, advisorLabel, errorMessage });
}

/** One line describing what was actually sent, so the split is never invisible. */
function describePayload(stats: PayloadStats, compression: "ok" | "failed"): string {
	const segments = [
		`question ${stats.question}`,
		`digest ${stats.digest}`,
		`timeline ${stats.timeline}`,
		`user ${stats.userRequests}`,
		`recent ${stats.recent}`,
		`tools ${stats.inventory}`,
	];
	return `_Reviewer context: ${stats.chars} chars (${segments.join(", ")}); digest ${
		compression === "ok" ? "ok" : "unavailable, chronology only"
	}._`;
}

export async function executeAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	params: AdvisorParams | undefined,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	// Snapshot every setting once so a concurrent /advisor selection cannot
	// desync the displayed reviewer or effort from the request in flight.
	const effort = getAdvisorEffort();
	const advisor = getAdvisorModel();
	const compressorEffort = getCompressorEffort();
	const compressor = getCompressorModel();

	if (!advisor) {
		return buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	const advisorLabel = `${advisor.provider}:${advisor.id}`;

	// Refusal, not degradation: with no compressor configured, the pipeline
	// cannot build the reviewer's context at all. Silently substituting some
	// other model would make the payload's content depend on a choice the user
	// never made. Runtime *failure* of a configured compressor degrades instead
	// (see below) — the distinction is configuration versus failure.
	if (!compressor) {
		return buildErrorResult(advisorLabel, effort, ERR_NO_COMPRESSOR, ERR_NO_COMPRESSOR_DETAIL);
	}
	const compressorLabel = `${compressor.provider}:${compressor.id}`;

	const question = params?.question?.trim();
	if (!question) {
		return buildErrorResult(advisorLabel, effort, ERR_QUESTION_REQUIRED, ERR_QUESTION_REQUIRED_DETAIL);
	}

	try {
		const advisorAuth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
		if (!advisorAuth.ok) {
			return buildErrorResult(advisorLabel, effort, errMisconfigured(advisorLabel, advisorAuth.error), advisorAuth.error);
		}
		const compressorAuth = await ctx.modelRegistry.getApiKeyAndHeaders(compressor);
		if (!compressorAuth.ok) {
			return buildErrorResult(
				advisorLabel,
				effort,
				errMisconfigured(compressorLabel, compressorAuth.error),
				compressorAuth.error,
			);
		}

		// Live-read Pi's resolved context. This retains compaction and branch
		// summaries; only the current advisor() call itself is removed.
		const { messages: sessionMessages } = buildSessionContext(
			ctx.sessionManager.getEntries(),
			ctx.sessionManager.getLeafId(),
		);
		const branch: Message[] = stripInflightAdvisorCall(convertToLlm(sessionMessages));
		const groundTruth = buildGroundTruth(branch);
		// Names only: the reviewer needs to know what the executor can do in order
		// to suggest an approach, not every parameter schema — which was being
		// re-sent in full on every call.
		const inventory = getInventoryMessage(pi.getAllTools(), "names");

		onUpdate?.({
			content: [{ type: "text", text: msgCompressing(compressorLabel, compressorEffort) }],
			details: { advisorModel: advisorLabel, effort, compressorModel: compressorLabel, compressorEffort },
		});

		const compression = await compressContext(pi, {
			model: compressor,
			effort: compressorEffort,
			question,
			messages: branch,
			signal,
			onStarted: () => {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `${msgCompressing(compressorLabel, compressorEffort)}\n\nCompressor subagent is running; view its live conversation in the pi-subagents widget/FleetView.`,
						},
					],
					details: { advisorModel: advisorLabel, effort, compressorModel: compressorLabel, compressorEffort },
				});
			},
		});

		const payload = buildAdvisorPayload({
			question,
			compressorLabel,
			packet: compression.packet,
			compressionError: compression.error,
			groundTruth,
			inventory,
		});

		onUpdate?.({
			content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
			details: {
				advisorModel: advisorLabel,
				effort,
				compressorModel: compressorLabel,
				compressorEffort,
				compression: payload.compression,
				compressionError: compression.error,
				payloadChars: payload.stats.chars,
			},
		});

		const callAdvisor = () =>
			runChildAgent(pi, {
				agentType: ADVISOR_AGENT_TYPE,
				runLabel: "Advisor review",
				model: `${advisor.provider}/${advisor.id}`,
				effort,
				prompt: payload.text,
				signal,
				onStarted: () => {
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `${msgConsulting(advisorLabel, effort)}\n\nAdvisor subagent is running; view its live conversation in the pi-subagents widget/FleetView.`,
							},
						],
						details: {
							advisorModel: advisorLabel,
							effort,
							compressorModel: compressorLabel,
							compressorEffort,
							compression: payload.compression,
						},
					});
				},
			});

		const telemetry = {
			compressorLabel,
			compressorEffort,
			compression: payload.compression,
			compressionError: compression.error,
			payloadChars: payload.stats.chars,
			payloadStats: payload.stats,
			branchChars: compression.transcriptChars,
			compressorUsage: compression.usage,
		};

		let response = await callAdvisor();

		const terminalResult = (
			result: Awaited<ReturnType<typeof callAdvisor>>,
		): AgentToolResult<AdvisorDetails> | undefined => {
			if (result.status === "aborted") {
				return buildAdvisorResult({
					text: ERR_CALL_ABORTED,
					effort,
					advisorLabel,
					...telemetry,
					usage: result.usage,
					stopReason: "aborted",
					errorMessage: result.error ?? ERR_ABORTED_DETAIL,
				});
			}
			if (result.status === "failed") {
				const failureText = errCallFailed(result.error);
				return buildAdvisorResult({
					text: result.text ? `${failureText}\n\nPartial advisor output:\n${result.text}` : failureText,
					effort,
					advisorLabel,
					...telemetry,
					usage: result.usage,
					stopReason: "error",
					errorMessage: result.error ?? "subagent failed",
				});
			}
			return undefined;
		};

		const firstTerminal = terminalResult(response);
		if (firstTerminal) return firstTerminal;

		let advisorText = response.text;
		// Preserve the original bounded empty-response recovery: retry once with
		// the same assembled payload, then surface an explicit terminal error.
		if (!advisorText) {
			response = await callAdvisor();
			const retryTerminal = terminalResult(response);
			if (retryTerminal) return retryTerminal;
			advisorText = response.text;
			if (!advisorText) {
				return buildAdvisorResult({
					text: ERR_EMPTY_RESPONSE,
					effort,
					advisorLabel,
					...telemetry,
					usage: response.usage,
					stopReason: "stop",
					errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
				});
			}
		}

		return buildAdvisorResult({
			text: `${advisorText}\n\n${describePayload(payload.stats, payload.compression)}`,
			effort,
			advisorLabel,
			...telemetry,
			usage: response.usage,
			stopReason: "stop",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (signal?.aborted) {
			return buildAdvisorResult({
				text: ERR_CALL_ABORTED,
				effort,
				advisorLabel,
				compressorLabel,
				compressorEffort,
				stopReason: "aborted",
				errorMessage: ERR_ABORTED_DETAIL,
			});
		}
		return buildErrorResult(advisorLabel, effort, errCallThrew(message), message);
	}
}
