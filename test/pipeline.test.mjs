/**
 * Package-level tests: the module graph loads, `/subagents` is the single source
 * for both pipeline stages, and session_start activates the tool to match it.
 *
 * These exist because the pipeline is configured from *outside* this plugin now.
 * A mistake in the resolution path or the restore decision would leave the tool
 * either unusable with no in-band remedy or silently running a model the menu
 * never showed, and neither is visible outside Pi.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Both must be set before the modules load: config.ts resolves its path at
// import time, and getAgentDir() decides where the global overrides come from.
const xdg = mkdtempSync(join(tmpdir(), "rpiv-advisor-test-"));
const agentDir = mkdtempSync(join(tmpdir(), "rpiv-advisor-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "rpiv-advisor-project-"));
process.env.XDG_CONFIG_HOME = xdg;
process.env.PI_CODING_AGENT_DIR = agentDir;

mkdirSync(join(projectDir, ".pi"), { recursive: true });

const barrel = await import("../advisor/index.ts");

const {
	__resetAdvisorAnnounced,
	loadAdvisorConfig,
	restoreAdvisorState,
	resolveAdvisorSelection,
	validateDisabledForModels,
	validateEffort,
} = barrel;

test.after(() => {
	rmSync(xdg, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

const MODELS = [
	{ provider: "github-copilot", id: "gpt-6-sol", name: "Sol" },
	{ provider: "deepseek", id: "deepseek-flash", name: "Flash" },
];

/** Write the machine's `/subagents` state — the only store these tests read. */
function writeOverrides(agentOverrides) {
	writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ agentOverrides }), "utf-8");
}

const BOTH_STAGES = {
	"rpiv-advisor": { model: "github-copilot/gpt-6-sol", thinking: "high", enabled: true },
	"rpiv-compressor": { model: "deepseek/deepseek-flash", thinking: "low" },
};

test("the module graph loads and exports the pipeline surface", () => {
	for (const name of [
		"registerAdvisorTool",
		"registerAdvisorCommand",
		"registerAdvisorSessionStart",
		"restoreAdvisorState",
		"resolveAdvisorSelection",
		"buildAdvisorPayload",
		"buildGroundTruth",
		"serializeTranscript",
		"runChildAgent",
		"validateEffort",
		"setDisabledForModels",
	]) {
		assert.ok(typeof barrel[name] === "function", `missing export: ${name}`);
	}
	assert.equal(barrel.DEFAULT_PROMPT_GUIDELINES.length, 8);
	// The guidance must describe the question parameter and must not still claim
	// the whole transcript is forwarded.
	assert.match(barrel.DEFAULT_PROMPT_GUIDELINES[0], /question/);
	assert.match(barrel.DEFAULT_PROMPT_GUIDELINES[0], /raw transcript/);
});

test("advisor.json still owns guidance and the blocklist, and nothing else", () => {
	mkdirSync(join(xdg, "rpiv-advisor"), { recursive: true });
	writeFileSync(
		join(xdg, "rpiv-advisor", "advisor.json"),
		JSON.stringify({
			guidance: { promptSnippet: "custom snippet" },
			disabledForModels: ["x/y", { model: "a/b", minEffort: "high" }],
			// Legacy key: ignored on read, migrated by install.sh, never consulted here.
			modelKey: "legacy/should-be-ignored",
		}),
	);

	const config = loadAdvisorConfig();
	assert.equal(config.guidance.promptSnippet, "custom snippet");
	assert.deepEqual(validateDisabledForModels(config.disabledForModels), ["x/y", { model: "a/b", minEffort: "high" }]);
	assert.equal(config.modelKey, "legacy/should-be-ignored", "the legacy key is still readable, just unused");
});

test("validateEffort drops levels the ordinal cannot rank", () => {
	assert.equal(validateEffort("high", "effort"), "high");
	assert.equal(validateEffort(undefined, "effort"), undefined);
	assert.equal(validateEffort("nonsense", "effort"), undefined);
	assert.equal(validateEffort(42, "compressorEffort"), undefined);
});

