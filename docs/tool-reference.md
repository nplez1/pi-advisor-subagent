# `advisor` tool reference

The exact surface rpiv-advisor registers: the tool's schema, its result envelope, what gets sent to the reviewer, and the rules that decide when the tool is visible to the executor model.

## Signature

```ts
advisor({
  question: string  // required
})
```

One required parameter: `question`, the decision, assumption, or failure the
executor wants reviewed. It is required because the whole payload is aimed at it
— the compressor is told to answer it and the reviewer is told it is the brief.
A call with a blank or missing question returns a refusal tool result naming the
parameter rather than compressing against nothing.

The conversation branch is read live from the session manager at call time and
serialised automatically; the executor supplies only the question.

## What the reviewer receives

The payload is assembled in two stages.

**Stage 1 — digest.** The resolved branch is serialized compactly (media payload
bytes replaced by metadata markers, host-only `usage`/`details` metadata
dropped, prior advisor guidance collapsed to a marker) and handed to the
compressor model together with the executor's `question`. The compressor runs as
its own `rpiv-compressor` pi-subagents child with
`prompts/compressor-system.txt` supplied in the user turn. It is told explicitly
not to give advice or reach a verdict and to cite message and tool-call IDs for
factual claims, because a digest that argues a conclusion pre-empts the review —
and it is told what the reviewer gets independently of it, so it does not spend
its output duplicating the recent tail.

**Stage 2 — review.** The reviewer receives, in this order:

1. **The question**, verbatim.
2. **The digest** — or, when compression failed, an explicit
   `Compression unavailable (…)` marker in its place.
3. **A timeline** — one line per message older than the recent window, each
   prefixed with its message index (`#12`), carrying role, tool name, tool-call
   ID, success/error status, body length, and a 120-character excerpt. A
   thinking-only message gets no line at all: reasoning is the compressor's
   material, not chronology.
4. **Every user message**, verbatim and never truncated. Messages already
   reproduced in the recent window are skipped.
5. **The recent window** — the last 6 messages, each clipped at 1500 characters
   with both ends kept and the elision labelled `… [+N chars omitted]`.
6. **The executor's tool inventory** — tool names plus the first line of each
   description (`names` detail). Parameter schemas are deliberately omitted;
   they were previously re-sent in full on every call.
7. **Assembly notes** telling the reviewer that the digest is model-written and
   may be wrong, that the timeline and recent window are computed mechanically
   and are authoritative, that `#N` markers are message indices valid in both
   sections, that an omission marker is a clip rather than the end of a body, and
   that the absence of reasoning in the timeline does not mean none occurred.

The timeline is capped at `SKELETON_MAX_CHARS` (24000 characters). When the cap
bites, the middle is elided with a labelled marker and both ends are kept — the
oldest messages carry the task setup, the newest sit adjacent to the recent
window, and the middle is what the digest exists to cover.

### Design constraints this encodes

- **Ground truth is additive and independent.** The timeline is computed from the
  session, never from the compressor's judgement, and it is sent even when the
  digest succeeded. A compression stage that silently dropped the evidence of the
  executor's own mistake would otherwise be undetectable.
- **Every elision is labelled.** A silently shortened tool result reads as "this
  was the whole output" and would have the reviewer reasoning from a false
  premise — worse than sending less.
- **Compression failure degrades; configuration failure refuses.** A configured
  compressor that fails at runtime loses its digest but never the floor. No
  compressor configured at all refuses the call, because there is no safe
  substitute for a model the user did not choose.
- **Prior guidance is not re-sent.** Earlier `advisor()` results in the branch
  collapse to a one-line marker. Their content was already acted on and already
  sits in the executor's context; re-sending it double-charges and is what made
  repeat consultations grow superlinearly.

## Result envelope

```ts
{
  content: [{ type: "text", text: string }], // reviewer's guidance, or an error message
  details: {
    advisorModel?: string,   // "<provider>:<modelId>" — colon-joined
    effort?: ThinkingLevel,  // the reasoning level actually sent
    compressorModel?: string, // colon-joined, same convention
    compressorEffort?: ThinkingLevel,
    compression?: "ok" | "failed",
    compressionError?: string,   // populated when compression degraded
    payloadChars?: number,       // characters handed to the reviewer
    payloadStats?: PayloadStats, // per-section character counts
    branchChars?: number,        // characters handed to the compressor
    usage?: Usage,               // reviewer token usage
    compressorUsage?: Usage,     // digest-stage token usage
    stopReason?: StopReason,
    errorMessage?: string,       // populated on every failure path
  }
}
```

The payload telemetry exists so the split is measurable rather than assumed:
`branchChars` is what the cheap model read, `payloadChars` is what the premium
model read, and both usages are reported. The completed guidance is also
annotated with a one-line breakdown, so a run where the digest failed or grew
outsized is visible in the transcript without inspecting details.

