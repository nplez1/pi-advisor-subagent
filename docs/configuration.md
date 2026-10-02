# rpiv-advisor configuration

Complete reference for `advisor.json` — where it lives, every key it accepts, and how the per-executor blocklist is evaluated.

## Where the file lives

`advisor.json` resolves under the XDG config directory:

| `XDG_CONFIG_HOME` | Resolved path |
| --- | --- |
| unset, empty, or whitespace-only | `~/.config/rpiv-advisor/advisor.json` |
| absolute path | `$XDG_CONFIG_HOME/rpiv-advisor/advisor.json` |
| `~` or `~/…` | tilde expanded, then used as the config dir |
| relative path | ignored → `~/.config/rpiv-advisor/advisor.json` |
| `~user/…` | not expanded → `~/.config/rpiv-advisor/advisor.json` |

`XDG_CONFIG_HOME` is the only environment variable this package reads.

**Legacy read fallback.** If nothing exists at the XDG-resolved path, reads fall
back once to `~/.config/rpiv-advisor/advisor.json` (always `~/.config`, ignoring
`XDG_CONFIG_HOME`). If the XDG path *does* exist, it wins — even when it is
malformed. **Writes always go to the XDG-resolved path only**; there is no
migration or copy of the legacy file.

A missing or malformed file is treated as `{}` — malformed JSON logs a warning
and never crashes the extension.

## File permissions

`/advisor` writes the file with `JSON.stringify(config, null, 2)` plus a
trailing newline, creating parent directories as needed, then chmods it to
`0600` on a best-effort basis. A failed chmod does not fail the save; on Windows
the chmod is a no-op.

Saving happens **before** any in-memory state changes. If the write fails you
get `Failed to save advisor selection — selection not persisted` and both the
previous selection and the active tool list are left untouched.

## Keys

| Key | Type | Default | Written by |
| --- | --- | --- | --- |
| `modelKey` | `string` — `"provider/modelId"` | absent (advisor off) | `/advisor` |
| `effort` | graded thinking level (`minimal` → `max`) | absent (no `reasoning` sent) | `/advisor` effort picker |
| `compressorModelKey` | `string` — `"provider/modelId"` | absent (`advisor()` refuses) | `/advisor` |
| `compressorEffort` | graded thinking level (`minimal` → `max`) | absent (no `reasoning` sent) | `/advisor` effort picker |
| `disabledForModels` | `(string \| { model, minEffort? })[]` | `[]` | hand-edited |
| `guidance.promptSnippet` | `string` | built-in snippet | hand-edited |
| `guidance.promptGuidelines` | `string[]` | eight built-in guidelines | hand-edited |

`/advisor` writes all four selection keys together, and choosing **No advisor**
deletes all four — the reviewer and the compressor are one pipeline, so a
lingering compressor key would only persist into a state that cannot use it.
`guidance` and `disabledForModels` are preserved across saves, so hand-edits
survive.

### `modelKey`

The canonical persisted form is slash-separated — `anthropic/claude-opus-4-5`.
Reads also accept the legacy colon form (`anthropic:claude-opus-4-5`); when both
forms are present the slash form wins. A colon-form key is rewritten to slash
form the next time you save through `/advisor`.

### `effort`

Offered only for models whose registry entry reports reasoning support. The
picker lists `off (no reasoning sent)` plus the graded levels Pi reports for the
selected model. `high` is marked `(recommended)`. Choosing `off` deletes the
key, and no `reasoning` parameter is sent with the advisor call — distinct from
`/rpiv-models`' `off (disable reasoning)`, which persists an explicit
`thinking: "off"`.

`EFFORT_ORDINAL` orders the graded levels lowest → highest; this ordering is what
`minEffort` compares against.

> **Naming note.** Advisor "effort", Pi's "thinking level", and pi-ai's `reasoning`
> parameter are the same graded-level concept — the name differs per layer (fixed by
> on-disk config keys and upstream APIs), but there is no semantic distinction.

### `compressorModelKey`

The model that digests the conversation before the reviewer sees it, in the same
`"provider/modelId"` form, with the same slash/colon read tolerance as
`modelKey`. Configured and resolved exactly like the reviewer model — same
picker, same persistence, same `session_start` restore — and resolved
independently of it.

Pick a cheaper tier than the reviewer. The compressor reads the bulk of the
conversation on every `advisor()` call, so it is where the cost of the pipeline
sits; the reviewer reads only the digest plus the deterministic floor. It does
not need to be a weak model, only one that selects well for less per input
token.

