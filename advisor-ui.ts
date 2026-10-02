/**
 * advisor-ui — bordered select-panel builders for the /advisor command.
 *
 * Two public functions (showAdvisorPicker, showEffortPicker) share a private
 * showFilterablePicker helper that owns the bordered-container layout, the
 * SelectList theme wiring, and a type-to-filter fuzzy search over the items.
 *
 * Both pickers are stage-aware. The four-step flow asks for two models and two
 * effort levels, so a picker that does not say which stage it belongs to renders
 * an identical panel twice — which reads as the command asking the same question
 * again rather than as a pipeline being configured. Panel prose/titles live here
 * (not in messages.ts) per the convention that messages.ts owns one-line labels
 * while advisor-ui.ts owns the panels.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { filterItems, isBackspace, isPrintable } from "./fuzzy.js";

const MAX_VISIBLE_ROWS = 10;
const NAV_HINT = "type to filter • ↑↓ navigate • enter select • esc cancel";

/** Which stage of the pipeline a picker is configuring. */
export type PickerStage = "advisor" | "compressor";

interface StageHeader {
	modelTitle: string;
	modelProse: string[];
	effortTitle: string;
	effortProse: string;
}

export const STAGE_HEADERS: Record<PickerStage, StageHeader> = {
	advisor: {
		modelTitle: "Advisor · Model",
		modelProse: [
			"When the active model needs stronger judgment — a complex decision, an ambiguous " +
				"failure, a problem it's circling without progress — it escalates to the " +
				"advisor model for guidance, then resumes. The advisor runs server-side " +
				"and uses additional tokens.",
			"For certain workloads, pairing a faster model as the main model with a " +
				"more capable one as the advisor gives near-top-tier performance with " +
				"reduced token usage.",
		],
		effortTitle: "Advisor · Reasoning Level",
		effortProse:
			"Choose the reasoning effort level for the advisor. " +
			"Higher levels produce stronger judgment but use more tokens.",
	},
	compressor: {
		modelTitle: "Compressor · Model",
		modelProse: [
			"This is the second model in the pipeline, not the advisor again. Before each " +
				"consultation the compressor reads the whole conversation once and writes a short " +
				"digest aimed at the question the executor asked; only that digest and a " +
				"mechanically-built timeline reach the advisor.",
			"Pick a cheaper tier than the advisor. The compressor carries the bulk of the " +
				"tokens, so this choice is where the cost of the advisor sits — it does not have " +
				"to be a weak model, only one that selects well for less per input token.",
		],
		effortTitle: "Compressor · Reasoning Level",
		effortProse:
			"Choose the reasoning effort level for the compressor. " +
			"Higher levels select context more carefully but cost more on every consultation.",
	},
};

function selectListTheme(theme: Theme) {
	return {
		selectedPrefix: (t: string) => theme.bg("selectedBg", theme.fg("accent", t)),
		selectedText: (t: string) => theme.bg("selectedBg", theme.bold(t)),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

function buildSelectPanel(
	theme: Theme,
	title: string,
	proseLines: string[],
	query: string,
	selectList: SelectList,
): Container {
	const container = new Container();
	const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));

	container.addChild(border());
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	container.addChild(new Spacer(1));
	for (const line of proseLines) {
		container.addChild(new Text(line, 1, 0));
		container.addChild(new Spacer(1));
	}
	const filterText = query.length > 0 ? `Filter: ${query}` : "Type to filter…";
	container.addChild(new Text(theme.fg(query.length > 0 ? "accent" : "dim", filterText), 1, 0));
	container.addChild(new Spacer(1));
	container.addChild(selectList);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", NAV_HINT), 1, 0));
	container.addChild(new Spacer(1));
	container.addChild(border());
	return container;
}

interface FilterablePickerOptions {
	title: string;
	proseLines: string[];
	items: SelectItem[];
	/** Value to preselect while the query is empty (e.g. the current effort). */
	preferredValue?: string;
}

function showFilterablePicker(ctx: ExtensionContext, opts: FilterablePickerOptions): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let query = "";
		let selectList: SelectList;
		let container: Container;

		const rebuild = () => {
			const filtered = filterItems(opts.items, query);
			const visibleRows = Math.min(Math.max(filtered.length, 1), MAX_VISIBLE_ROWS);
			selectList = new SelectList(filtered, visibleRows, selectListTheme(theme));
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			if (query.length === 0 && opts.preferredValue) {
				const idx = filtered.findIndex((item) => item.value === opts.preferredValue);
				if (idx >= 0) selectList.setSelectedIndex(idx);
			}
			container = buildSelectPanel(theme, opts.title, opts.proseLines, query, selectList);
		};

		rebuild();

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (isBackspace(data)) {
					if (query.length > 0) {
						query = query.slice(0, -1);
						rebuild();
					}
				} else if (isPrintable(data)) {
					query += data;
					rebuild();
				} else {
					selectList.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}

export async function showAdvisorPicker(
	ctx: ExtensionContext,
	items: SelectItem[],
	stage: PickerStage,
): Promise<string | null> {
	const header = STAGE_HEADERS[stage];
	return showFilterablePicker(ctx, {
		title: header.modelTitle,
		proseLines: header.modelProse,
		items,
	});
}

export async function showEffortPicker(
	ctx: ExtensionContext,
	items: SelectItem[],
	currentEffort: ThinkingLevel | undefined,
	defaultEffort: ThinkingLevel,
	stage: PickerStage,
): Promise<string | null> {
	const preferredValue = items.some((item) => item.value === currentEffort) ? currentEffort : defaultEffort;
	const header = STAGE_HEADERS[stage];
	return showFilterablePicker(ctx, {
		title: header.effortTitle,
		proseLines: [header.effortProse],
		items,
		preferredValue,
	});
}
