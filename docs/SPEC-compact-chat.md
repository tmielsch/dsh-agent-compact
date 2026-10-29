# SPEC: Compact Chat (rolling-compaction)

Status: DRAFT 1, 2026-10-29. Not approved. Nothing is built yet.
Branch: `feature/compact-chat` (worktree `.worktrees/compact-chat`), based on `main` 9e04c18 (trunk.15).
Owner of decisions: Tilman. Every change of this spec is dated and uses his words where possible.

Rule of this document: UI labels, identifiers and plugin text are **English**. Tilman, 2026-10-29: "bitte alle Begriffe immer in Englisch machen. Das macht dir ja nicht nur für mich die Plugins." The plugin is public, so the English rule is for the code and the UI; this prose is German so Tilman can read it.

## 1. What Tilman wants (his words)

- 2026-10-29: "Ich will halt wirklich den Chat haben mit denselben Funktionalitäten, ne, dass ich da auch ganz normal chatten kann. Nur dass ich Checkpoints ein- und ausklappen kann. Interaktiv. Und sagen kann, klapp sie alle aus oder klapp sie alle ein."
- 2026-10-29: "Sowohl kompaktete als auch nicht kompaktete [Version]: ich habe quasi einen Abschnitt, ich kann den aufklappen, dann wird die Originalversion gerendert. Wenn ich ihn zuklappe, kriege ich die compactete Version, so dass ich selber auch lesen kann, was das Modell wirklich im Cache hat. Das wäre der absolute Traum."
- 2026-10-29: Color coding in the Strata sidebar: "ob irgendwas eingeklappt ist oder nicht, ist dann halt eine andere Farbe. Dass man sieht, was kompakte Schichten sind und was nicht."
- 2026-10-29: Either rebuild the existing tab, or a fourth tab that is a clone of the Chat, "dass wir den originalen Chat nicht anfassen müssen. Either way."
- 2026-10-29: The existing tab with the Chinese label is "eher technische Analyse von Model-Outputs als Chat", looks like Trajectory. The label must be translated; Tilman has never used it and does not know its purpose.

## 2. Measured facts this spec stands on (2026-10-29)

1. A `context_compact` call writes three events to the session log: `compaction/start`, `compaction/summary`, `compaction/end`. The `compaction/summary` event carries `compactionId`, `shadowedRange {start,end}` and `shadowedSeqs[]` (the exact event seqs that were replaced), plus `shadowedTokenCount`. Example: first compaction of session 4ddfac88: range 58..292, 43 seqs, 16531 tokens.
2. The checkpoint itself is a `user/message` with `source {kind: "compact-checkpoint", compactionId}` and `surfaceOp {op: "replace", startSeq, endSeq}`. Its `sourceEventSeqs` lists the replaced events too.
3. DSH Chat already has a node kind `compaction` for such checkpoints (`COMPACT_KIND = "compact-checkpoint"`, `CompactionNodeView`, `CompactionItem`). The row is collapsed by default, shows "Compacted N history items (~T tokens)" and expands to the checkpoint text. MEASURED in Tilman's browser (2026-10-29 ~18:40): exactly ONE such row is in the DOM, for the third compaction (`620d69d0`, text "Compacted 22 history items (~10897 tokens)", key `10:compaction620d69d0-...`, `hidden="until-found"`). The numbers equal the log (22 seqs, 10897 tokens). The first two compactions (`153ce2d8` with 43 items, `07aa6435` with 38 items) have NO row in the DOM, although all three are structurally identical in the log (summary event, checkpoint user/message with `surfaceOp replace`, same `source.kind`). Their two `context_compact` tool-call rows ARE in the DOM. Cause unknown (see Q5).
4. The Chat view is registered as target `"chat"` (`chatViewDefinition`, `ctx.uiConversation.views.register`) and as slot `conversation.view` with `id: "chat"`, `order: 0`. The registry refuses a second registration of the same target name. The package `@deepseek-ai/dsh-client-ui-chat/client` exports only `EMPTY_CHAT_SNAPSHOT`, `apply`, `inject`, `isRunningTool`, `isSettledTool`; the snapshot builder class (`ChatSnapshotBuilder`) is NOT exported.
5. The composer (input field) belongs to the whole conversation window (slot `conversation.input.dock`), not to a tab. A new tab therefore keeps the input field. (Not yet verified in the running UI.)
6. The existing tab is registered by this plugin: `scripts/build-client.mjs` line 135, `label: () => "上下文"`, `id: "ctx-surface"`, `order: 20`. It reads the model's real messages through the remote `ctxSurface.read`.
7. The Strata sidebar plugin (`dsh-strata`) paints bands from DOM rows carrying `data-chat-flow-kind`. Do not confuse it with the Strata inference engine on the PC. A second session is working in parallel (its notes: `/Users/tmielsch/layer-cake-design.md`). Tilman does not remember what exactly that session did, and I have not verified its claims; I only know from git that it merged `trunk.15` into `main` of this repo (commit 9e04c18). It may release more versions and change `src/index.ts` and `src/boundary.ts`. Its work is not part of this spec.

## 3. Requirements

R1. A tab named **"Compact Chat"** shows the normal chat (same message rendering as the Chat tab) and the normal input field, so Tilman can chat from it.
R2. Every compaction shows as one block at the place where the replaced span was. Collapsed: the checkpoint text (what the model really has in its context). Expanded: the original messages of the replaced span, rendered like in the Chat tab.
R3. Buttons **"Expand all"** and **"Collapse all"** for all compaction blocks of the session. Each block also toggles individually.
R4. The mapping from checkpoint to original is exact: it comes from `shadowedSeqs` / `surfaceOp`, never from guessing by text.
R5. Strata shows compacted spans in a different color than normal bands, and expanded ones distinguishable from collapsed ones.
R6. The existing tab with the Chinese label gets an English label. Proposed: **"Model Context"**. Behavior of that tab does not change.
R7. The original Chat tab and all other plugins stay untouched. No DSH core file is edited.
R8. Existing work is reused: DSH's own message renderers and the existing `ctxSurface` service. Nothing that exists is re-implemented without Tilman's yes (AGENTS.md: forbidden to rebuild existing work).

