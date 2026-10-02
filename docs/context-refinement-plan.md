# Advisor payload refinement — design plan

Status: **implemented**. Measured outcome below.

## Measured outcome

Re-measured with the finished code against a 242-message session
(816,837 characters of resolved branch):

| | chars | ~tokens | share |
| --- | --- | --- | --- |
| Today's payload — premium model reads the whole branch, pretty-printed | 816,837 | ~215k | 100% |
| Compressor input — cheap model reads the whole branch, compact | 792,347 | ~208.5k | 97% |
| **Reviewer payload — premium model, typical digest** | **38,407** | **~10.1k** | **4.7%** |
| Reviewer payload with compression failed (floor only) | 30,436 | ~8.0k | 3.7% |

**~95% of premium-model input tokens avoided per call**, with the floor alone
holding it to 4.5% even when compression fails. Reviewer breakdown at a typical
digest: question 146 chars, digest 8,047, timeline 24,006 (at its cap), user
requests 528, recent window 4,178, tool inventory 573.

The saving is a property of the *configuration*, not the design: it holds insofar
as the configured compressor is cheaper per input token than the reviewer. The
compressor still reads the full branch on every call (792k chars here), so total
tokens are roughly flat — they are just spent at the cheaper rate. Repeat
consultations still re-run the compressor; caching its digest per session remains
a follow-up, not part of this change.

Two costs this does not remove, deliberately: the compressor input is unbounded,
so on a session long enough to exceed the compressor model's context window the
digest will fail and the call will silently degrade to the floor (visible via
`details.compression`); and compression quality is a single point of failure for
everything older than the recent window, mitigated — not eliminated — by the
always-attached floor.

## Problem

`execute.ts` ships the executor's entire resolved conversation branch to the
advisor on every call, serialized as pretty-printed JSON. The advisor is a
premium model, so this dominates the cost of using it.

Measured by replicating `serializeAdvisorMessages` over a real session (48
messages, 26 tool results):

| segment | chars | ~tokens | share |
| --- | --- | --- | --- |
| toolResult bodies | 86,728 | ~22.8k | **64%** |
| assistant thinking | 23,218 | ~6.1k | 17% |
| assistant toolCall arguments | 13,569 | ~3.6k | 10% |
| assistant text (the plan/answers) | 3,799 | ~1.0k | 3% |
| user text (the actual asks) | 434 | ~114 | 0.3% |
| **total** | **135,291** | **~35.6k** | 100% |

The signal the advisor is asked to reason about — what the user asked and what
the executor claimed — is ~3% of the payload. Token counts are a chars/3.8
estimate; no tokenizer ships in the dependency set.

Two multipliers make this worse than a constant:

1. **Prior advisor guidance is re-sent in full.** Advisor output returns as a
   `toolResult` in the branch, so consult *n* re-sends consults 1..*n*-1.
2. **The tool inventory is re-sent every call**, including full `parameters`
   JSON schemas for every registered tool. Static, and the advisor needs tool
   *names* to know what the executor can do, not their schemas.

Already handled, and deliberately left alone:

- **The executor system prompt is not forwarded.** `convertToLlm` passes
  `role:"system"` through untouched (`content: ""` + `sections`), and
  `serializeAdvisorMessages` copies only `role`/`content` — so ~13k chars of pi
  rules/docs/skills never reach the advisor.
- **Prompt caching is automatic.** pi-ai applies provider-declared
  `cache_control` conventions to the system prompt, last tool definition, and
  last content text block. This reduces *cost*, never raw input tokens, and a
  fresh child session (`persist_session: false`, `inheritContext: false`) means a
  one-off consult pays full price regardless.

## Decided design

No hard token budget. The **primary model states the focal question**, a
**dedicated cheap compressor model** turns the branch into a packet targeted at
that question, and the **expensive advisor sees only the packet plus a
deterministic ground-truth floor**.

```
  executor --question--+
                       +--> compressor model (separately configured, cheaper tier)
  full branch ---------+      reads everything, once
                                  |
                                  v  packet targeted at `question`,
                                     citing message / tool-result IDs
                          advisor model (premium)
```

The compressor model is configured **exactly like the advisor model**: same
picker, persisted in `advisor.json`, resolved from the model registry and
re-applied on `session_start`. It is not a hidden default and not a second-class
config key.

### Payload to the advisor

```
question                        (required tool parameter, verbatim)
+ compressor packet             (question-targeted, cites IDs; sample on failure)
+ deterministic skeleton         (computed independently, ALWAYS attached)
+ all user messages             (verbatim, always)
+ recent window                  (excerpted + omission-labelled, not raw)
```

