import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";

/** Render partial status as text, but keep the full completed guidance visible. */
export function renderAdvisorToolResult(result: AgentToolResult<unknown>, isPartial: boolean) {
	const text = result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n\n");
	if (isPartial) return new Text(text, 0, 0);
	return new Markdown(text, 0, 0, getMarkdownTheme());
}
