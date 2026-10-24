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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Global overrides are read from getAgentDir(); redirect it before loading so the
// developer's own subagents.json cannot decide an outcome here.
const agentDir = mkdtempSync(join(tmpdir(), "rpiv-advisor-exec-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "rpiv-advisor-exec-project-"));
const xdg = mkdtempSync(join(tmpdir(), "rpiv-advisor-exec-xdg-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.XDG_CONFIG_HOME = xdg;

const { executeAdvisor } = await import("../advisor/execute.ts");

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

test("a blank question is treated as absent", async () => {
	writeOverrides({
		"rpiv-advisor": { model: "github-copilot/gpt-6-sol" },
		"rpiv-compressor": { model: "deepseek/deepseek-flash" },
	});

	const result = await executeAdvisor(makeCtx(), {}, { question: "   \n  " }, undefined, undefined);

	assert.equal(result.details.errorMessage, "missing question");
});
