# agent-compact

English · [简体中文](README.zh-CN.md)

Context compression for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): lets the **agent autonomously call** `context_compact` to compress a span of the conversation it chooses — the finished, no-longer-needed middle — and replace it with a checkpoint the agent writes itself.

## Why

Compaction is normally a full-context sweep: the official engine only ever compresses from the start of the conversation, so the opening's task plan and direction are **partially lost along with the compressed information**. `context_compact` compresses **only the span the agent selects** — a finished step, a debugged log exchange, an off-track discussion — while the important opening and the recent context stay intact. Span compaction keeps **information loss from compaction as small as possible** — like human memory, the middle is not compressed indiscriminately: what can be summarized is consolidated into a checkpoint, and important details stay word-for-word — the agent decides what is truly dead, and only that gets condensed.

Typical moments to use it:

- a task step is done — compress it, keep the remaining steps and the active instruction live;
- a bug hunt or a wrong research direction is over — compress that exchange into a short "what went wrong / root cause / fix" note;
- the opening requirements are stale — compress the start and restate the current intent.

## What it does

- The agent picks the span via `startAnchor` / `endAnchor` (unique-prefix matching, CJK punctuation-width tolerant) and passes a **required** `summary` — the Markdown checkpoint it wrote itself.
- The raw span is archived to the spill store first (`~/.dsh/spill/session-<hash>/<hex>-<seq>.txt`, sequential naming, restart-safe); the path is echoed in the shadow message so the model can read the raw text back.
- The host engine runs the stock transaction — boundary validation, tool-pair balance, surface replacement — with **no separate LLM summarizer request**.

The tool call itself happens inside the agent's normal turn and is billed like any other turn; what is avoided is only the *extra* summarizer request the official engine would make for the same span.

## Install

```sh
# from a published registry package
dsh plugin --profile web add @mimichunterz/agent-compact

# or from a local checkout
dsh plugin --profile web add ./agent-compact
```

`dsh plugin` forwards to pnpm in the profile directory and appends the bundle to `dsh.profile.bundles` (see the official [publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)). **Restart the profile** — every session then sees the `context_compact` tool.

The bundle's own `cordis.patch.yml` pins the spill archive root to `~/.dsh/spill` (deployments can override it again through the profile's `cordis.patch.yml`).

## Uninstall

```sh
dsh plugin --profile web remove @mimichunterz/agent-compact
```

`dsh plugin remove` forwards to `pnpm remove` in the profile directory: it uninstalls the package and reconciles the bundle out of `dsh.profile.bundles`. **Restart the profile** — every session then stops seeing the `context_compact` tool. The same package name works whether you installed from the registry or from a local checkout.

If the plugin was additionally mounted through a row in the profile's `cordis.patch.yml` (dev mode), remove that row too, otherwise the patch re-mounts it on the next boot.

## Configuration

| field | default | meaning |
|---|---|---|
| `autoArchive` | `true` | `context_compact` saves the full raw span to a spill artifact before replacing it |
| `volumeNudgeTokens` | `50000` | Every time accumulated surface growth (heuristic token count) since the last compaction crosses another multiple of this amount, remind the model to consider `context_compact`. `0` disables the nudge. |

Pass through the inserted row in the profile's `cordis.patch.yml` or a bundle patch.

## How it works

- **Agent-written checkpoint**: `summary` is mandatory, so the tool path always uses the checkpoint the agent wrote. `patchEngine()` (see `src/optimizer.ts`) wraps the engine's `summarize()`: when an `_externalSummary` is present (one-shot, keyed per session id), it returns that text directly; only when none is present does it forward to the stock implementation — a branch that serves the automatic compaction path and keeps official behavior intact.
- **System-prompt guidance**: the bundle registers a global prompt section (`tool:context_compact`, order 118) that tells the agent to use `context_compact` proactively — compress finished steps at topic boundaries instead of waiting for automatic full-context compaction.
- **Proactive volume nudge**: a `systemPrompt.context()` injection (`agent-compact:volume-nudge`, order 50) reminds the model once each time the session's surface has grown by another `volumeNudgeTokens` (default `50000`) multiple since the last compaction. It measures occupancy via `contextPressure.projectedTokens` (falling back to `tokenMeter.measure().surfaceTokens`); the growth baseline resets on every `compaction/summary`; `0` disables it. As a tail `systemPrompt.context()`, unchanged text is a no-op (KV-cache friendly) and it is independent of the auto-compactor's pressure threshold.
- **Anchor matching** (`src/normalize.ts`): `normText` collapses whitespace and maps CJK full-width punctuation to half-width (，→, etc.), applied to both anchors and node text. Matching keeps **unique-prefix** semantics: zero hits → "not found" with closest-node hints; more than one hit → "AMBIGUOUS".
- **Restart-safe sequential archives**: the next number is derived by scanning the session's spill directory (`max+1`) — gap-free; the backend's random hex prefix makes filename collisions impossible.
- **Paired cleanup**: the tool-call message (carrying the full `summary` argument) and its tool/result are each replaced by one tiny shadow message, so the checkpoint text never appears twice on the surface (skipped when the message holds more than one tool call).