**A missing `compressorModelKey` does not strip the tool.** Each `advisor()`
call refuses with an explicit message naming `/advisor` as the remedy, because
that refusal is the only place the executor can learn what is wrong. This is the
one place the config diverges from `modelKey`'s "absent means advisor off"
semantics, and it is deliberate: an absent reviewer model means the user does not
want the feature, while an absent compressor means the feature is misconfigured —
two different things that should not look the same.

A key naming a model that left Pi's registry is cleared with a warning at
restore time and reported in the restore notification as
`no compressor configured`. No substitute model is chosen.

### `compressorEffort`

Same domain, same picker, and same validation as `effort` — including dropping
hand-edited values the ordinal cannot rank, with a warning and without restoring
them. Applied to the compressor child as its `reasoning` parameter.

### `disabledForModels`

A list of **executor** models for which the advisor tool should be stripped —
useful when you are already driving a top-tier model and do not want to pay for
a second opinion. Two entry forms:

```json
{
  "modelKey": "anthropic/claude-opus-4-5",
  "effort": "high",
  "disabledForModels": [
    "anthropic/claude-opus-4-5",
    { "model": "openai/gpt-5.2", "minEffort": "high" }
  ]
}
```

- **String entry** — blocks at any reasoning effort.
- **Object entry without `minEffort`** — blocks at any reasoning effort.
- **Object entry with `minEffort`** — blocks when the executor's current effort
  is at or above the threshold in `EFFORT_ORDINAL`. Ties block.
- An executor effort of `off` or unset never matches a `minEffort` entry.

Entry keys are canonicalised to slash form before comparison, so a legacy
`"anthropic:claude-opus-4-5"` entry still blocks without a re-save.

**Validation.** A non-array value becomes `[]`. Empty strings are dropped.
Object entries need a non-empty string `model`; an unrecognised `minEffort`
drops the entry. `null`, numbers, booleans and `undefined` are dropped. The
order of surviving entries is preserved.

**Live re-evaluation.** The blocklist is re-applied on `session_start`, on every
turn, whenever you switch executor model, and whenever you change reasoning
effort — so the tool strips and re-adds mid-session as you move around. You see
`Advisor disabled for <provider/model>` when it strips and
`Advisor restored: <label>[, <effort>]` when it comes back.

### `guidance`

Overrides what the executor model is told about *when* to escalate, without
forking the package.

- `guidance.promptSnippet` — a non-empty string replacing the one-line snippet
  that appears in the system prompt.
- `guidance.promptGuidelines` — a non-empty array of non-empty strings replacing
  the eight built-in guidelines.

Either field falls back to its built-in default when absent, empty, or the wrong
type. Both are read once at extension load, so restart your Pi session after
editing them.

The built-in guidelines tell the model to pass a specific `question` (and to put
any detail that must be weighed into it, since the reviewer sees a digest rather
than the raw transcript); to call `advisor` before substantive work, again when
it believes the task is complete (after making the deliverable durable), and
when it is stuck or considering a change of approach; to weight the advice
seriously unless empirically contradicted; and to reconcile conflicting evidence
with one more `advisor` call rather than silently switching.

## Notifications

| String | When |
| --- | --- |
| `Advisor: <label>[, <effort>] • Compressor: <label>[, <effort>]` | you completed the four-step `/advisor` flow |
| `… • no compressor configured — advisor() refuses until you run /advisor` | the same, with **No compressor** chosen |
| `Advisor: … (inactive for current executor)` | selected, but blocked by `disabledForModels` |
| `Advisor restored: <label>[, <effort>] • Compressor: <label>[, <effort>]` | re-applied at session start |
| `Advisor restored: … • no compressor configured — advisor() refuses until you run /advisor` | restored with no compressor, or with a compressor key no longer in the registry |
| `Advisor restored: … (inactive for current executor)` | restored while blocked |
| `Advisor disabled` | you chose **No advisor** |
| `Advisor disabled for <provider/model>` | you switched to a blocklisted executor model or effort |
| `Advisor configuration abandoned at the compressor step — nothing was saved. …` | you pressed Esc at the compressor model picker |
| `Effort not set — advisor uses the model default` | you pressed Esc at an effort picker |
| `Advisor selection not found: <choice>` | the model you picked was no longer in the available-model list when `/advisor` resolved the choice |
| `Previously configured advisor model <key> is no longer available` | the saved reviewer model left Pi's registry |
| `Failed to save advisor selection — selection not persisted` | the write to `advisor.json` failed |
| `/advisor requires interactive mode` | `/advisor` ran without a TTY |

The `Advisor restored: …` announcement fires at most once per process, so
programmatic session spawns (workflow stages, subagents) do not repeat it.