`question` is required. Ground truth is **additive and non-negotiable**: it is
never a subset of what the executor chose to report, and the skeleton is
computed from the branch itself — so it cannot be shaped by the compressor's
judgement either. This is the safeguard — if a weak executor omits the evidence
of its own mistake, the advisor still sees what was actually asked and what just
happened. The packet and the skeleton are **both** sent: the packet says what
matters, the skeleton proves what happened, and the advisor can check one
against the other.

### Rules

- **Prior advisor guidance collapses to a one-line marker.** The guidance was
  already acted on and is already in the executor's context; re-sending it
  double-charges and is what makes repeat consults expensive.
- **Compact JSON, no pretty-print.** 4.6% of the measured payload was indentation
  and structural whitespace — zero semantic value.
- **Inventory is names + first description line only.** No `parameters` schemas.
- **The recent window is excerpted, not verbatim-whole.** "Last N turns" is not
  automatically cheap: the measured session's largest single tool result was a
  50KB command log, and a handful of such results can dominate a recent window.
  Each message is capped, and every truncation emits an explicit
  `[+N chars omitted]` marker rather than silently shortening. Silent truncation
  reads as "this was the whole result" and would make the advisor reason from a
  false premise.
- **Compressor failure degrades to the skeleton alone**, never to an error and
  never to an empty context. The compression stage is a single point of failure;
  the skeleton is what makes it safe to introduce.
- **The packet must cite IDs.** The compressor is asked to reference message or
  tool-result identifiers so the advisor can tie each claim back to the skeleton
  entry that supports it. Compression is trusted for *selection*, not for
  *verification*.

### Known accepted costs

- The compressor reads the full branch, so **total** tokens stay roughly flat;
  the saving is that the bulk is read by the cheaper model instead of the
  premium one. This is only a saving insofar as the configured compressor is
  actually cheaper per input token than the advisor — a property of the user's
  configuration, not of this design.
- Repeat consults re-run the compressor, so cost still grows with consult count —
  at the compressor's rate. Caching the packet per session is a later
  optimization, not v1.
- Compression quality is a single point of failure for everything older than the
  recent window. The always-attached skeleton is the mitigation, not a guarantee.

## Files

| file | change |
| --- | --- |
| `advisor/params` (in `register.ts`) | `question` required parameter |
| `advisor/select.ts` | new — ground-truth floor: user requests, recent window, skeleton |
| `advisor/payload.ts` | new — assembles the reviewer payload + stats |
| `advisor/compress.ts` | new — digest stage + graceful degradation |
| `advisor/subagent.ts` | `runChildAgent` for both stages; compact serializer |
| `advisor/inventory.ts` | `names` detail level (no parameter schemas) |
| `advisor/messages.ts` | compressor vocabulary, elision markers, both-model strings |
| `advisor/execute.ts` | two-stage orchestration + telemetry |
| `advisor/config.ts`, `state.ts`, `restore.ts`, `command.ts` | `compressorModelKey` / `compressorEffort` with full advisor parity |
| `prompts/compressor-system.txt` | new |
| `agents/rpiv-compressor.md` | new — symlinked into `~/.pi/agent/agents/` |
| `test/` | selection, payload, refusal, pipeline, and stub/resolver harness |
| `docs/tool-reference.md`, `docs/configuration.md`, `README.md` | contract updates |

## Verification

- `npm test` — 31 tests over the selection floor, payload assembly, refusal
  paths, the RPC runner, config round-trip, and restore. `test/register-resolve-ts.mjs`
  supplies the `.js`→`.ts` resolver and a `@juicesharp/rpiv-config` stub so the
  rewritten `command.ts` / `restore.ts` / `config.ts` are loadable outside Pi;
  because `/advisor` is the only way to unblock `advisor()`, a load error there
  would leave the tool unusable.
- **Both calls are measured, not assumed.** Per-call `branchChars`, `payloadChars`,
  `payloadStats`, `usage`, and `compressorUsage` are reported in the tool result
  details, and the completed guidance carries a one-line breakdown.
- The "off costs nothing" invariant survives: with no advisor model configured,
  none of the new prompt text enters the system prompt.

## Review findings incorporated

From an advisor design review of the first draft of this plan:

1. The first draft replaced the skeleton with the packet on success, dropping the
   independent ground truth. **Now both are always sent.**
2. Defaulting compression to the executor's own model is defensible for
   *selection* but not for *verification* — the advisor must be able to check the
   compressor's claims against attached evidence. Addressed by (1) plus the
   ID-citation requirement.
3. "Last N turns verbatim" can contain enormous tool results; do not assume that
   window is cheap. Addressed by the excerpt-and-label rule.
4. Measure both calls before promising a cost reduction. Addressed in
   Verification.