`details.effort` and `details.compressorEffort` are snapshotted once at entry,
so they always match the `reasoning` values sent to the children even if a
selection changes mid-call.

Note that `details.advisorModel` uses the **colon** form (`provider:modelId`),
unlike the slash-form `modelKey` persisted in `advisor.json`.

## Failure paths

Every failure returns a normal tool result — the executor reads the text and
keeps going rather than crashing the turn.

| `content` text | `details.errorMessage` |
| --- | --- |
| `No advisor model is configured. The user can enable one with the /advisor command.` | `no advisor model selected` |
| `No compressor model is configured, so the advisor context cannot be built. Run /advisor to select one — the four-step flow sets the advisor model, its effort, the compressor model, and its effort.` | `no compressor model selected` |
| `advisor() needs a \`question\`. State the specific decision, assumption, or problem you want reviewed…` | `missing question` |
| `Advisor (<label>) is misconfigured: <err>` | the registry's auth error |
| `Advisor (<label>) has no API key available.` | `no API key for <provider>` |
| `Advisor call was cancelled before it completed.` | the provider's error message, or `aborted` |
| `Advisor call failed: <err>` | the provider's error message |
| `Advisor returned no text content.` | `empty response` |
| `Advisor call threw: <msg>` | the thrown message |

The compressor is a different matter: a compressor that is *configured but
fails* does not fail the call. The reviewer receives the
`Compression unavailable (…)` marker followed by the full deterministic floor,
and `details.compression` reports `"failed"` with `compressionError` set. A
compressor that is absent is a configuration error and refuses, above; one that
breaks at runtime is a degraded call, not a lost one.

## When the tool is active

The tool is always **registered** — but it is stripped from the *active* tool
set, meaning the executor model cannot see it and its `promptSnippet` /
`promptGuidelines` drop out of the system prompt, whenever any of:

1. No advisor model is selected.
2. `modelKey` is absent, unparseable, or names a model that is no longer in Pi's
   registry at restore time. The stale in-memory selection is cleared too.
3. The current **executor** model matches a `disabledForModels` entry — see
   [configuration.md](./configuration.md#disabledformodels).

This is what "off costs nothing" means: with no model configured, none of the
advisor's prompt text ever enters the system prompt.

## Lifecycle hooks

| Event | What happens |
| --- | --- |
| `session_start` | Reload `advisor.json`, re-apply model / effort / blocklist, activate or strip, announce once per process. |
| `before_agent_start` | Per-turn reconcile: blocked when no model is selected or the executor is blocklisted. |
| `model_select` | Re-reconcile on executor model change. Skipped for `source === "restore"` to avoid a duplicate notification. |
| `thinking_level_select` | Re-reconcile on reasoning-effort change. |

The three mid-session hooks route through a shared strip-or-add hub
(`reconcileAdvisorTool`). `session_start` uses that hub for the strip path and
adds the tool directly on the restore path.

## `/advisor` picker keys

Each of the four steps is titled for the stage it configures — `Advisor · Model`,
`Advisor · Reasoning Level`, `Compressor · Model`, `Compressor · Reasoning Level`
— and carries prose naming that stage. The titles and prose differ per stage on
purpose: a picker that does not say which stage it belongs to renders an
identical panel for two of the four steps, which reads as the command asking the
same question twice instead of configuring a pipeline. A test asserts that no
panel string is shared between the two stages.

All four pickers (advisor model, advisor effort, compressor model, compressor
effort) show up to 10 rows and share the hint
`type to filter • ↑↓ navigate • enter select • esc cancel`.

| Key | Effect |
| --- | --- |
| any printable character | appends to the fuzzy filter and rebuilds the list |
| Backspace | deletes one character from the filter |
| ↑ / ↓ | navigate; ↑ from the first row wraps to the last |
| Enter | select |
| Esc | cancel — the command exits without changing anything |

The filter scores against both the visible label (`Name  (provider)`) and the
underlying `provider/modelId` value, ranking contiguous runs and word-boundary
matches higher — so `op4` and `anthropic` both narrow the list.

`/advisor` requires an interactive TTY. Without one it notifies
`/advisor requires interactive mode` and returns.

## Host compatibility

This fork requires pi-subagents with cross-extension RPC protocol v2 and the
global agent definitions at `~/.pi/agent/agents/rpiv-advisor.md` and
`~/.pi/agent/agents/rpiv-compressor.md`. If the extension is not active, or
either profile cannot be resolved or fails its frontmatter assertion, the call
returns a normal error tool result rather than silently falling back to a hidden
model call. The profile sources are kept at
`~/Code/pi-advisor-subagent/agents/`.
