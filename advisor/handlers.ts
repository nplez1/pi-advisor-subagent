/**
 * handlers — mid-session lifecycle handlers. A shared reconcileAdvisorTool
 * strips or re-adds the advisor tool to match the blocked state (with an
 * optional notify), and the three register*Handler functions wire it to
 * before_agent_start, model_select, and thinking_level_select.
 *
 * Every decision reads the selection live from `/subagents` rather than a
 * module-level copy, so a menu change takes effect on the next turn instead of
 * at the next session_start. That costs one small JSON read per turn and buys
 * the invariant this plugin is built on: the tool's state and the reported model
 * always describe the configuration that is actually in force.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey } from "@juicesharp/rpiv-config";
import { ADVISOR_TOOL_NAME, MSG_ADVISOR_DISABLED, msgAdvisorRestored } from "./messages.js";
import { isExecutorBlocked, isModelBlocked } from "./policy.js";
import { resolveAdvisorSelection } from "./selection.js";

interface ReconcileNotify {
	/** Shown when the tool is stripped (executor became blocked). */
	disabled: string;
	/** Shown when the tool is re-added (executor became unblocked). */
	restored: string;
}

// Strip-or-add the advisor tool to match the blocked state, with an optional
// notify on each transition. Reads the active-tool list itself. Shared by the
// lifecycle handlers and the session_start restore path.
export function reconcileAdvisorTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { blocked: boolean; notify?: ReconcileNotify },
): void {
	const active = pi.getActiveTools();
	const hasTool = active.includes(ADVISOR_TOOL_NAME);
	if (opts.blocked && hasTool) {
		pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
		if (opts.notify && ctx.hasUI) ctx.ui.notify(opts.notify.disabled, "info");
	} else if (!opts.blocked && !hasTool) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
		if (opts.notify && ctx.hasUI) ctx.ui.notify(opts.notify.restored, "info");
	}
}

/** The label the pipeline reports for a resolved stage. */
const labelOf = (model: { provider: string; id: string }): string => `${model.provider}:${model.id}`;

export function registerAdvisorBeforeAgentStart(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		// Switched off in /subagents, or no model resolved → blocked (strip).
		// Otherwise defer to the executor blocklist. Routes through the reconcile
		// hub so all strip/add logic lives in one place.
		const { advisor } = resolveAdvisorSelection(ctx);
		const blocked = advisor.disabled || !advisor.model || isExecutorBlocked(ctx, pi.getThinkingLevel());
		reconcileAdvisorTool(pi, ctx, { blocked });
	});
}

export function registerModelSelectHandler(pi: ExtensionAPI): void {
	pi.on("model_select", async (event, ctx) => {
		// session_start restore path is owned by restoreAdvisorState — it already
		// activates the tool and notifies. Skipping "restore" here prevents a
		// duplicate notification on initial model load.
		if (event.source === "restore") return;

		const { advisor } = resolveAdvisorSelection(ctx);
		// No usable advisor → the strip is restore's decision, not this handler's.
		if (advisor.disabled || !advisor.model) return;

		reconcileAdvisorTool(pi, ctx, {
			blocked: isModelBlocked(event.model, pi.getThinkingLevel()),
			notify: {
				disabled: `Advisor disabled for ${modelKey(event.model)}`,
				restored: msgAdvisorRestored(labelOf(advisor.model), advisor.effort),
			},
		});
	});
}

export function registerThinkingLevelSelectHandler(pi: ExtensionAPI): void {
	pi.on("thinking_level_select", async (event, ctx) => {
		const { advisor } = resolveAdvisorSelection(ctx);
		if (advisor.disabled || !advisor.model) return;

		// `blocked === true` implies a defined model (isModelBlocked returns false
		// for undefined), so the MSG_ADVISOR_DISABLED fallback is unreachable — it
		// only keeps the disabled string total without a non-null assertion on the model.
		const model = ctx?.model;
		reconcileAdvisorTool(pi, ctx, {
			blocked: isModelBlocked(model, event.level),
			notify: {
				disabled: model ? `Advisor disabled for ${modelKey(model)}` : MSG_ADVISOR_DISABLED,
				restored: msgAdvisorRestored(labelOf(advisor.model), advisor.effort),
			},
		});
	});
}
