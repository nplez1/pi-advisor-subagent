import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderAdvisorToolResult } from "../advisor/render.ts";
import { runChildAgent, serializeTranscript } from "../advisor/subagent.ts";

function makePi(mode = "early") {
	const listeners = new Map();
	const observed = [];
	const notify = (channel, data) => {
		for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
	};
	const events = {
		on(channel, handler) {
			if (!listeners.has(channel)) listeners.set(channel, new Set());
			listeners.get(channel).add(handler);
			return () => listeners.get(channel)?.delete(handler);
		},
		emit(channel, payload) {
			observed.push(channel);
			const reply = (data) => notify(`${channel}:reply:${payload.requestId}`, { success: true, data });
			const reject = (error) => notify(`${channel}:reply:${payload.requestId}`, { success: false, error });
			if (channel === "subagents:rpc:ping") reply({ version: 2 });
			if (channel === "subagents:rpc:spawn") {
				const id = `agent-${mode}`;
				const type = mode === "wrong-type" ? "general-purpose" : payload.type;
				notify("subagents:started", { id, type, description: payload.options.description });
				if (mode === "early") {
					notify("subagents:completed", {
						id,
						type,
						description: payload.options.description,
						status: "completed",
						result: "Use the staged approach.",
						usage: { input: 7, output: 3 },
					});
				} else if (mode === "failed") {
					notify("subagents:failed", {
						id,
						type,
						description: payload.options.description,
						status: "error",
						result: "partial guidance",
						error: "provider unavailable",
					});
				}
				if (mode === "startup-error") {
					setTimeout(() => reject("simulated startup error"), 0);
					return;
				}
				setTimeout(() => reply({ id }), 0);
			}
			if (channel === "subagents:rpc:stop" || channel === "subagents:rpc:consume") reply(undefined);
		},
	};
	return { pi: { events }, observed };
}

const ADVISOR_RUN = { agentType: "rpiv-advisor", runLabel: "Advisor review" };

test("transcript preserves tool output, omits host metadata and media bytes, and is compact", () => {
	const serialized = serializeTranscript([
		{ role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } }] },
		{
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "bash",
			content: [{ type: "text", text: "tool-output-kept" }],
			details: { privateDetail: "not-forwarded" },
		},
		{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "SECRET_IMAGE_BYTES" }] },
	]);

	assert.match(serialized, /tc-1/);
	assert.match(serialized, /tool-output-kept/);
	assert.match(serialized, /media payload omitted/);
	assert.doesNotMatch(serialized, /SECRET_IMAGE_BYTES|privateDetail/);
	// Compact: the old pretty-printed form spent 4.6% of the payload on
	// indentation, and this transcript is the compressor's input.
	assert.doesNotMatch(serialized, /\n\s+/);
});

test("advisor waits for and consumes an early subagent completion", async () => {
	const { pi, observed } = makePi("early");
	let startedId;
	const result = await runChildAgent(pi, {
		...ADVISOR_RUN,
		model: "provider/model",
		effort: "high",
		prompt: "review this conversation",
		signal: undefined,
		onStarted: (id) => {
			startedId = id;
		},
	});

	assert.equal(result.status, "completed");
	assert.equal(result.text, "Use the staged approach.");
	assert.equal(startedId, "agent-early");
	assert(observed.includes("subagents:rpc:consume"));
});

test("advisor abort stops and consumes the subagent", async () => {
	const { pi, observed } = makePi("abort");
	const controller = new AbortController();
	const pending = runChildAgent(pi, {
		...ADVISOR_RUN,
		model: "provider/model",
		effort: undefined,
		prompt: "review this conversation",
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 20);

	const result = await pending;
	assert.equal(result.status, "aborted");
	assert(observed.includes("subagents:rpc:stop"));
});

test("advisor reports subagent failure and preserves partial output", async () => {
	const { pi, observed } = makePi("failed");
	const result = await runChildAgent(pi, {
		...ADVISOR_RUN,
		model: "provider/model",
		effort: undefined,
		prompt: "review this conversation",
		signal: undefined,
	});

	assert.equal(result.status, "failed");
	assert.equal(result.text, "partial guidance");
	assert.equal(result.error, "provider unavailable");
	assert(observed.includes("subagents:rpc:consume"));
});

test("startup failure after a started event stops the identified child", async () => {
	const { pi, observed } = makePi("startup-error");
	await assert.rejects(
		runChildAgent(pi, {
			...ADVISOR_RUN,
			model: "provider/model",
			effort: undefined,
			prompt: "review this conversation",
			signal: undefined,
		}),
		/simulated startup error/,
	);
	assert(observed.includes("subagents:rpc:stop"));
});

test("unexpected fallback agent type is stopped and reported as failure", async () => {
	const { pi, observed } = makePi("wrong-type");
	const result = await runChildAgent(pi, {
		...ADVISOR_RUN,
		model: "provider/model",
		effort: undefined,
		prompt: "review this conversation",
		signal: undefined,
	});

	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /unexpected agent type/);
	assert(observed.includes("subagents:rpc:stop"));
});

test("the compressor stage runs under its own agent profile", async () => {
	const { pi } = makePi("early");
	let spawnedType;
	const originalEmit = pi.events.emit;
	pi.events.emit = (channel, payload) => {
		if (channel === "subagents:rpc:spawn") spawnedType = payload.type;
		originalEmit(channel, payload);
	};

	const result = await runChildAgent(pi, {
		agentType: "rpiv-compressor",
		runLabel: "Context compression",
		model: "provider/model",
		effort: undefined,
		prompt: "compress this conversation",
		signal: undefined,
	});

	assert.equal(result.status, "completed");
	assert.equal(spawnedType, "rpiv-compressor");
});

test("a missing agent profile fails loudly instead of spawning", async () => {
	const { pi, observed } = makePi("early");
	await assert.rejects(
		runChildAgent(pi, {
			agentType: "rpiv-does-not-exist",
			runLabel: "Advisor review",
			model: "provider/model",
			effort: undefined,
			prompt: "review this conversation",
			signal: undefined,
		}),
		/Required pi-subagents profile is missing/,
	);
	assert(!observed.includes("subagents:rpc:spawn"));
});

test("completed guidance remains visible when the tool result is collapsed", () => {
	initTheme("dark", false);
	const result = {
		content: [{ type: "text", text: "## Correction\n\nThe full advisor guidance stays visible." }],
		details: {},
	};
	const component = renderAdvisorToolResult(result, false);
	const rendered = component.render(100).join("\n");
	assert.match(rendered, /full advisor guidance stays visible/);
});
