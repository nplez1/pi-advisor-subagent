/**
 * Refusal-path tests for the two-stage advisor call.
 *
 * These paths must return a normal tool result rather than throwing, and must
 * name the remedy: the executor has no other way to learn that the pipeline is
 * unconfigured or switched off, and a bare failure would read as a broken tool.
 *
 * Every refusal is decided before the call touches the model registry or the
 * session, so a `ctx` carrying only `cwd` and the registry is enough.
 */

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Global overrides are read from getAgentDir(); redirect it before loading so the
// developer's own subagents.json cannot decide an outcome here.
const agentDir = mkdtempSync(join(tmpdir(), "rpiv-advisor-exec-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "rpiv-advisor-exec-project-"));
const xdg = mkdtempSync(join(tmpdir(), "rpiv-advisor-exec-xdg-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.XDG_CONFIG_HOME = xdg;

const { executeAdvisor } = await import("../advisor/execute.ts");

// The pipeline asserts its two agent profiles at spawn time. Copy the shipped
// ones into the redirected agent dir so the spawn paths below are exercised
// end-to-end instead of against the developer's install.
const profileSource = fileURLToPath(new URL("../agents/", import.meta.url));
mkdirSync(join(agentDir, "agents"), { recursive: true });
for (const file of readdirSync(profileSource).filter((f) => f.endsWith(".md"))) {
	copyFileSync(join(profileSource, file), join(agentDir, "agents", file));
}

test.after(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(xdg, { recursive: true, force: true });
});

const MODELS = [
	{ provider: "github-copilot", id: "gpt-6-sol", name: "Sol" },
	{ provider: "deepseek", id: "deepseek-flash", name: "Flash" },
];

/** Write the machine's `/subagents` state — the only store this pipeline reads. */
function writeOverrides(agentOverrides) {
	writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ agentOverrides }), "utf-8");
}

function makeCtx(models = MODELS) {
	return {
		cwd: projectDir,
		modelRegistry: {
			find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
			getAvailable: () => models,
		},
	};
}

test("refuses without an advisor model", async () => {
	writeOverrides({});

	const result = await executeAdvisor(makeCtx(), {}, { question: "is this right?" }, undefined, undefined);

	assert.match(result.content[0].text, /No advisor model is configured/);
	assert.match(result.content[0].text, /\/subagents/);
	assert.equal(result.details.errorMessage, "no advisor model selected");
});

test("refuses when the advisor is switched off in /subagents", async () => {
	writeOverrides({ "rpiv-advisor": { model: "github-copilot/gpt-6-sol", enabled: false } });

	const result = await executeAdvisor(makeCtx(), {}, { question: "is this right?" }, undefined, undefined);

	// A deliberate off switch must not read as "unconfigured": that would send
	// the executor to configure a stage the user turned off on purpose.
	assert.match(result.content[0].text, /switched off in \/subagents/);
	assert.equal(result.details.errorMessage, "advisor disabled in /subagents");
});

test("refuses without a compressor model and names the remedy", async () => {
	writeOverrides({ "rpiv-advisor": { model: "github-copilot/gpt-6-sol", thinking: "high" } });

	const result = await executeAdvisor(makeCtx(), {}, { question: "is this right?" }, undefined, undefined);

	assert.match(result.content[0].text, /No compressor model is configured/);
	// The refusal is the only place the executor can learn what fixes it.
	assert.match(result.content[0].text, /\/subagents/);
	assert.equal(result.details.errorMessage, "no compressor model selected");
	// The advisor's own selection is still reported, so the failure is
	// attributable to the missing stage rather than looking unconfigured.
	assert.equal(result.details.advisorModel, "github-copilot:gpt-6-sol");
});

test("refuses without a question once both models are configured", async () => {
	writeOverrides({
		"rpiv-advisor": { model: "github-copilot/gpt-6-sol" },
		"rpiv-compressor": { model: "deepseek/deepseek-flash" },
	});

	const result = await executeAdvisor(makeCtx(), {}, {}, undefined, undefined);

	assert.match(result.content[0].text, /needs a `question`/);
	assert.equal(result.details.errorMessage, "missing question");
});

test("a claude backend stage is never asked for a pi API key", async () => {
	writeOverrides({
		"rpiv-advisor": { model: "claude/opus", thinking: "high" },
		"rpiv-compressor": { model: "deepseek/deepseek-flash", thinking: "low" },
	});

	const spawned = [];
	const authCalls = [];
	const ctx = {
		...makeCtx(),
		sessionManager: { getEntries: () => [], getLeafId: () => undefined },
		modelRegistry: {
			find: (provider, modelId) => MODELS.find((m) => m.provider === provider && m.id === modelId),
			getAvailable: () => MODELS,
			getApiKeyAndHeaders: async (model) => {
				authCalls.push(`${model.provider}/${model.id}`);
				return { ok: true, headers: {} };
			},
		},
	};

	const result = await executeAdvisor(ctx, makeSubagentsPi(spawned), { question: "is this right?" }, undefined, undefined);

	assert.equal(result.details.errorMessage, undefined);
	// The label is the spec the user configures, not a `claude:opus` spelling
	// nothing else accepts.
	assert.equal(result.details.advisorModel, "claude/opus");
	// The run must reach the CLI backend through pi-subagents, which is what
	// resolves `claude/*` to the external harness.
	assert.deepEqual(spawned.map((s) => s.model), ["deepseek/deepseek-flash", "claude/opus"]);
	// pi's registry can never hold a key for the CLI, so asking fails a stage
	// that works. The registry model must still be checked.
	assert.deepEqual(authCalls, ["deepseek/deepseek-flash"]);
});

/**
 * The pi-subagents RPC surface `execute.ts` drives, answered for real: two
 * stages spawn, each completes immediately with text, and every spawn is
 * recorded so the model actually requested can be asserted.
 */
function makeSubagentsPi(spawned) {
	const listeners = new Map();
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
			const reply = (data) => notify(`${channel}:reply:${payload.requestId}`, { success: true, data });
			if (channel === "subagents:rpc:ping") return reply({ version: 2 });
			if (channel === "subagents:rpc:stop" || channel === "subagents:rpc:consume") return reply(undefined);
			if (channel !== "subagents:rpc:spawn") return undefined;
			spawned.push({ type: payload.type, model: payload.options.model });
			const id = `agent-${spawned.length}`;
			const event = { id, type: payload.type, description: payload.options.description };
			notify("subagents:started", event);
			notify("subagents:completed", { ...event, status: "completed", result: "A staged approach." });
			return setTimeout(() => reply({ id }), 0);
		},
	};
	return { events, getAllTools: () => [] };
}

test("a blank question is treated as absent", async () => {
	writeOverrides({
		"rpiv-advisor": { model: "github-copilot/gpt-6-sol" },
		"rpiv-compressor": { model: "deepseek/deepseek-flash" },
	});

	const result = await executeAdvisor(makeCtx(), {}, { question: "   \n  " }, undefined, undefined);

	assert.equal(result.details.errorMessage, "missing question");
});
