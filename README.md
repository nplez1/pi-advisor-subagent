# rpiv-advisor-subagent (local fork)

This is a local fork of `@juicesharp/rpiv-advisor`, kept in `~/Code/pi-advisor-subagent`. The original npm package remains installed but is disabled in `~/.pi/agent/settings.json`; this copy keeps the `/advisor` picker and replaces the zero-argument `advisor()` tool with a two-stage pipeline — a configured compressor model digests the conversation, and the reviewer sees that digest plus a deterministic ground-truth floor instead of the whole branch. Each stage runs as a visible pi-subagents child.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-advisor/docs/cover.png" alt="rpiv-advisor cover: an executor model calling advisor() and a stronger reviewer answering with a plan, a correction, or a stop signal" width="50%">
    </picture>
  </a>
</div>

Let the model you're working with ask a second, stronger model a specific question and get back a plan, a correction, or a stop signal — without billing the strong model for the whole conversation. `rpiv-advisor` adds the `advisor` tool (which takes a `question`) and the four-step `/advisor` picker to [Pi Agent](https://github.com/badlogic/pi-mono), so you can drive a session with a fast model and keep a stronger reviewer one call away.

## Local installation

Pi loads this directory as a local package from `~/.pi/agent/settings.json`. Each stage has a dedicated no-tools agent profile — `agents/rpiv-advisor.md` for the reviewer and `agents/rpiv-compressor.md` for the digest stage — and each is linked into `~/.pi/agent/agents/`, where pi-subagents discovers global agent definitions. Keep those paths in place when moving the fork.

Restart Pi after changing the package or agent profile.

## Quick start

Nothing happens until you pick both models. Run:

```
/advisor
```

`/advisor` walks four steps in one pass: the **reviewer** model, its effort
level, the **compressor** model, and its effort level. Each model step is a
picker over every model Pi already has credentials for — start typing to filter
by model name, provider, or `provider/id`. The effort step is offered only for
models that support reasoning (`high` is recommended); press Esc there to keep
the model you just chose and save it with no explicit effort.

The whole run is applied at the end, so abandoning it leaves nothing
half-configured — which is why Esc at the compressor step cancels the run rather
than saving a reviewer that no call could then use. Pi confirms with
`Advisor: <model>, <effort> • Compressor: <model>, <effort>`.

Pick the compressor from a cheaper tier than the reviewer: it reads the bulk of
the conversation, so it is where the cost goes. It does not have to be a weak
model — it has to be one that selects well for less per token.

If the model you want isn't in the list, its provider isn't authenticated yet —
run Pi's `/login` for that provider, then re-run `/advisor`.

![The /advisor picker: a bordered panel above a scrollable list of the models Pi has credentials for, with the current selection highlighted. Captured from the single-picker upstream package; this fork titles each of its four steps separately.](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-advisor/docs/advisor.jpg)

From there the executor model calls `advisor()` on its own when it needs stronger
judgment. To turn it back off, run `/advisor` and choose **No advisor**.

## What you get

- **You say what you want reviewed** — `advisor()` takes a required `question`: the decision, assumption, or failure you want a second opinion on. The reviewer's context is built around it rather than dumped at it.
- **The expensive model reads a digest, not the transcript** — a configured compressor model reads the full resolved branch once and writes a short digest aimed at your question. Only the digest, the ground-truth floor, and the tool inventory reach the reviewer. Media payload bytes are marked as omitted because the subagent runner accepts a text prompt; use a seeded session if image/audio/video fidelity is required.
- **The reviewer keeps an independent floor** — alongside the digest it always receives your user's messages verbatim, your recent turns with every clip labelled, and a mechanically-computed one-line chronology of everything older. The digest is a model's selection and can be wrong; the chronology is computed from the session and cannot be. The reviewer is told which is which, so an omission in the digest cannot hide the evidence of a mistake from it.
- **The reviewer sees what survived compaction** — the branch is built from Pi's resolved LLM context, so compaction and branch summaries are digested instead of a stale raw replay.
- **Prior consultations are not re-charged** — earlier `advisor()` guidance in the branch collapses to a one-line marker. It was already acted on and already sits in the executor's context, so re-sending it would pay for it twice.
- **Any model can be either stage** — every model you're authenticated for is in both pickers, found by fuzzy-typing. No provider is privileged.
- **Pick once, it stays picked** — both models and both effort levels persist to `advisor.json` and are re-applied at every session start.
- **Skip it when you're already on a strong model** — list executor models in `disabledForModels` to strip the tool for them, optionally only at or above a reasoning-effort threshold. It strips and re-adds live as you switch model or effort mid-session.
- **Off costs nothing** — with no reviewer selected the tool is stripped from the active set, so its prompt text never enters the system prompt at all.

## Models come from `/subagents`

Both stages' model and effort are read from pi-subagents' `agentOverrides` in `subagents.json` — `/subagents` is the writer, this plugin reads it live, so the reported model is always the one that runs. `advisor.json` keeps only what `/subagents` cannot express: `guidance` and `disabledForModels`.

Any pi model works for either stage, and so does a **Claude Code backend** spec — `claude/opus`, `claude/sonnet`, `claude/haiku`, or a full id such as `claude/claude-sonnet-4-5-20250929`:

```json
{ "agentOverrides": { "rpiv-advisor": { "model": "claude/opus", "thinking": "high" } } }
```