test("both stages resolve from agentOverrides, including the off switch", () => {
	writeOverrides(BOTH_STAGES);

	const selection = resolveAdvisorSelection({ cwd: projectDir, modelRegistry: registry() });
	assert.equal(selection.advisor.model?.id, "gpt-6-sol");
	assert.equal(selection.advisor.effort, "high");
	assert.equal(selection.advisor.disabled, false);
	assert.equal(selection.compressor.model?.id, "deepseek-flash");
	assert.equal(selection.compressor.effort, "low");
});

test("`off` resolves to no effort rather than an unrankable level", () => {
	writeOverrides({ "rpiv-advisor": { model: "github-copilot/gpt-6-sol", thinking: "off" } });

	const selection = resolveAdvisorSelection({ cwd: projectDir, modelRegistry: registry() });
	assert.equal(selection.advisor.model?.id, "gpt-6-sol");
	assert.equal(selection.advisor.effort, undefined);
});

function registry(models = MODELS) {
	return {
		find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
		getAvailable: () => models,
	};
}

function makeEnv({ active = [] } = {}) {
	const notifications = [];
	const activeTools = [...active];
	return {
		notifications,
		activeTools,
		ctx: {
			cwd: projectDir,
			hasUI: true,
			model: undefined,
			ui: { notify: (msg, level) => notifications.push({ msg, level }) },
			modelRegistry: registry(),
		},
		pi: {
			getThinkingLevel: () => "high",
			getActiveTools: () => [...activeTools],
			setActiveTools: (next) => {
				activeTools.length = 0;
				activeTools.push(...next);
			},
		},
	};
}

test("session_start activates the tool and reports both stages", () => {
	writeOverrides(BOTH_STAGES);
	__resetAdvisorAnnounced();

	const env = makeEnv({ active: ["read"] });
	restoreAdvisorState(env.ctx, env.pi);

	assert.ok(env.activeTools.includes("advisor"));
	assert.match(env.notifications[0].msg, /Advisor restored: github-copilot:gpt-6-sol, high/);
	assert.match(env.notifications[0].msg, /Compressor: deepseek:deepseek-flash, low/);
});

test("a missing compressor does not strip the tool, and says what is missing", () => {
	writeOverrides({ "rpiv-advisor": { model: "github-copilot/gpt-6-sol", thinking: "high" } });
	__resetAdvisorAnnounced();

	const env = makeEnv();
	restoreAdvisorState(env.ctx, env.pi);

	// The refusal at call time is what tells the executor to fix it, so
	// withholding the tool would hide the remedy behind an absence.
	assert.ok(env.activeTools.includes("advisor"));
	assert.match(env.notifications[0].msg, /no compressor configured/);
});

test("enabled:false strips the tool and reports it as a choice", () => {
	writeOverrides({ ...BOTH_STAGES, "rpiv-advisor": { ...BOTH_STAGES["rpiv-advisor"], enabled: false } });
	__resetAdvisorAnnounced();

	const env = makeEnv({ active: ["advisor", "read"] });
	restoreAdvisorState(env.ctx, env.pi);

	assert.ok(!env.activeTools.includes("advisor"));
	assert.match(env.notifications[0].msg, /Advisor disabled/);
});

test("no advisor model strips the tool and points at /subagents", () => {
	writeOverrides({});
	__resetAdvisorAnnounced();

	const env = makeEnv({ active: ["advisor", "read"] });
	restoreAdvisorState(env.ctx, env.pi);

	assert.ok(!env.activeTools.includes("advisor"));
	assert.match(env.notifications[0].msg, /No advisor model is configured/);
	assert.match(env.notifications[0].msg, /\/subagents/);
});

test("a configured model that is gone from the registry strips the tool and names it", () => {
	writeOverrides({ "rpiv-advisor": { model: "gone/model" } });
	__resetAdvisorAnnounced();

	const env = makeEnv({ active: ["advisor", "read"] });
	restoreAdvisorState(env.ctx, env.pi);

	assert.ok(!env.activeTools.includes("advisor"));
	assert.equal(env.notifications[0].level, "warning");
	assert.match(env.notifications[0].msg, /gone\/model is no longer available/);
});
