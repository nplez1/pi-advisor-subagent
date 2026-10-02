/**
 * Package-level tests: the module graph loads, the four-step selection
 * round-trips through advisor.json, and session_start restores both stages.
 *
 * `/advisor` is now the only way to unblock `advisor()` — the call refuses until
 * a compressor is configured — so a load error in command.ts or a mistake in the
 * restore path would leave the tool unusable with no in-band remedy. These tests
 * exist to catch that class of failure outside Pi.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Must be set before the modules load: config.ts resolves its path at import time.
const xdg = mkdtempSync(join(tmpdir(), "rpiv-advisor-test-"));
process.env.XDG_CONFIG_HOME = xdg;

const barrel = await import("../advisor/index.ts");

const {
	__resetAdvisorAnnounced,
	getAdvisorModel,
	getCompressorEffort,
	getCompressorModel,
	loadAdvisorConfig,
	restoreAdvisorState,
	saveAdvisorConfig,
	setAdvisorModel,
	setCompressorModel,
	validateEffort,
} = barrel;

test.after(() => {
	rmSync(xdg, { recursive: true, force: true });
});

test("each picker stage has its own panel identity", async () => {
	const { STAGE_HEADERS } = await import("../advisor-ui.ts");
	const advisor = STAGE_HEADERS.advisor;
	const compressor = STAGE_HEADERS.compressor;

	// The bug this guards: every picker rendered the same "Advisor Tool" panel
	// with prose about "the advisor", so step 3 was visually identical to step 1
	// and step 4 to step 2. The four-step flow read as the command asking the same
	// question twice.
	assert.notEqual(advisor.modelTitle, compressor.modelTitle);
	assert.notEqual(advisor.effortTitle, compressor.effortTitle);
	assert.notEqual(advisor.effortProse, compressor.effortProse);

	// No string may be shared across stages at all — the strongest form of the
	// invariant, and what catches a copy-paste slip during a reword.
	const stringsFor = (header) => [header.modelTitle, header.effortTitle, ...header.modelProse, header.effortProse];
	const shared = stringsFor(advisor).filter((s) => stringsFor(compressor).includes(s));
	assert.deepEqual(shared, [], `stages share panel text: ${shared.join(" | ")}`);

	// Every stage must name itself, so the panel is unambiguous on screen.
	for (const stage of ["advisor", "compressor"]) {
		const text = stringsFor(STAGE_HEADERS[stage]).join(" ").toLowerCase();
		assert.match(text, new RegExp(stage), `stage "${stage}" never names itself in its own panel`);
	}
});

test("the module graph loads and exports the pipeline surface", () => {
	for (const name of [
		"registerAdvisorTool",
		"registerAdvisorCommand",
		"registerAdvisorSessionStart",
		"restoreAdvisorState",
		"saveAdvisorConfig",
		"buildAdvisorPayload",
		"buildGroundTruth",
		"serializeTranscript",
		"runChildAgent",
		"getCompressorModel",
		"getCompressorEffort",
		"validateEffort",
	]) {
		assert.ok(typeof barrel[name] === "function", `missing export: ${name}`);
	}
	assert.equal(barrel.DEFAULT_PROMPT_GUIDELINES.length, 8);
	// The guidance must describe the question parameter and must not still claim
	// the whole transcript is forwarded.
	assert.match(barrel.DEFAULT_PROMPT_GUIDELINES[0], /question/);
	assert.match(barrel.DEFAULT_PROMPT_GUIDELINES[0], /raw transcript/);
});

test("a four-step selection round-trips through advisor.json", () => {
	assert.equal(
		saveAdvisorConfig({
			modelKey: "github-copilot/gpt-6-sol",
			effort: "high",
			compressorModelKey: "deepseek/deepseek-flash",
			compressorEffort: "low",
		}),
		true,
	);

	const config = loadAdvisorConfig();
	assert.equal(config.modelKey, "github-copilot/gpt-6-sol");
	assert.equal(config.effort, "high");
	assert.equal(config.compressorModelKey, "deepseek/deepseek-flash");
	assert.equal(config.compressorEffort, "low");
});

test("hand-edited keys survive a save from /advisor", () => {
	saveAdvisorConfig({ modelKey: "a/b", compressorModelKey: "c/d" });
	const path = join(xdg, "rpiv-advisor", "advisor.json");
	const current = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(
		path,
		JSON.stringify({
			...current,
			guidance: { promptSnippet: "custom" },
			disabledForModels: ["x/y"],
		}),
	);

	saveAdvisorConfig({ modelKey: "e/f", compressorModelKey: "g/h" });
	const after = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(after.guidance.promptSnippet, "custom");
	assert.deepEqual(after.disabledForModels, ["x/y"]);
});

test("an empty selection clears every pipeline key", () => {
	saveAdvisorConfig({
		modelKey: "a/b",
		effort: "high",
		compressorModelKey: "c/d",
		compressorEffort: "low",
	});
	saveAdvisorConfig({});

	const config = loadAdvisorConfig();
	assert.equal(config.modelKey, undefined);
	assert.equal(config.effort, undefined);
	assert.equal(config.compressorModelKey, undefined);
	assert.equal(config.compressorEffort, undefined);
});

test("validateEffort drops levels the ordinal cannot rank", () => {
	assert.equal(validateEffort("high", "effort"), "high");
	assert.equal(validateEffort(undefined, "effort"), undefined);
	assert.equal(validateEffort("nonsense", "effort"), undefined);
	assert.equal(validateEffort(42, "compressorEffort"), undefined);
});

function makeEnv({ models, active = [] }) {
	const notifications = [];
	const activeTools = [...active];
	return {
		notifications,
		activeTools,
		ctx: {
			hasUI: true,
			model: undefined,
			ui: { notify: (msg, level) => notifications.push({ msg, level }) },
			modelRegistry: { find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId) },
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

const MODELS = [
	{ provider: "github-copilot", id: "gpt-6-sol", name: "Sol" },
	{ provider: "deepseek", id: "deepseek-flash", name: "Flash" },
];

test("session_start restores both stages and activates the tool", () => {
	saveAdvisorConfig({
		modelKey: "github-copilot/gpt-6-sol",
		effort: "high",
		compressorModelKey: "deepseek/deepseek-flash",
		compressorEffort: "low",
	});
	__resetAdvisorAnnounced();
	setAdvisorModel(undefined);
	setCompressorModel(undefined);

	const env = makeEnv({ models: MODELS, active: ["read"] });
	restoreAdvisorState(env.ctx, env.pi);

	assert.equal(getAdvisorModel()?.id, "gpt-6-sol");
	assert.equal(getCompressorModel()?.id, "deepseek-flash");
	assert.equal(getCompressorEffort(), "low");
	assert.ok(env.activeTools.includes("advisor"));
	assert.match(env.notifications[0].msg, /Advisor restored: github-copilot\/gpt-6-sol, high/);
	assert.match(env.notifications[0].msg, /Compressor: deepseek\/deepseek-flash, low/);
});

test("a stale compressor key clears the stage and says so, without substituting a model", () => {
	saveAdvisorConfig({ modelKey: "github-copilot/gpt-6-sol", compressorModelKey: "gone/model" });
	__resetAdvisorAnnounced();
	setCompressorModel({ provider: "stale", id: "leftover" });

	const env = makeEnv({ models: MODELS, active: [] });
	restoreAdvisorState(env.ctx, env.pi);

	assert.equal(getCompressorModel(), undefined, "a stale selection must not survive as a silent fallback");
	assert.match(env.notifications[0].msg, /no compressor configured/);
	// The tool still activates: the refusal at call time is what tells the
	// executor to run /advisor, so withholding the tool would hide the remedy.
	assert.ok(env.activeTools.includes("advisor"));
});

test("no advisor model strips the tool and clears both stages", () => {
	saveAdvisorConfig({});
	__resetAdvisorAnnounced();
	setAdvisorModel({ provider: "leftover", id: "a" });
	setCompressorModel({ provider: "leftover", id: "b" });

	const env = makeEnv({ models: MODELS, active: ["advisor", "read"] });
	restoreAdvisorState(env.ctx, env.pi);

	assert.ok(!env.activeTools.includes("advisor"));
	assert.equal(getAdvisorModel(), undefined);
	assert.equal(getCompressorModel(), undefined);
});
