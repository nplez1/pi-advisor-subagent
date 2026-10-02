/**
 * subagent — run an advisor-pipeline stage through pi-subagents' cross-extension
 * RPC. Both stages (compressor, then advisor) share this runner: the RPC spawn is
 * backgrounded so pi-subagents surfaces it in its live widget/FleetView, and its
 * completion event is returned to the caller.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PING_TIMEOUT_MS = 1_500;
const SPAWN_TIMEOUT_MS = 60_000;
const CONTROL_TIMEOUT_MS = 3_000;

interface RpcReply<T> {
	success: boolean;
	data?: T;
	error?: string;
}

interface RpcSpawnData {
	id: string;
}

export interface AdvisorSubagentCompletion {
	id: string;
	description?: string;
	type?: string;
	status?: string;
	result?: string;
	error?: string;
	usage?: Usage;
}

export interface AdvisorSubagentResult {
	status: "completed" | "failed" | "aborted";
	text: string;
	usage?: Usage;
	error?: string;
}

function rpcRequest<T>(
	pi: ExtensionAPI,
	channel: string,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<T> {
	const requestId = randomUUID();
	const replyChannel = `${channel}:reply:${requestId}`;

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe = () => {};

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			unsubscribe();
			fn();
		};

		unsubscribe = pi.events.on(replyChannel, (raw) => {
			const reply = raw as RpcReply<T> | undefined;
			if (!reply || typeof reply !== "object") {
				finish(() => reject(new Error(`Invalid reply from ${channel}`)));
			} else if (!reply.success) {
				finish(() => reject(new Error(reply.error || `Request failed: ${channel}`)));
			} else {
				finish(() => resolve(reply.data as T));
			}
		});

		timer = setTimeout(() => {
			finish(() => reject(new Error(`Timed out waiting for ${channel}`)));
		}, timeoutMs);

		try {
			pi.events.emit(channel, { ...payload, requestId });
		} catch (error) {
			finish(() => reject(error instanceof Error ? error : new Error(String(error))));
		}
	});
}

/**
 * Both stages must run with no tools, no extensions, no skills, no persisted
 * child session, and a replacing prompt. A hand-edited profile that granted any
 * of these would silently turn a read-only reviewer into something with side
 * effects, so the frontmatter is asserted at spawn time rather than trusted.
 */
function assertAgentProfile(agentType: string): void {
	const profilePath = join(getAgentDir(), "agents", `${agentType}.md`);
	let source: string;
	try {
		source = readFileSync(profilePath, "utf8");
	} catch {
		throw new Error(`Required pi-subagents profile is missing: ${profilePath}`);
	}
	const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? "";
	const requiredFields: Record<string, string> = {
		name: agentType,
		tools: "none",
		extensions: "false",
		skills: "false",
		prompt_mode: "replace",
		persist_session: "false",
		output_transcript: "false",
	};
	for (const [key, value] of Object.entries(requiredFields)) {
		if (!new RegExp(`^${key}:\\s*${value}\\s*$`, "m").test(frontmatter)) {
			throw new Error(`Unsafe pi-subagents profile at ${profilePath}: expected ${key}: ${value}`);
		}
	}
}

function consumeResult(pi: ExtensionAPI, agentId: string): void {
	// Best effort: pi-subagents holds completion nudges briefly, giving this
	// request time to suppress the duplicate notification before it is shown.
	void rpcRequest<void>(pi, "subagents:rpc:consume", { agentId }, CONTROL_TIMEOUT_MS).catch(() => {});
}

function stopAndConsume(pi: ExtensionAPI, agentId: string): void {
	// The caller's AbortSignal is also forwarded in the spawn options. The stop
	// RPC covers queued agents (which do not emit a completion event on abort);
	// consume then prevents a late completion nudge for a running agent.
	void rpcRequest<void>(pi, "subagents:rpc:stop", { agentId }, CONTROL_TIMEOUT_MS)
		.catch(() => undefined)
		.then(() => rpcRequest<void>(pi, "subagents:rpc:consume", { agentId }, CONTROL_TIMEOUT_MS))
		.catch(() => {});
}

/** Replace non-text media bytes with a short marker before JSON serialization. */
function stripMediaPayloads(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripMediaPayloads);
	if (!value || typeof value !== "object") return value;

	const record = value as Record<string, unknown>;
	const isMedia = ["image", "audio", "video"].includes(String(record.type));
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) {
		if (isMedia && (key === "data" || key === "base64")) {
			const bytes = typeof child === "string" ? Buffer.byteLength(child, "utf8") : undefined;
			result[key] = `[media payload omitted${bytes === undefined ? "" : `; ${bytes} encoded bytes`}]`;
		} else {
			result[key] = stripMediaPayloads(child);
		}
	}
	return result;
}

/**
 * Convert the Pi LLM context into a role-labelled JSON transcript. Tool-call
 * IDs/arguments and tool-result bodies are retained; image/audio/video payloads
 * are represented as metadata because this runner accepts a text prompt.
 *
 * Serialized compactly, not pretty-printed: indentation was 4.6% of a measured
 * payload and carries no information. This is the compressor's input only — the
 * advisor receives the compressor's digest plus the deterministic ground truth,
 * never the raw branch.
 */
export function serializeTranscript(messages: Message[]): string {
	const transcript = messages.map((message) => {
		const source = message as unknown as Record<string, unknown>;
		const serialized: Record<string, unknown> = {
			role: source.role,
			content: source.content,
		};
		// Keep the tool-result envelope needed to correlate tool output with the
		// assistant call, but do not forward host-only usage/details metadata that
		// was not part of the provider-facing LLM context.
		for (const key of ["toolCallId", "toolName", "isError"]) {
			if (source[key] !== undefined) serialized[key] = source[key];
		}
		return stripMediaPayloads(serialized);
	});
	return JSON.stringify(transcript);
}

