/**
 * rpiv-advisor — Pi extension
 *
 * Registers the `advisor` tool, `/advisor` command, and four lifecycle
 * hooks (session_start restore, before_agent_start strip, model_select
 * re-evaluation, thinking_level_select re-evaluation) that together
 * implement the advisor-strategy pattern.
 *
 * Config persists at ~/.config/rpiv-advisor/advisor.json — but only the policy
 * it owns: `guidance` and `disabledForModels`. The advisor and compressor models
 * and their reasoning levels live in pi-subagents' `agentOverrides`
 * (subagents.json), written by /subagents and read by advisor/selection.ts, so a
 * stage has one configurable home and /advisor only reports it. Tool name
 * preserved verbatim from rpiv-pi@7525a5d.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerAdvisorBeforeAgentStart,
	registerAdvisorCommand,
	registerAdvisorSessionStart,
	registerAdvisorTool,
	registerClaudeCodeSettingSync,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
} from "./advisor/index.js";

export default function (pi: ExtensionAPI) {
	registerClaudeCodeSettingSync(pi);
	registerAdvisorTool(pi);
	registerAdvisorCommand(pi);
	registerAdvisorBeforeAgentStart(pi);
	registerModelSelectHandler(pi);
	registerThinkingLevelSelectHandler(pi);
	registerAdvisorSessionStart(pi);
}
