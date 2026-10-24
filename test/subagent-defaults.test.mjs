/**
 * `/subagents` bridge tests: the advisor pipeline must honour a per-agent
 * default configured in pi-subagents' `subagents.json`.
 *
 * The read touches two real files (`<agentDir>/subagents.json` and
 * `<cwd>/.pi/subagents.json`), so both are redirected into temp dirs here —
 * otherwise the developer's own configuration would decide the outcome.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const { readSubagentDefault, isClaudeCodeEnabled, resolveSubagentDefaultModel } = await import(
	"../advisor/subagent-defaults.ts"
);
const { __resetAdvisorAnnounced, restoreAdvisorState } = await import("../advisor/restore.ts");

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

// A `claude/*` spec is an execution backend, not a pi model: the run is
// executed by the external `claude` CLI, so no registry entry will ever exist
// for it. Resolving it through the registry reported a working configuration as
// stale — the whole point of these tests.
const claudeCtx = (models = []) => ({
	modelRegistry: {
		find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
		getAvailable: () => models,
	},
});

test("claude/* specs resolve to the Claude Code backend, not the registry", () => {
	for (const spec of ["claude/opus", "claude/sonnet", "claude/haiku"]) {
		const model = resolveSubagentDefaultModel(spec, claudeCtx());
		assert.ok(model, `${spec} must resolve without a registry entry`);
		assert.equal(model.provider, "claude");
		assert.equal(model.claudeCodeBackend, true);
		assert.equal(`${model.provider}/${model.id}`, spec);
	}
});

test("a full Claude Code id passes through untouched", () => {
	// Anything after `claude/` is handed to `claude --model`, so the spec must not
	// be normalized against a list that goes stale with every release.
	const model = resolveSubagentDefaultModel("claude/claude-sonnet-4-5-20250929", claudeCtx());
	assert.equal(model?.id, "claude-sonnet-4-5-20250929");
});

test("a bare `claude/` is not a backend request", () => {
	// Spawning a CLI whose `--model` is empty would be worse than an unknown model.
	assert.equal(resolveSubagentDefaultModel("claude/", claudeCtx()), undefined);
});

test("a registry provider named claude keeps its own models", () => {
	const own = { provider: "claude", id: "opus", name: "User-defined" };
	const model = resolveSubagentDefaultModel("claude/opus", claudeCtx([own]));
	assert.equal(model?.name, "User-defined");
	assert.equal(model?.claudeCodeBackend, undefined);
});

// The backend switch lives in the same `subagents.json` `/subagents` writes, so
// a machine that cannot run the `claude` CLI simply sets `claudeCode: false`.
const PROJECT_OVERRIDES = join(projectDir, ".pi", "subagents.json");
const originalProjectOverrides = readFileSync(PROJECT_OVERRIDES, "utf-8");

function writeClaudeOff() {
	writeFileSync(
		PROJECT_OVERRIDES,
		JSON.stringify({
			claudeCode: false,
			agentOverrides: {
				"rpiv-advisor": { model: "claude/opus", thinking: "high" },
				"rpiv-compressor": { model: "deepseek/deepseek-flash" },
			},
		}),
		"utf-8",
	);
}

test("a switched-off Claude Code backend stops resolving claude specs", () => {
	writeClaudeOff();
	const ctx = { cwd: projectDir, modelRegistry: { find: () => undefined, getAvailable: () => [] } };

	assert.equal(resolveSubagentDefaultModel("claude/opus", ctx), undefined);
	// A context with no project scope decides nothing, so the default stands.
	const bare = { modelRegistry: { find: () => undefined, getAvailable: () => [] } };
	assert.ok(resolveSubagentDefaultModel("claude/opus", bare));
});

test("a switched-off backend is reported with its remedy, not as a stale key", async () => {
	writeClaudeOff();
	__resetAdvisorAnnounced();
	try {
		const { resolveAdvisorSelection } = await import("../advisor/selection.ts");
		const selection = resolveAdvisorSelection({
			cwd: projectDir,
			modelRegistry: { find: () => undefined, getAvailable: () => [] },
		});
		// The distinction matters: a stale key is fixed in /subagents, a switched-off
		// backend needs either a provider model or the switch flipped.
		assert.equal(selection.advisor.unavailable, "claude-code-disabled");
		// The compressor's key is a pi model that is simply absent from this registry.
		assert.equal(selection.compressor.model, undefined);
		assert.equal(selection.compressor.unavailable, "registry");

		const activeTools = ["advisor", "read"];
		const notifications = [];
		restoreAdvisorState(
			{
				cwd: projectDir,
				hasUI: true,
				model: undefined,
				ui: { notify: (msg, level) => notifications.push({ msg, level }) },
				modelRegistry: { find: () => undefined, getAvailable: () => [] },
			},
			{
				getThinkingLevel: () => "high",
				getActiveTools: () => [...activeTools],
				setActiveTools: (next) => {
					activeTools.length = 0;
					activeTools.push(...next);
				},
			},
		);

		const [note] = notifications;
		assert.equal(note.level, "warning");
		assert.doesNotMatch(note.msg, /no longer available/);
		assert.match(note.msg, /Claude Code CLI, which is disabled on this machine/);
		assert.match(note.msg, /\/subagents/);
		assert.ok(!activeTools.includes("advisor"), "an unusable stage must not leave the tool active");
	} finally {
		// try/finally, not a trailing write: a failed assertion here must not leave
		// `claudeCode: false` behind for every later test in this file.
		writeFileSync(PROJECT_OVERRIDES, originalProjectOverrides, "utf-8");
	}
});

test("a compressor on a switched-off backend is named as such, not as unconfigured", async () => {
	writeFileSync(
		PROJECT_OVERRIDES,
		JSON.stringify({
			claudeCode: false,
			agentOverrides: {
				"rpiv-advisor": { model: "deepseek/deepseek-flash" },
				"rpiv-compressor": { model: "claude/haiku" },
			},
		}),
		"utf-8",
	);
	try {
		const { resolveAdvisorSelection, describeStage } = await import("../advisor/selection.ts");
		const selection = resolveAdvisorSelection({
			cwd: projectDir,
			modelRegistry: { find: () => undefined, getAvailable: () => [] },
		});
		assert.equal(selection.compressor.unavailable, "claude-code-disabled");
		// "not configured" would send the executor to pick a model it already picked.
		const label = describeStage(selection.compressor);
		assert.match(label, /claude\/haiku/);
		assert.match(label, /Claude Code backend disabled/);
	} finally {
		writeFileSync(PROJECT_OVERRIDES, originalProjectOverrides, "utf-8");
	}
});

test("the file decides, and a published value only covers what no file says", async () => {
	// The invariant is that the advisor never promises a stage the spawn refuses.
	// Both sides read the same two files, so a file value is the one answer they
	// cannot disagree about; pi-subagents' published value is the fallback for the
	// single case a file cannot express (a setting it applied but failed to save),
	// and reading it FIRST would let a hand edit split the two again.
	const { setClaudeCodeFromSettings, clearPublishedClaudeCode } = await import("../advisor/subagent-defaults.ts");
	const ctx = { cwd: projectDir, modelRegistry: { find: () => undefined, getAvailable: () => [] } };
	try {
		assert.ok(resolveSubagentDefaultModel("claude/opus", ctx), "the file sets nothing, so the default stands");

		// Nothing on disk explains this one, so the published value decides.
		setClaudeCodeFromSettings(false);
		assert.equal(resolveSubagentDefaultModel("claude/opus", ctx), undefined);

		// A file that says off outranks a platform that says on.
		writeClaudeOff();
		setClaudeCodeFromSettings(true);
		assert.equal(resolveSubagentDefaultModel("claude/opus", ctx), undefined);

		// …and a file that says on outranks a stale platform that says off.
		writeFileSync(PROJECT_OVERRIDES, JSON.stringify({ claudeCode: true }), "utf-8");
		setClaudeCodeFromSettings(false);
		assert.ok(resolveSubagentDefaultModel("claude/opus", ctx));
	} finally {
		clearPublishedClaudeCode();
		writeFileSync(PROJECT_OVERRIDES, originalProjectOverrides, "utf-8");
	}
});

test("the subscription takes only the session value, and clears it", async () => {
	// The subscription is the path the plugin really uses in a session (the test
	// above calls the setter directly). The point of it is narrow: the ONLY thing a
	// file cannot tell this plugin is a value pi-subagents applied but failed to
	// save. Everything else must come from the files, or a published copy would
	// outlive the line it came from.
	const { registerClaudeCodeSettingSync } = await import("../advisor/handlers.ts");
	const { clearPublishedClaudeCode } = await import("../advisor/subagent-defaults.ts");
	const handlers = new Map();
	const pi = { events: { on: (channel, fn) => handlers.set(channel, fn) } };
	try {
		registerClaudeCodeSettingSync(pi);
		const changed = handlers.get("subagents:settings_changed");
		const loaded = handlers.get("subagents:settings_loaded");
		assert.ok(changed, "the plugin must subscribe to settings_changed");
		assert.ok(loaded, "the plugin must subscribe to settings_loaded");

		// The file says nothing, so a session-only `false` is what decides.
		changed({ settings: { claudeCodeSession: false }, persisted: false });
		assert.equal(isClaudeCodeEnabled(projectDir), false);

		// The effective value in a normal event is just the file's own content, and
		// must be ignored: were it adopted, deleting the line would leave this plugin
		// refusing a stage pi-subagents now runs.
		writeFileSync(PROJECT_OVERRIDES, JSON.stringify({ maxConcurrent: 3 }), "utf-8");
		changed({ settings: { claudeCode: false, maxConcurrent: 3 }, persisted: true });
		assert.equal(isClaudeCodeEnabled(projectDir), true);

		// A successful write clears the session value; startup publishes nothing.
		changed({ settings: { claudeCodeSession: false }, persisted: false });
		assert.equal(isClaudeCodeEnabled(projectDir), false);
		loaded({ settings: { claudeCode: false } });
		assert.equal(isClaudeCodeEnabled(projectDir), true);
	} finally {
		clearPublishedClaudeCode();
		writeFileSync(PROJECT_OVERRIDES, originalProjectOverrides, "utf-8");
	}
});

test("a claude advisor restores without a stale-model warning", () => {
	writeFileSync(
		join(agentDir, "subagents.json"),
		JSON.stringify({
			agentOverrides: {
				"rpiv-advisor": { model: "claude/opus", thinking: "high" },
				"rpiv-compressor": { model: "claude/haiku", thinking: "low" },
			},
		}),
		"utf-8",
	);
	__resetAdvisorAnnounced();

	const activeTools = ["read"];
	const notifications = [];
	const ctx = {
		cwd: projectDir,
		hasUI: true,
		model: undefined,
		ui: { notify: (msg, level) => notifications.push({ msg, level }) },
		modelRegistry: { find: () => undefined, getAvailable: () => [] },
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

	assert.equal(notifications.length, 1);
	const [note] = notifications;
	assert.equal(note.level, "info", "a configured claude backend must not warn");
	assert.doesNotMatch(note.msg, /no longer available/);
	assert.match(note.msg, /claude\/opus, low/); // effort comes from the project override above
	assert.match(note.msg, /Compressor: claude\/haiku, low/);
	assert.ok(activeTools.includes("advisor"));
});