Those specs are not registry models: pi-subagents runs them on the external `claude` CLI, so they are valid even though neither `enabledModels` nor `models-store.json` lists them. `/advisor`, the session-start notice and the tool result all name them as `claude/opus`, and `advisor()` never asks pi for an API key on their behalf — the CLI authenticates itself. If pi-subagents' [`scopeModels`](../pi-subagents#model-scope) is on, `claude/*` must also be listed in its allowed set — the allowlist cannot see these models any other way, and an unlisted one is refused at spawn.

### Turning the backend off

pi-subagents' `claudeCode` switch applies here too (`subagents.json`, or `/agents` → Settings → Claude Code). On a machine that cannot run the CLI, set `"claudeCode": false`: a stage still pointing at `claude/opus` is then reported as unusable with the switch named — instead of being restored as working and failing at spawn — and `advisor()` refuses rather than letting the spec resolve to some other model. Both sides read the same two files, and pi-subagents re-reads them rather than caching what it saw at startup, so a hand edit cannot make this report and the spawn disagree. Point the stage at a provider model instead; the same Claude models are usually reachable through Copilot, Anthropic or Bedrock:

```json
{ "agentOverrides": { "rpiv-advisor": { "model": "github-copilot/claude-opus-4-5", "thinking": "high" } } }
```

## Configuration

Settings live in `~/.config/rpiv-advisor/advisor.json` (or
`$XDG_CONFIG_HOME/rpiv-advisor/advisor.json` when that variable is set to an
absolute path). `/advisor` creates the file and chmods it to `0600`; a failed
write leaves your previous selection untouched and tells you so.

| Key | What it does | Default |
| --- | --- | --- |
| `modelKey` | The reviewer model, as `"provider/modelId"`. Written by `/advisor`. | absent — advisor off |
| `effort` | Reasoning effort for the reviewer: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Written by `/advisor`; only levels supported by the selected model are offered. | absent — no reasoning sent |
| `compressorModelKey` | The digest-stage model, same form. Also written by `/advisor`. | absent — `advisor()` refuses |
| `compressorEffort` | Reasoning effort for the digest stage, same domain. | absent — no reasoning sent |
| `disabledForModels` | Executor models the advisor is stripped for. Plain strings block at any effort; `{ "model": "…", "minEffort": "…" }` blocks only at or above that effort. | `[]` |

```json
{
  "modelKey": "anthropic/claude-opus-4-5",
  "effort": "high",
  "compressorModelKey": "deepseek/deepseek-flash",
  "compressorEffort": "low",
  "disabledForModels": [
    "anthropic/claude-opus-4-5",
    { "model": "openai/gpt-5.2", "minEffort": "high" }
  ]
}
```

`/advisor` writes all four selection keys together; choosing **No advisor**
clears all four, because the two models are one pipeline. Hand-edited keys —
`disabledForModels` and the `guidance` overrides — survive every save.

An existing `advisor.json` with no compressor key keeps working but every
`advisor()` call will refuse with an explicit message until you run `/advisor`.
That is deliberate: substituting a model you never chose would make the
reviewer's context depend on an invisible decision.

## Reference

- [Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-advisor/docs/configuration.md) — config file resolution, every key, blocklist matching rules, guidance overrides, and the full notification catalogue.
- [`advisor` tool reference](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-advisor/docs/tool-reference.md) — schema, result envelope, failure paths, what gets sent to the reviewer, lifecycle hooks, and picker keys.

## Requirements

- A [Pi Agent](https://github.com/badlogic/pi-mono) host — the extension loads
  through Pi's extension manifest. No native dependencies.
- An authenticated provider for the **reviewer** model, resolved through Pi's
  model registry.
- An authenticated provider for the **compressor** model. `advisor()` refuses
  until one is configured.
- The global agent profiles `~/.pi/agent/agents/rpiv-advisor.md` and
  `~/.pi/agent/agents/rpiv-compressor.md`; a missing one fails the call with a
  `Required pi-subagents profile is missing` error rather than falling back to a
  hidden model call.
- An interactive terminal for `/advisor`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The `/advisor` picker offers only **No advisor** | No provider is authenticated in Pi | Run Pi's `/login` for a provider, then re-run `/advisor` |
| `No compressor model is configured, so the advisor context cannot be built.` comes back as the tool result | `compressorModelKey` is absent from `advisor.json` — the usual state for a config written before the pipeline existed | Run `/advisor` and complete all four steps |
| `Advisor (<model>) has no API key available.` comes back as the tool result | Credentials for that provider no longer resolve | Re-authenticate that provider with `/login` |
| `Advisor (<model>) is misconfigured: …` names the compressor | The compressor's provider is unauthenticated | Re-authenticate, or pick another compressor with `/advisor` |
| `Advisor model claude/… runs on the Claude Code CLI, which is disabled on this machine` | `"claudeCode": false` in `subagents.json` on this machine | Set a provider model for `rpiv-advisor` in `/subagents`, or turn the backend back on (`/agents` → Settings → Claude Code) |
| `Required pi-subagents profile is missing: …/rpiv-compressor.md` | The digest stage's agent profile is not linked | Re-create the symlink from `agents/rpiv-compressor.md` |
| Guidance arrives with `Compression unavailable (…)` above it | The compressor subagent failed; the reviewer got the chronology alone | Nothing to fix for that call — the guard held. Check the compressor model if it recurs |
| `/advisor requires interactive mode` | Running under `pi --print …` or RPC | Run Pi interactively |

## Related

- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) —
  the umbrella package; its `code-review` skill calls `advisor()` when this
  package is installed.

## License

MIT — see [LICENSE](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-advisor/LICENSE).