## 4. Open questions (nothing is built until these are answered)

Q1. **Can the DSH Chat renderer be reused in a second tab?** Fact 4 says the builder is not exported and the target name is unique. Candidate routes, all unverified:
   a. Register a new target with its own builder that reuses the same node renderers (slot `conversation.chat.node` is public).
   b. Render in the new tab from the existing `chat` snapshot (`conversation.snapshot...views.get("chat")`) and only wrap/filter it.
   c. Do not make a new tab at all; add the collapse blocks into the existing Chat tab by a thin plugin layer.
   If none works without copying DSH code, I stop and ask Tilman before any re-implementation.
Q1 RESULT (2026-10-29, read from DSH code, nothing run yet):
   - The supported public API does NOT allow a clean second Chat: a child slot (`conversation.chat.node`) can be declared once, the view target name is unique, and `ChatSnapshotBuilder` is not exported.
   - Three routes remain without copying DSH code:
     R-A (supported API, robust): a new Chat node kind `compact-block` registered via `ctx.slots.register({name:'conversation.chat.node', key})` and `ctx.uiConversation.events.register(...)`. It shows the block INSIDE the normal Chat (collapsed: checkpoint; expanded: original). It cannot hide the original rows that the normal Chat shows anyway.
     R-B (new tab reusing the Chat component, internal, fragile): read `slots.entries('conversation.view')`, take the entry with id `chat` (it carries `component`, `inject`, `store`), register a second entry `compact-chat` with the same component. Verified: `boundRenderSlot` only checks `entry.children[key]` of the calling entry and that the entry is still registered, so our own `children` object can name `conversation.chat.node` without declaring it again (it is only referenced). The kit hooks (`useChat`, `useConversation`) can be overridden by our `inject`. To hide the replaced originals we must filter BOTH `useChat(s => s.order)` and `useConversation(s => s.views.grouped('chat').entries)`, because ChatView prefers the grouped entries over `order`. Risks: relies on internal structure of DSH 0.2.0-rc.2; a DSH update can break it. Collapse state lives in our plugin.
     R-C (DOM overlay on the normal Chat): rows have `data-chat-node-key`; hide via DOM. Rejected for now: React owns `hidden`, flickers.
   - Recommendation: build R-B as a probe on the feature branch with R-A as fallback; the probe needs an install and a `dsh web` restart by Tilman before it can be judged.
Q2. How do Chat nodes map to event seqs (is `node.anchorSeq` or the key enough to find the rows inside `shadowedRange`)? To be measured on the live snapshot.
Q3. ANSWERED 2026-10-29: yes, for one of three (fact 3).
Q5. (After a hard reload the DevTools count is still 1, so it is not stale state. Reading DSH code: `compaction` is NOT in `TURN_PROCESS_INDEPENDENT_KINDS`, so a compaction node that sits inside a turn's work window is folded into that turn's "Called tools" disclosure; that is why the one row found has `hidden="until-found"`. This explains why Tilman never saw such a row in the open chat. It does not yet explain why rows 1 and 2 are missing from the DOM altogether.) Why do compactions 1 and 2 (both in turn 7) have no `compaction` row while compaction 3 (turn 13) has? Candidate causes, none verified: (a) the Chat feed in the browser does not contain the older checkpoint events; (b) they were folded away with their turn; (c) a DSH rule that only builds the row for recent checkpoints. A reload of the page and a repeat of the DevTools count shows whether it is a stale-state effect.
Q4. Does the input field stay visible when a different tab is active?

## 5. Delivery

- Work only on `feature/compact-chat`. Merge to `main` with `--no-ff` only after Tilman has seen it working in his browser.
- Collision rule with the other session: before every merge and before choosing a version number, run `git log main` and `git fetch` to see what it has released in the meantime; rebase onto the new `main` first. Compact Chat touches only `src/client/`, `scripts/build-client.mjs` and `docs/`; it does not touch `src/index.ts` or `src/boundary.ts` unless Tilman agrees.
- Release as a new tgz (next free version after whatever `main` has then, currently `0.2.1-trunk.15` is taken), installed by `dsh plugin --profile web add <release URL>`, then `dsh web` restart, as in the existing process.
- Acceptance (each one measured, not claimed): R1 chat from the new tab; R2 expand and collapse one block, text equals the archive/log; R3 both buttons; R4 seq count of an expanded block equals `shadowedSeqs.length` from the log; R5 screenshot with Strata; R6 tab label; R7 `git diff` shows no change outside this plugin.

## 5a. Design consequence (draft)

The Compact Chat does not depend on DSH's own `compaction` rows in the DOM. Per compaction it needs exactly: `compactionId`, the checkpoint text, the replaced seqs (`shadowedSeqs`) and the position. All of that is in the session log and is already reachable on the server side through `sessionQuery` (the same route `ctxSurface.read` uses). A small new remote method returns these records; the browser tab renders from them. DSH's `CompactionItem` stays the visual model (collapsed line "Compacted N items (~T tokens)", expands to the checkpoint text).

## 6. Change log

- 2026-10-29 Draft 1 written from Tilman's messages of the day. Awaiting his review.
