# rolling-compaction

English · [简体中文](README.zh-CN.md)

> **`@tmielsch/rolling-compaction`** is the `tmielsch` fork of
> [agent-compact](https://github.com/MimicHunterZ/dsh-agent-compact) (MIT). It
> adds the extensions described below — shared trunk, recall, anchors as the
> model saw them, reasoning hygiene, conservative expert checkpoints — and is
> installed from its own release tarball; see [Install](#install).
>
> The package name is deliberately not `agent-compact`: it can be installed next
> to the upstream package without the two colliding under one name, and the name
> says what the fork adds — compaction that **rolls forward**. Each checkpoint
> only ever replaces a finished span, keeps its original for recall, and in a
> forked session every sibling reuses the *same* checkpoint text, so a
> prefix-caching inference engine keeps reading one shared prefix instead of
> re-reading a different one per agent.
>
> Inside the plugin, the stable identifiers stay as they are: the shadow-message
> source kind `agent-compact`, the trunk key version `agent-compact/shared-trunk/v1`
> and the store path `$DSH_HOME/storages/agent-compact`. Renaming them would
> invalidate already-written checkpoints and fork registries, so only the
> *package* name changed.

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

This fork is installed from its own release tarball — one line, no registry
account, no checkout:

```sh
dsh plugin --profile web add https://github.com/tmielsch/dsh-agent-compact/releases/download/v0.2.1-trunk.12/tmielsch-rolling-compaction-0.2.1-trunk.12.tgz
```

Replace the version in both places with the one you want
([all releases](https://github.com/tmielsch/dsh-agent-compact/releases)); the
lockfile then pins that exact tarball's checksum, so an update is the same line
with the new version.

Requirements: DeepSeek Harness `0.2.0-rc.2` or a compatible build. The package
declares the harness packages it plugs into as **peer** dependencies and
installs none of them itself — they resolve from the DSH installation. That
matters: a second copy of `@deepseek-ai/*` inside the profile makes every tool
call die with `Cannot read properties of undefined (reading 'prepare')`. Only
`zod` comes along as a real dependency. If your pnpm reports missing peers, do
**not** answer that with `pnpm add @deepseek-ai/...`; add
`peerDependencyRules.ignoreMissing: ['@deepseek-ai/*']` to the profile's
`pnpm-workspace.yaml` instead (the same rule the maintainer's other machines
use).

```sh
# from a published registry package (upstream's own name)
dsh plugin --profile web add @tmielsch/rolling-compaction

# or from a local checkout
dsh plugin --profile web add ./agent-compact
```

`dsh plugin` forwards to pnpm in the profile directory and appends the bundle to `dsh.profile.bundles` (see the official [publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)). **Restart the profile** — every session then sees the `context_compact` tool.

The bundle's own `cordis.patch.yml` pins the spill archive root to `~/.dsh/spill` (deployments can override it again through the profile's `cordis.patch.yml`). The shared-trunk memo and the archives of recalled spans land under `$DSH_HOME/storages/` (`agent-compact/`, `spill/`).

## Uninstall

```sh
dsh plugin --profile web remove @tmielsch/rolling-compaction
```

`dsh plugin remove` forwards to `pnpm remove` in the profile directory: it uninstalls the package and reconciles the bundle out of `dsh.profile.bundles`. **Restart the profile** — every session then stops seeing the `context_compact` tool. The same package name works whether you installed from the registry or from a local checkout.

If the plugin was additionally mounted through a row in the profile's `cordis.patch.yml` (dev mode), remove that row too, otherwise the patch re-mounts it on the next boot.

## Configuration

| field | default | meaning |
|---|---|---|
| `autoArchive` | `true` | `context_compact` saves the full raw span to a spill artifact before replacing it |
| `keepFailedSummary` | `true` | A failed compaction keeps the checkpoint text the model wrote: the retry may omit `summary` and reuse it unchanged (kept in memory for the running process; after a restart the text is still word-for-word in the previous message and is copied from there) |
| `volumeNudgeTokens` | `50000` | Every time accumulated surface growth (heuristic token count) since the last compaction crosses another multiple of this amount, remind the model to consider `context_compact`. `0` disables the nudge. |

Pass through the inserted row in the profile's `cordis.patch.yml` or a bundle patch.

## How it works

- **Agent-written checkpoint**: `summary` is required for a fresh compaction (and for a retry that rewrites the text), so the tool path always uses the checkpoint the agent wrote. `patchEngine()` (see `src/optimizer.ts`) wraps the engine's `summarize()`: when an `_externalSummary` is present (one-shot, keyed per session id), it returns that text directly; only when none is present does it forward to the stock implementation — a branch that serves the automatic compaction path and keeps official behavior intact.
- **System-prompt guidance**: the bundle registers a global prompt section (`tool:context_compact`, order 118) that tells the agent to use `context_compact` proactively — compress finished steps at topic boundaries instead of waiting for automatic full-context compaction.
- **Proactive volume nudge**: a `systemPrompt.context()` injection (`agent-compact:volume-nudge`, order 50) reminds the model once each time the session's surface has grown by another `volumeNudgeTokens` (default `50000`) multiple since the last compaction. It measures occupancy via `contextPressure.projectedTokens` (falling back to `tokenMeter.measure().surfaceTokens`); the growth baseline resets on every `compaction/summary`; `0` disables it. As a tail `systemPrompt.context()`, unchanged text is a no-op (KV-cache friendly) and it is independent of the auto-compactor's pressure threshold.
- **Anchor matching** (`src/normalize.ts`): `normText` collapses whitespace and maps CJK full-width punctuation to half-width (，→, etc.), applied to both anchors and node text. Matching keeps **unique-prefix** semantics: zero hits → "not found" with closest-node hints; more than one hit → "AMBIGUOUS".
- **Restart-safe sequential archives**: the next number is derived by scanning the session's spill directory (`max+1`) — gap-free; the backend's random hex prefix makes filename collisions impossible.
- **Paired cleanup**: the tool-call message (carrying the full `summary` argument) and its tool/result are each replaced by one tiny shadow message, so the checkpoint text never appears twice on the surface (skipped when the message holds more than one tool call).
- **A failed compaction keeps its text** (`src/summary-stash.ts`): when the engine rejects a span (open step, unstable surface, summary not smaller, transient error), the checkpoint text the model already wrote is no longer thrown away. The retry calls `context_compact` with the same anchors and **without** `summary`, and the kept text is used unchanged — a retry costs the tool call again, not a second writing of the checkpoint (two minutes of model time, reported 2026-10-20). A text survives a failed anchor resolution (AMBIGUOUS / not found) too, so nothing is ever rewritten from memory. A kept entry matches the retry by its resolved range (same compaction retried), its `endAnchor` (surface moved), or — for attempts that never resolved anything — a lengthened `endAnchor` (the "AMBIGUOUS" fix). Passing `summary` on a retry means "write this instead"; a successful compaction clears the session's kept texts; `keepFailedSummary: false` turns the whole feature off.

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

## Recall (fork extension)

A checkpoint is lossy by design. This fork keeps the original behind every checkpoint and lets the agent read it back on demand, without undoing the compaction:

- **Every checkpoint references its original.** The checkpoint text ends with `[Full original of this checkpoint: context_recall archive="<id>"]`. Span compactions (the tool's default scope and the engine's automatic compactions) keep their raw span in the session's spill directory (`session-<hash>/<name>`). The shared trunk keeps its raw trunk once, content-addressed next to the memo (`trunk:<key>` → `storages/agent-compact/trunk/<key>.raw.txt`); the reference is part of the memo text, so every sibling still lands the same bytes. A trunk checkpoint written before this version has no reference.
- **`context_recall`** reads an archive back: page by page (`offset`, `maxChars`, default 20,000 characters), or only the messages that contain every word of `query`. Offsets count from 0. A message too long for the room left is cut; with a `query` the excerpt is taken around the first match, and a later match still gets an excerpt while at least 600 characters are free. Without `archive` it lists the archives the conversation's checkpoints reference. The result is an ordinary tool result at the end of the conversation, so nothing before it changes and a prefix-caching engine keeps its cache. Putting the original back in place of the checkpoint would refill the context and make the engine read the whole conversation again; recall does neither.
- Archiving never blocks a compaction: when the raw span cannot be kept, the checkpoint simply carries no reference. `autoArchive: false` turns archiving and references off.

## Anchors as the model saw them (fork extension)

The model quotes anchors from its own view of the transcript, which is not the plain node text: an attached image reaches it as a handle line (`Image "grafik.png" (sha256:…); request preview …`), a team message starts with a header line before the body, and tool calls are remembered by their marker or by an argument. Anchors are therefore matched in tiers, and the first tier with hits wins:

1. the previous rule: the opening of the message's plain text (an anchor that resolved before still resolves to the same message and never becomes ambiguous);
2. the model's view of the opening: attachment handle lines (the id may be shortened to its first characters), tool-call markers in any case, the opening of a tool call's string argument, a tool-call marker whose tool name is shortened to one `__`-separated segment;
3. the opening of a later block of the message (the body after a team-message header, a tool call after a text block);
4. tiers 1–3 ignoring whitespace (JSON spacing of quoted tool calls).

Only when no message matches is the opening of a tool result accepted; the span edge then snaps to the call that produced it. Calls and results of `context_compact` and `context_recall` never match, because they echo anchors. A match must still be unique. Hints in the error messages show the model's view too, including each attachment's id, and the shared-prefix elision of ambiguous candidates stops at a word boundary, so a quoted preview is itself an anchor that resolves. Replayed against a real session's seven failed calls, four resolve now and three report AMBIGUOUS with previews that tell the candidates apart; an anchor quoting text the model never wrote as a message is still not found.

When nothing is found, the error now says why it may be unfindable and shows what to quote instead: text that stood only in the model's own reasoning is not on the surface and can never be an anchor, the "closest nodes" list skips the harness's own notices (runtime-context snapshots, compaction reminders, checkpoints), and a *last messages on the surface* list gives the tail with copyable openings. Before, a model that had quoted its own reasoning got three unrelated system notices back and retried the same anchor — which is what a real session did seven times in a row.

A third trap sat in the same place, and it cost two sessions their log. Without a `startAnchor` the span began at surface position 0 — which holds the system prompt. The harness protects that node: a replacement covering it is rejected with *node 0 holds the system prompt*, and the rejection arrives only after `compaction/start` and `compaction/summary` are already written. The summary row then describes a replacement that never happened, and the session can no longer be read back. The head is now never part of a span: without a `startAnchor` the span begins after it, exactly as the stock engine's `selectCompactableRange` does (`firstIdx = systemHead(...) === undefined ? 0 : 1`). An explicit anchor cannot land there either, because system nodes are not anchor targets. `~/.dsh/tools/compact-repair.py` scans a whole `DSH_HOME` for summary rows that start on the head — verified against the real damaged file (flagged) and its repaired copy (clean).

A second regression came from the fix above it. Matching a `[tool-call Name] …` anchor compared the tool name alone, so `[tool-call Bash] {"command":"cd …"}` matched all 654 Bash calls in one real session and was rejected as ambiguous. The name now only counts together with the argument text the anchor also quotes; a marker without an argument matches nothing, because the exact-marker rule has already had its chance by then.

A namespaced tool call had one more trap. The hints print the call as `[tool-call mcp__houdini__execute_python] …`, and the model, quoting that same call back, wrote `[tool-call execute_python]` — the namespace was gone. One real session therefore reported *not found* for an anchor that named a call present on the surface twice over. A leading `[tool-call …]` marker is now compared against the whole tool name and against each `__`-separated segment, so the shortened form resolves to the same call. Two calls that differ only in namespace still report AMBIGUOUS instead of silently picking one. Replayed against the real session that hit this, the anchor now resolves to the same span the model intended (seq 82…260).

## Anchor markers (fork extension)

The measured main failure of compaction was never the engine — it was the anchor. 60 of 73 failed calls in 102 sessions were anchor errors, almost all AMBIGUOUS: `[tool-call Bash] {"command":"cd …"}` matched all 654 Bash calls of one real session, and three messages beginning "Ok" are three matches.

The volume nudge therefore lists the most recent anchorable messages with a **fixed marker id**, the SHA-256 checksum of the node's seq:

```
[a7730ed] lead: Neue Scheibe R1, diesmal mit dem Randkorrektur-Weg
[ab12f04] Ok, ich habe die Laibungen an W29 nachgerechnet und der Befund
```

An anchor that opens with such a marker resolves **by the marker alone**, before any text reading: exactly one node, never ambiguous, never not found. Whatever text follows the marker in the anchor is accepted as a comment and not matched (a model may add a paraphrase). A marker that names no current node — the span it named may be compacted away — falls through to the text readings, so quoting a stale marker plus the right opening still resolves. A marker cannot be guessed: the checksum of a seq that does not exist names nothing, so a hallucinated marker is a not-found, not a wrong node.

The ids are six hex characters (16 M values). Within any 64-seq window — eight times the nudge's listing window — no two ids collide (birthday bound ≈ 0.01 %), and a collision between distant seqs is harmless: only a node actually on the surface can be hit, and the nudge lists only the last few messages.

## Reasoning stays out (fork extension)

Every checkpoint and every archive this plugin writes leaves the model's reasoning trace out. Two reasons: a reasoning trace is useless on re-entry — it explains how someone arrived at a thought, not what was decided — and it is the text class Anthropic's request filter reacts to. On 2026-10-09 two long sessions on `claude-opus-5-5` were answered with

```
This request was blocked as it seems to violate Anthropic's Terms of Service
restrictions on reverse engineering or duplicating model outputs.
```

after a compaction failure loop, and the sessions had to switch provider to continue. DSH sends the reasoning of earlier assistant messages along on every request (`dsh-llm-pi-ai`, `replayedAssistant` with signatures and `foreignAssistant` without), so a long agentic session accumulates a large corpus of verbatim model reasoning. Archives are exactly such a corpus; they now hold the visible text, the tool calls with their arguments, and image markers, but not the reasoning. Older archives written before this version still contain it — read them back sparingly, or let them age out.

This fork declares **no `@deepseek-ai/*` package as a runtime dependency**: they are peer dependencies and resolve from the DSH installation, so installing this plugin never plants a second copy of the harness in a profile. `zod` is the only real dependency. It also drops the `prepare` build script (a packed tarball installs without a build) and moves the persistent spill root to `$DSH_HOME/storages/spill`.

## Compatibility

- Built and verified against DeepSeek Harness `0.2.0-rc.2` (`@deepseek-ai/dsh-compaction-basic@0.2.0-rc.2`, cordis `4.0.4`, schemastery `3.18.4`). Verified by a clean-room install into an empty `DSH_HOME`: the profile then contains only `@tmielsch/rolling-compaction` and `zod`, `dsh --profile web --dump-config` mounts the bundle, and `dsh web` boots (HTTP 401 on the port, no startup diagnostics).
- 0.2 migration notes: `MessageSourceMap` dropped the shared `plugin` kind, so shadow messages now declare the plugin-owned `agent-compact` source; `SurfaceOp` replace uses `startSeq`/`endSeq` (was `start`/`end`); strict `TypertCodec` takes `create()` instead of a prebuilt `schema`; `JsonValue` moved from `dsh-tools`/`dsh-session` to `@deepseek-ai/dsh-util-values`; `dsh.client.inject` lists Client **packages** (it previously held service names).
- Only **one compaction per session at a time** (the engine transaction is serialized); anchors re-resolve on every call, so later compactions never go stale after earlier checkpoints replaced old nodes.
- With a local spill backend the root is fixed; other backends degrade gracefully (no `root` field → in-memory counter), and compaction itself is unaffected.

## License

MIT. The patch derives from `@deepseek-ai/dsh-compaction-basic` and related DeepSeek Harness packages (MIT, Copyright DeepSeek) — see [`LICENSE`](LICENSE).
