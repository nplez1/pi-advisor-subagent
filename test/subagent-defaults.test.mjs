/**
 * `/subagents` bridge tests: the advisor pipeline must honour a per-agent
 * default configured in pi-subagents' `subagents.json`.
 *
 * The read touches two real files (`<agentDir>/subagents.json` and
 * `<cwd>/.pi/subagents.json`), so both are redirected into temp dirs here —
 * otherwise the developer's own configuration would decide the outcome.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const xdg = mkdtempSync(join(tmpdir(), "rpiv-advisor-xdg-"));
const agentDir = mkdtempSync(join(tmpdir(), "rpiv-advisor-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "rpiv-advisor-project-"));
process.env.XDG_CONFIG_HOME = xdg;
process.env.PI_CODING_AGENT_DIR = agentDir;

mkdirSync(join(projectDir, ".pi"), { recursive: true });

writeFileSync(
	join(agentDir, "subagents.json"),
	JSON.stringify({
		agentOverrides: {
			"rpiv-advisor": { model: "global/advisor", thinking: "high" },
			"rpiv-compressor": { model: "global/compressor" },
		},
	}),
	"utf-8",
);
writeFileSync(
	join(projectDir, ".pi", "subagents.json"),
	JSON.stringify({ agentOverrides: { "rpiv-advisor": { thinking: "low" } } }),
	"utf-8",
);

const { readSubagentDefault, resolveSubagentDefaultModel } = await import(
	"../advisor/subagent-defaults.ts"
);
const { restoreAdvisorState } = await import("../advisor/restore.ts");

test.after(() => {
	rmSync(xdg, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

test("project overrides global per field, leaving the other field inherited", () => {
	assert.deepEqual(readSubagentDefault("rpiv-advisor", projectDir), {
		model: "global/advisor",
		thinking: "low",
	});
});

test("a global-only entry is read whole", () => {
	assert.deepEqual(readSubagentDefault("rpiv-compressor", projectDir), {
		model: "global/compressor",
	});
});

test("agent names match case-insensitively", () => {
	assert.equal(readSubagentDefault("RPIV-ADVISOR", projectDir).thinking, "low");
});

test("no cwd means no default, so a bare context never reads global config", () => {
	assert.deepEqual(readSubagentDefault("rpiv-advisor", undefined), {});
});

test("an unknown agent has no default", () => {
	assert.deepEqual(readSubagentDefault("nobody", projectDir), {});
});

test("resolveSubagentDefaultModel accepts exact and bare ids, undefined otherwise", () => {
	const models = [
		{ provider: "global", id: "advisor", name: "Advisor" },
		{ provider: "deepseek", id: "flash", name: "Flash" },
	];
	const ctx = {
		modelRegistry: {
			find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
			getAvailable: () => models,
		},
	};
	assert.equal(resolveSubagentDefaultModel("global/advisor", ctx)?.id, "advisor");
	assert.equal(resolveSubagentDefaultModel("flash", ctx)?.id, "flash");
	assert.equal(resolveSubagentDefaultModel("missing/model", ctx), undefined);
	assert.equal(resolveSubagentDefaultModel(undefined, ctx), undefined);
});

test("a /subagents default alone keeps the tool active", () => {
	// No advisor.json selection exists to fall back on — agentOverrides is the only
	// source, so this asserts the project-scoped default is enough on its own.
	const activeTools = ["read"];
	const notifications = [];
	const ctx = {
		cwd: projectDir,
		hasUI: true,
		model: undefined,
		ui: { notify: (msg) => notifications.push(msg) },
		modelRegistry: {
			find: (provider, id) =>
				provider === "global" && id === "advisor" ? { provider, id, name: "Advisor" } : undefined,
		},
	};
	const pi = {
		getThinkingLevel: () => "high",
		getActiveTools: () => [...activeTools],
		setActiveTools: (next) => {
			activeTools.length = 0;
			activeTools.push(...next);
		},
	};

	restoreAdvisorState(ctx, pi);

	assert.ok(activeTools.includes("advisor"), "the tool must not be stripped when /subagents supplies a model");
	assert.match(notifications[0] ?? "", /global:advisor/);
});
