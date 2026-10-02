/**
 * Refusal-path tests for the two-stage advisor call.
 *
 * These paths must return a normal tool result rather than throwing, and must
 * name the remedy: the executor has no other way to learn that the pipeline is
 * unconfigured, and a bare failure would read as a broken tool.
 *
 * A bare `ctx` is sufficient because every refusal is decided before the call
 * touches the model registry or the session.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { executeAdvisor } from "../advisor/execute.ts";
import {
	setAdvisorEffort,
	setAdvisorModel,
	setCompressorEffort,
	setCompressorModel,
} from "../advisor/state.ts";

const model = (provider, id) => ({ provider, id, name: id });

test("refuses without an advisor model", async () => {
	setAdvisorModel(undefined);
	setAdvisorEffort(undefined);
	setCompressorModel(undefined);
	setCompressorEffort(undefined);

	const result = await executeAdvisor({}, {}, { question: "is this right?" }, undefined, undefined);

	assert.match(result.content[0].text, /No advisor model is configured/);
	assert.equal(result.details.errorMessage, "no advisor model selected");
});

test("refuses without a compressor model and names the remedy", async () => {
	setAdvisorModel(model("github-copilot", "gpt-6-sol"));
	setAdvisorEffort("high");
	setCompressorModel(undefined);
	setCompressorEffort(undefined);

	const result = await executeAdvisor({}, {}, { question: "is this right?" }, undefined, undefined);

	assert.match(result.content[0].text, /No compressor model is configured/);
	// The refusal is the only place the executor can learn what fixes it.
	assert.match(result.content[0].text, /\/advisor/);
	assert.equal(result.details.errorMessage, "no compressor model selected");
	// The advisor's own selection is still reported, so the failure is
	// attributable to the missing stage rather than looking unconfigured.
	assert.equal(result.details.advisorModel, "github-copilot:gpt-6-sol");
});

test("refuses without a question once both models are configured", async () => {
	setAdvisorModel(model("github-copilot", "gpt-6-sol"));
	setCompressorModel(model("deepseek", "deepseek-flash"));

	const result = await executeAdvisor({}, {}, {}, undefined, undefined);

	assert.match(result.content[0].text, /needs a `question`/);
	assert.equal(result.details.errorMessage, "missing question");
});

test("a blank question is treated as absent", async () => {
	setAdvisorModel(model("github-copilot", "gpt-6-sol"));
	setCompressorModel(model("deepseek", "deepseek-flash"));

	const result = await executeAdvisor({}, {}, { question: "   \n  " }, undefined, undefined);

	assert.equal(result.details.errorMessage, "missing question");
});