## Shared trunk (fork extension)

This fork adds one rule set for sessions that were **forked** — teammates or subagents created with `fork`, which start with a verbatim copy of their parent's history. That inherited history is the *trunk*. A prefix-caching inference engine (llama.cpp prompt cache, Strata conversation checkpoints, provider prompt caching) reads the trunk once for all forks, but only while it stays byte-identical in every one of them. Upstream agent-compact lets every fork compact the trunk on its own, so each fork writes a different checkpoint and the shared prefix is lost.

- **Lock.** In a forked session, a default-scope `context_compact` span may not start inside the trunk (the inherited nodes, plus any checkpoint that replaced inherited nodes). The error names the first message the session owns.
- **One canonical trunk block.** `context_compact({ scope: "trunk" })` compacts exactly the trunk — from the first non-system node through the last inherited node — without anchors and without an agent-written summary.
- **Content-addressed checkpoint.** The trunk's identity is a SHA-256 over the inherited events (`lib/trunk.js`, `trunkKey`). The first fork that compacts a trunk generates the checkpoint with the stock summarizer, which sees only the system prompt and the trunk, so the text is task-neutral. Every other fork with the same key — and the parent, see below — gets the exact same text blocks back. Concurrent requests share one generation; a failed generation is not remembered. Entries persist under `sharedStoreDir` (`$DSH_HOME/storages/agent-compact/trunk/<key>.json`).
- **Automatic compaction is guarded.** The engine's `compactRegion()` is wrapped: an automatic (pressure or overflow) range that reaches into the trunk first becomes the shared trunk compaction; once the trunk is compacted, later ranges are clamped to start after the shared checkpoint. If neither is possible, the requested range runs unchanged, because a session that cannot shrink must still recover. `trunkGuard: false` turns the guard off.
- **Parents stay aligned.** Fork points are recorded per parent (`storages/agent-compact/forks/<parent>.json`, read from the children's session headers). A parent with known forks protects the most recent fork point the same way, so when the Team Lead compacts its old history it lands the same trunk checkpoint as its teammates.

Not covered: the manual `/compact` command keeps the stock behaviour, and forks taken at different points of the parent's history have different trunks, so they share a checkpoint only with forks taken at the same point.

Measured limits outside this plugin (DSH 0.2.0-rc.2): a fork inherits only the parent's *completed* turns, so a compaction the parent ran in its still-open turn is not part of the trunk. And the parent's own system prompt can differ from its forks' (a Team Lead's prompt carries the Agent Teams section that subagent forks do not get), so a parent and its forks may not share a prefix at all; siblings always do, and that is what this extension guarantees.

| field | default | meaning |
|---|---|---|
| `sharedStoreDir` | `''` (bundle patch: `$DSH_HOME/storages/agent-compact`) | memo and fork registry directory; empty keeps both in memory only |
| `trunkGuard` | `true` | guard the automatic compaction path as described above |

This fork also declares no `@deepseek-ai/*` runtime package except `schemastery` as a dependency (they resolve from the DSH installation), drops the `prepare` build script so a packed tarball installs without a build, and moves the persistent spill root to `$DSH_HOME/storages/spill`.

## Compatibility

- Built and verified against DeepSeek Harness `0.2.0-rc.2` (`@deepseek-ai/dsh-compaction-basic@0.2.0-rc.2`, cordis `4.0.4`, schemastery `3.18.4`).
- 0.2 migration notes: `MessageSourceMap` dropped the shared `plugin` kind, so shadow messages now declare the plugin-owned `agent-compact` source; `SurfaceOp` replace uses `startSeq`/`endSeq` (was `start`/`end`); strict `TypertCodec` takes `create()` instead of a prebuilt `schema`; `JsonValue` moved from `dsh-tools`/`dsh-session` to `@deepseek-ai/dsh-util-values`; `dsh.client.inject` lists Client **packages** (it previously held service names).
- Only **one compaction per session at a time** (the engine transaction is serialized); anchors re-resolve on every call, so later compactions never go stale after earlier checkpoints replaced old nodes.
- With a local spill backend the root is fixed; other backends degrade gracefully (no `root` field → in-memory counter), and compaction itself is unaffected.

## License

MIT. The patch derives from `@deepseek-ai/dsh-compaction-basic` and related DeepSeek Harness packages (MIT, Copyright DeepSeek) — see [`LICENSE`](LICENSE).
