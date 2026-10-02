/**
 * inventory — stable tool-inventory Message for advisor prompt-cache parity.
 *
 * globalThis-keyed (Symbol.for("rpiv-advisor")) so the cache survives module
 * re-import on /new, /fork, /resume (mirrors rpiv-btw/btw.ts). Single-slot — the
 * Pi tool registry is process-scoped, so per-session keying would be redundant;
 * the cache invalidates only when the set of registered tool names changes. Also
 * exposes the key-sorted JSON serializer (stableStringify) the block is built from.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

const ADVISOR_STATE_KEY = Symbol.for("rpiv-advisor");

interface AdvisorState {
	inventorySignature?: string;
	inventoryMessage?: Message;
}

function getAdvisorRuntimeState(): AdvisorState {
	const g = globalThis as unknown as { [k: symbol]: AdvisorState | undefined };
	let state = g[ADVISOR_STATE_KEY];
	if (!state) {
		state = {};
		g[ADVISOR_STATE_KEY] = state;
	}
	return state;
}

// Recursive key-sorted JSON serializer — matches JSON.stringify semantics
// (drops `undefined` in objects, emits `null` for `undefined` in arrays) but
// guarantees stable key ordering across V8 insertion-order variation. Required
// because nested TypeBox schemas may be authored in any order, and prompt
// caching is byte-sensitive.
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const entries: string[] = [];
	for (const k of Object.keys(obj).sort()) {
		const v = obj[k];
		if (v === undefined) continue;
		entries.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
	}
	return `{${entries.join(",")}}`;
}

export type InventoryDetail = "names" | "full";

function buildInventoryBlock(tools: ToolInfo[], detail: InventoryDetail): string {
	return tools
		.map((t) => {
			if (detail === "full") {
				// Omit `sourceInfo` — its `path` field is install-location-dependent and
				// would bust cache parity across machines/reinstalls.
				return `### ${t.name}\n${t.description}\n\nParameters: ${stableStringify(t.parameters)}`;
			}
			// Names plus the first description line only. The reviewer needs to know
			// what the executor *can* do in order to suggest an approach; it does not
			// need every parameter schema for that, and the schemas were being re-sent
			// in full on every single call.
			const firstLine = (t.description ?? "")
				.split("\n")
				.find((line) => line.trim().length > 0);
			return `- ${t.name}: ${(firstLine ?? "").trim()}`;
		})
		.join("\n");
}

// Returns `undefined` when the registry is empty (no extensions loaded) so
// callers can skip prepending an empty block that would still cost a cache unit.
export function getInventoryMessage(tools: ToolInfo[], detail: InventoryDetail = "names"): Message | undefined {
	if (tools.length === 0) return undefined;
	const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	// The detail level is part of the signature: a cached full-schema block must
	// never be handed back to a caller that asked for names only.
	const signature = `${detail}|${sorted.map((t) => t.name).join("|")}`;
	const state = getAdvisorRuntimeState();
	if (state.inventorySignature === signature && state.inventoryMessage) {
		return state.inventoryMessage;
	}
	const heading = detail === "full" ? "## Available Executor Tools" : "## Executor tool inventory";
	const text = `${heading}\n\n${buildInventoryBlock(sorted, detail)}`;
	const message: Message = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
	state.inventorySignature = signature;
	state.inventoryMessage = message;
	return message;
}