/**
 * Launch one pipeline stage and wait for its completion. Events are subscribed
 * before the spawn request and correlated by a unique description, so the ID is
 * known even if startup or completion events arrive before the RPC reply.
 */
export async function runChildAgent(
	pi: ExtensionAPI,
	options: {
		agentType: string;
		/** Prefix for the unique run description shown in FleetView. */
		runLabel: string;
		model: string;
		effort: ThinkingLevel | undefined;
		prompt: string;
		signal: AbortSignal | undefined;
		onStarted?: (agentId: string) => void;
	},
): Promise<AdvisorSubagentResult> {
	if (options.signal?.aborted) return { status: "aborted", text: "", error: "aborted" };
	assertAgentProfile(options.agentType);

	const ping = await rpcRequest<{ version?: number }>(pi, "subagents:rpc:ping", {}, PING_TIMEOUT_MS);
	if (!ping || typeof ping.version !== "number" || ping.version < 2) {
		throw new Error("pi-subagents RPC v2 is unavailable");
	}

	const runTag = randomUUID().slice(0, 12);
	const runDescription = `${options.runLabel} ${runTag}`;
	let agentId: string | undefined;
	let notifiedStarted = false;
	let abortRequested = false;
	let settled = false;
	let resolveCompletion!: (event: AdvisorSubagentCompletion) => void;
	let resolveAbort!: () => void;
	const completion = new Promise<AdvisorSubagentCompletion>((resolve) => {
		resolveCompletion = resolve;
	});
	const aborted = new Promise<void>((resolve) => {
		resolveAbort = resolve;
	});

	const identifyAgent = (id: string): boolean => {
		if (agentId && agentId !== id) return false;
		agentId = id;
		if (!notifiedStarted) {
			notifiedStarted = true;
			try {
				options.onStarted?.(id);
			} catch {
				// UI update callbacks must never disrupt the child run.
			}
		}
		if (abortRequested) stopAndConsume(pi, id);
		return true;
	};

	const acceptStarted = (raw: unknown) => {
		const event = raw as { id?: unknown; type?: unknown; description?: unknown } | undefined;
		if (event?.description !== runDescription || typeof event.id !== "string") return;
		if (!identifyAgent(event.id)) return;
		if (event.type !== options.agentType && !settled) {
			settled = true;
			stopAndConsume(pi, event.id);
			resolveCompletion({
				id: event.id,
				description: runDescription,
				status: "error",
				error: `pi-subagents started unexpected agent type: ${String(event.type)}`,
			});
		}
	};

	const acceptCompletion = (event: AdvisorSubagentCompletion) => {
		if (!event || event.description !== runDescription || typeof event.id !== "string") return;
		if (!identifyAgent(event.id) || settled) return;
		settled = true;
		consumeResult(pi, event.id);
		resolveCompletion(event);
	};

	const unsubscribeStarted = pi.events.on("subagents:started", acceptStarted);
	const unsubscribeCompleted = pi.events.on("subagents:completed", (event) => {
		acceptCompletion(event as AdvisorSubagentCompletion);
	});
	const unsubscribeFailed = pi.events.on("subagents:failed", (event) => {
		acceptCompletion(event as AdvisorSubagentCompletion);
	});
	const onAbort = () => {
		abortRequested = true;
		if (agentId) stopAndConsume(pi, agentId);
		resolveAbort();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		let spawned: RpcSpawnData;
		try {
			spawned = await rpcRequest<RpcSpawnData>(
				pi,
				"subagents:rpc:spawn",
				{
					type: options.agentType,
					prompt: options.prompt,
					options: {
						description: runDescription,
						model: options.model,
						thinkingLevel: options.effort,
						isBackground: true,
						isolated: true,
						inheritContext: false,
						signal: options.signal,
					},
				},
				SPAWN_TIMEOUT_MS,
			);
		} catch (error) {
			// pi-subagents emits `started` before finishing child-session startup.
			// If the RPC timed out after that point, the unique description has
			// already let us capture the ID, so never leave that child orphaned.
			if (agentId) stopAndConsume(pi, agentId);
			throw error;
		}
		if (!spawned || typeof spawned.id !== "string" || !spawned.id) {
			throw new Error("pi-subagents did not return an agent id");
		}
		if (!identifyAgent(spawned.id)) {
			stopAndConsume(pi, spawned.id);
			throw new Error("pi-subagents returned an id that did not match its started event");
		}
		if (abortRequested || options.signal?.aborted) {
			stopAndConsume(pi, spawned.id);
			return { status: "aborted", text: "", error: "aborted" };
		}

		const outcome = await Promise.race([
			completion.then((event) => ({ kind: "completion" as const, event })),
			aborted.then(() => ({ kind: "aborted" as const })),
		]);
		if (outcome.kind === "aborted") {
			stopAndConsume(pi, spawned.id);
			return { status: "aborted", text: "", error: "aborted" };
		}
		const event = outcome.event;

		if (abortRequested || options.signal?.aborted || event.status === "aborted" || event.status === "stopped") {
			return { status: "aborted", text: event.result?.trim() ?? "", usage: event.usage, error: event.error };
		}
		if (event.status === "error") {
			return { status: "failed", text: event.result?.trim() ?? "", usage: event.usage, error: event.error };
		}
		return { status: "completed", text: event.result?.trim() ?? "", usage: event.usage };
	} finally {
		unsubscribeStarted();
		unsubscribeCompleted();
		unsubscribeFailed();
		options.signal?.removeEventListener("abort", onAbort);
	}
}
