import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveBoundaries,
  snapStartBalanced,
  snapEndBalanced,
  soleToolCall,
  spanText,
  tailCutPrice,
  cutPriceTokens,
  nodeTokenEstimate,
  ZEICHEN_PRO_TOKEN,
} from '../lib/boundary.js'
import { markerTag } from '../lib/anchor.js'

// ---- 合成 surface 节点：形状对齐真实 session surface 事件（见 src/boundary.ts
// 依赖的 nodeContent/blockText 契约），不需要真的会话/服务即可单测。 ----

function userNode(seq, text, source) {
  // user/message 事件的 content 直接挂在 data 顶层（对齐 dsh-llm 的
  // createUserMessage 返回形状），不像 assistant/message、tool/result 那样
  // 嵌一层 `.message`——nodeContent() 按事件类型分两条路径读取，这里必须对齐。
  return {
    seq,
    type: 'user/message',
    data: { content: [{ type: 'text', text }], ...(source ? { source: { kind: source } } : {}) },
  }
}

function assistantTextNode(seq, text) {
  return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

function assistantToolCallNode(seq, callId, name, args) {
  return {
    seq,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call', id: callId, name, arguments: args }] } },
  }
}

function assistantMultiToolCallNode(seq, ids) {
  return {
    seq,
    type: 'assistant/message',
    data: { message: { content: ids.map((id) => ({ type: 'tool-call', id, name: 'x', arguments: '{}' })) } },
  }
}

function toolResultNode(seq, text, isError, callId) {
  return {
    seq,
    type: 'tool/result',
    data: { message: { ...(callId ? { toolCallId: callId } : {}), content: [{ type: 'tool-result', isError: !!isError, content: [{ type: 'text', text }] }] } },
  }
}

test('resolveBoundaries: resolves start/end anchors to the matching node seqs', () => {
  const nodes = [
    userNode(1, 'do step one please'),
    assistantTextNode(2, 'working on step one now'),
    userNode(3, 'now do step two'),
    assistantTextNode(4, 'working on step two now'),
  ]
  const b = resolveBoundaries(nodes, { startAnchor: 'do step one', endAnchor: 'working on step one' })
  assert.equal(b.startSeq, 1)
  assert.equal(b.endSeq, 2)
  assert.equal(b.method, 'start=anchor + end=anchor')
})

test('resolveBoundaries: omitted startAnchor defaults to the first node', () => {
  const nodes = [userNode(1, 'hello there'), assistantTextNode(2, 'hi back')]
  const b = resolveBoundaries(nodes, { endAnchor: 'hi back' })
  assert.equal(b.startSeq, 1)
  assert.equal(b.endSeq, 2)
  assert.match(b.method, /start=first/)
})

test('resolveBoundaries: omitted endAnchor defaults to the LAST node (Layer-Cake cut)', () => {
  const nodes = [userNode(1, 'hello'), assistantTextNode(2, 'hi back'), userNode(3, 'next task')]
  const b = resolveBoundaries(nodes, { startAnchor: 'hello' })
  assert.equal(b.startSeq, 1)
  assert.equal(b.endSeq, 3)
  assert.equal(b.method, 'start=anchor + end=last-node')
})

test('resolveBoundaries: both anchors omitted spans the whole exchange after the system head', () => {
  const nodes = [systemNode(0, 'system prompt'), userNode(1, 'hello'), assistantTextNode(2, 'hi back')]
  const b = resolveBoundaries(nodes, {})
  assert.equal(b.startSeq, 1)
  assert.equal(b.endSeq, 2)
  assert.match(b.method, /start=after-system/)
  assert.match(b.method, /end=last-node/)
})

test('resolveBoundaries: ambiguous anchor lists every matching hit', () => {
  const nodes = [userNode(1, 'do the thing'), userNode(2, 'do the thing again')]
  assert.throws(() => resolveBoundaries(nodes, { endAnchor: 'do the thing' }), /AMBIGUOUS: 2 nodes/)
})

test('resolveBoundaries: unmatched anchor reports the closest nodes as a hint', () => {
  const nodes = [userNode(1, 'please fix the login bug')]
  assert.throws(() => resolveBoundaries(nodes, { endAnchor: 'totally unrelated text' }), /not found on the surface/)
})

test('resolveBoundaries: resolved start after resolved end is rejected', () => {
  const nodes = [userNode(1, 'first message'), userNode(2, 'second message')]
  assert.throws(
    () => resolveBoundaries(nodes, { startAnchor: 'second message', endAnchor: 'first message' }),
    /start sits after resolved end/,
  )
})

test('resolveBoundaries: end anchor on a tool-calling turn snaps forward through its tool/result', () => {
  const nodes = [
    userNode(1, 'run the tests'),
    assistantToolCallNode(2, 'call-1', 'run_tests', '{}'),
    toolResultNode(3, 'all green'),
    userNode(4, 'great, ship it'),
  ]
  const b = resolveBoundaries(nodes, { endAnchor: '[tool-call run_tests]' })
  // 终点吸附穿过了紧随其后的 tool/result（seq 3），而不是停在发起调用的
  // assistant/message（seq 2）——否则区间会留下一个没有其调用者的孤立结果。
  assert.equal(b.endSeq, 3)
  assert.match(b.method, /end-snapped/)
})

test('resolveBoundaries: CJK full/half-width punctuation does not create false ambiguity', () => {
  const nodes = [
    userNode(1, '已经重启了，那别人在其它插件改这个 root 会崩吗'),
    assistantTextNode(2, '不会崩，各插件的补丁是独立应用的'),
  ]
  // 锚点用半角逗号，节点原文用全角逗号：normText 统一映射后仍应唯一匹配。
  const b = resolveBoundaries(nodes, { startAnchor: '已经重启了,那别人', endAnchor: '不会崩' })
  assert.equal(b.startSeq, 1)
  assert.equal(b.endSeq, 2)
})

test('snapStartBalanced: a tool/result start snaps back to the assistant/message that issued it', () => {
  const nodes = [
    userNode(1, 'run it'),
    assistantToolCallNode(2, 'call-1', 'run', '{}'),
    toolResultNode(3, 'ok'),
  ]
  assert.equal(snapStartBalanced(nodes, 2), 1)
})

test('snapStartBalanced: a message-type start is left untouched', () => {
  const nodes = [userNode(1, 'hi'), assistantTextNode(2, 'hello')]
  assert.equal(snapStartBalanced(nodes, 1), 1)
})

test('snapEndBalanced: extends through every trailing tool/result of the same call', () => {
  const nodes = [
    assistantToolCallNode(1, 'call-1', 'run', '{}'),
    toolResultNode(2, 'partial'),
    toolResultNode(3, 'final'),
    userNode(4, 'thanks'),
  ]
  assert.equal(snapEndBalanced(nodes, 0), 2)
})

test('soleToolCall: true only for an assistant/message carrying exactly this one tool-call', () => {
  const solo = assistantToolCallNode(1, 'call-1', 'run', '{}')
  assert.equal(soleToolCall(solo, 'call-1'), true)
  assert.equal(soleToolCall(solo, 'call-2'), false)

  const multi = assistantMultiToolCallNode(2, ['call-a', 'call-b'])
  assert.equal(soleToolCall(multi, 'call-a'), false)

  const notAssistant = userNode(3, 'hi')
  assert.equal(soleToolCall(notAssistant, 'call-1'), false)
})

test('resolveBoundaries: ambiguous checkpoint-style hits get shared-prefix-elided previews', () => {
  // host 的 dsh-compaction-basic 给每条 checkpoint 套的固定 preamble/
  // <compacted-summary> 标签逐字相同、远超 80 字；两条 checkpoint 撞上同一个
  // 短锚点时，若预览还是从头截 80 字，两条会长得一模一样，没法据此选。
  const preamble =
    'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ' +
    'Treat the captured context as established background and build on it without restating it. Continue the task ' +
    'directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>'
  const nodes = [
    userNode(1, preamble + '## Dependency upgrade task (done)\nsome details'),
    userNode(2, preamble + '## Nit cleanup task (done)\nother details'),
  ]
  let message = ''
  try {
    resolveBoundaries(nodes, { endAnchor: preamble })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /AMBIGUOUS: 2 nodes/)
  assert.match(message, /shared \d+-char prefix elided/)
  const lines = message.split('\n').filter((l) => l.startsWith('pos '))
  assert.equal(lines.length, 2)
  assert.notEqual(lines[0], lines[1])
  assert.match(lines[0], /Dependency upgrade/)
  assert.match(lines[1], /Nit cleanup/)
})

test('resolveBoundaries: unmatched-anchor hint never recommends a tool/result or in-progress tool-call node', () => {
  const nodes = [
    userNode(1, 'please fix the login bug'),
    // 这条 assistant/message 里嵌了一个失败的 context_compact 调用，参数里
    // 逐字回带了锚点文本本身——旧的 nearestHint 不区分节点类型，词重叠算法
    // 会把它当成"最接近"的候选推荐回来，纯属自我循环、毫无信息量。
    assistantToolCallNode(2, 'call-1', 'context_compact', '{"endAnchor":"please fix the login zzz"}'),
    // Its result (linked by call id, as real results are) echoes the anchor too: the
    // tool-result fallback must never pick a context_compact result.
    toolResultNode(3, 'please fix the login zzz result text', false, 'call-1'),
  ]
  let message = ''
  try {
    resolveBoundaries(nodes, { endAnchor: 'please fix the login zzz' })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /not found on the surface/)
  assert.doesNotMatch(message, /tool\/result/)
})

test('resolveBoundaries: CJK anchor-overlap hint tokenizes by character, not by whole sentence', () => {
  const nodes = [
    userNode(1, '把插件依赖升级到最新版本并跑一遍测试'),
    userNode(2, '完全不相关的另一段话'),
  ]
  // 锚点与 seq 1 共享前 12 个字，但结尾不同，不会作为前缀命中；旧的按空格
  // 分词在没有空格的中文里会把整句当成一个词，几乎必然算出 0 重叠、给不出
  // 任何提示。逐字切词后应该能算出 seq 1 明显更接近，把它列进提示里。
  let message = ''
  try {
    resolveBoundaries(nodes, { endAnchor: '把插件依赖升级到最新版本，然后提交' })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /not found on the surface/)
  assert.match(message, /pos 0 \| seq 1/)
})

test('spanText: renders every node with its seq/pos/type header and keeps full text', () => {
  const nodes = [userNode(5, 'step done'), assistantTextNode(6, 'acknowledged')]
  const text = spanText(nodes, 0, 1)
  assert.match(text, /--- seq 5 \| pos 0 \| user\/message ---\nstep done/)
  assert.match(text, /--- seq 6 \| pos 1 \| assistant\/message ---\nacknowledged/)
})

// ---- Fork: Denkspur und Anker-Hinweise (Anthropic-Sperre, 2026-10-09) ----

function assistantReasoningNode(seq, reasoning, text) {
  const content = [{ type: 'reasoning', text: reasoning }]
  if (text) content.push({ type: 'text', text })
  return { seq, type: 'assistant/message', data: { message: { content } } }
}

test('spanText: archives keep the visible text and drop the reasoning trace', () => {
  const nodes = [
    userNode(1, 'bitte bauen'),
    assistantReasoningNode(2, 'GEHEIME DENKSPUR: erst pruefen, dann bauen', 'Ich baue den kleinsten Schritt.'),
  ]
  const text = spanText(nodes, 0, 1)
  assert.match(text, /Ich baue den kleinsten Schritt\./)
  assert.doesNotMatch(text, /GEHEIME DENKSPUR/)
})

test('spanText: reasoning stays out of the archive byte-for-byte, images keep their marker', () => {
  const nodes = [
    { seq: 1, type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: 'nur gedacht' },
      { type: 'image' },
      { type: 'text', text: 'sichtbar' },
    ] } } },
  ]
  const text = spanText(nodes, 0, 0)
  assert.match(text, /\[image\]/)
  assert.match(text, /sichtbar/)
  assert.doesNotMatch(text, /nur gedacht/)
})

test('resolveBoundaries: a not-found anchor names the reasoning trap and shows the tail', () => {
  const nodes = [
    userNode(1, 'erste Aufgabe'),
    assistantReasoningNode(2, 'Die Gegenprobe trennt sauber', 'Fertig, ich lese jetzt Perforce.'),
    userNode(3, 'weiter'),
  ]
  let message = ''
  try {
    resolveBoundaries(nodes, { startAnchor: 'erste Aufgabe', endAnchor: 'Die Gegenprobe trennt sauber' })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /not found on the surface/)
  assert.match(message, /reasoning/)
  assert.match(message, /last messages on the surface/)
  assert.match(message, /Fertig, ich lese jetzt Perforce\./)
})

test('resolveBoundaries: harness notices are never offered as anchor candidates', () => {
  const notice = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
  const nodes = [
    userNode(1, notice),
    userNode(2, 'Die Leseliste ist durchgearbeitet.'),
  ]
  let notFound = ''
  try {
    resolveBoundaries(nodes, { startAnchor: 'etwas voellig anderes', endAnchor: 'Die Leseliste ist durchgearbeitet.' })
  } catch (err) {
    notFound = err.message
  }
  assert.match(notFound, /not found on the surface/)
  assert.doesNotMatch(notFound, /runtime context/)
  assert.match(notFound, /Die Leseliste ist durchgearbeitet\./)
})

// ---- Der geschuetzte Systemkopf (2026-10-15) ----
// Befund aus einer echten Sitzung: Der Aufruf kam ohne startAnchor, die Grenze
// fiel damit auf Position 0 - und Position 0 hielt den Systemprompt. Der Motor
// schrieb compaction/start und compaction/summary, die Ersetzung wurde danach
// abgelehnt ("node 0 holds the system prompt"). Die Zusammenfassungszeile blieb
// im Protokoll stehen, und die Sitzung liess sich nicht mehr laden.

function systemNode(seq, text) {
  return { seq, type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text }] } } }
}

test('resolveBoundaries: ohne startAnchor beginnt der Abschnitt HINTER dem Systemkopf', () => {
  const nodes = [
    systemNode(8, 'You are an AI agent powered by DeepSeek Harness. Du bist der kanten-experte.'),
    userNode(9, 'erste Aufgabe'),
    userNode(11, 'zweite Aufgabe'),
  ]
  const r = resolveBoundaries(nodes, { endAnchor: 'zweite Aufgabe' })
  assert.equal(r.startSeq, 9, 'der Systemkopf darf nie Teil des Abschnitts sein')
  assert.match(r.method, /start=after-system/)
})

test('resolveBoundaries: ohne Systemkopf bleibt der Anfang wie bisher die erste Nachricht', () => {
  const nodes = [userNode(1, 'erste Aufgabe'), userNode(2, 'zweite Aufgabe')]
  const r = resolveBoundaries(nodes, { endAnchor: 'zweite Aufgabe' })
  assert.equal(r.startSeq, 1)
  assert.match(r.method, /start=first/)
})

test('resolveBoundaries: ein Systemknoten ist kein Ankerziel (der Kopf bleibt so oder so draussen)', () => {
  const nodes = [
    systemNode(8, 'You are an AI agent powered by DeepSeek Harness.'),
    userNode(9, 'erste Aufgabe'),
  ]
  // Der Systemknoten ist keine Nachricht, die die Sitzung ausgetauscht hat: er
  // wird nie gefunden. Damit kann kein Anker versehentlich den Kopf treffen.
  assert.throws(
    () => resolveBoundaries(nodes, { startAnchor: 'You are an AI agent', endAnchor: 'erste Aufgabe' }),
    /not found on the surface/,
  )
})

test('resolveBoundaries: mehrere Systemknoten am Kopf werden alle uebersprungen', () => {
  const nodes = [
    systemNode(8, 'Hauprompt'),
    systemNode(20, 'zusaetzlicher Hinweis'),
    userNode(9, 'erste Aufgabe'),
    userNode(11, 'zweite Aufgabe'),
  ]
  const r = resolveBoundaries(nodes, { endAnchor: 'zweite Aufgabe' })
  assert.equal(r.startSeq, 9)
})

test('resolveBoundaries: der Belegfall vom 15.10. kann nicht mehr passieren', () => {
  // Echter Aufruf ohne startAnchor, endAnchor = eine Teamnachricht. Vorher
  // begann die Spanne auf Position 0, also auf dem Systemprompt; der Harness
  // lehnte die Ersetzung danach ab und die summary-Zeile blieb im Protokoll.
  const nodes = [
    systemNode(8, 'You are an AI agent powered by DeepSeek Harness. Du bist der kanten-experte.'),
    userNode(9, 'Team message team-message-abc from lead\nAuftrag: Raender der Ziegelwand.'),
    userNode(40, 'Zwischenstand'),
  ]
  const r = resolveBoundaries(nodes, { endAnchor: 'Zwischenstand' })
  assert.equal(nodes[r.si].type, 'user/message')
  assert.notEqual(r.si, 0)
})

test('resolveBoundaries: eine Oberflaeche aus lauter Systemknoten wird abgelehnt', () => {
  const nodes = [systemNode(8, 'nur der Prompt'), systemNode(9, 'noch ein Hinweis')]
  assert.throws(() => resolveBoundaries(nodes, { endAnchor: 'noch ein Hinweis' }), /nothing but system messages/)
})

// ---- Fork 2026-10-29: Kennungen in den Kandidaten- und Nachbar-Zeilen ----
// Gemessen: die Kandidaten einer AMBIGUOUS-Abweisung sind Harness-Meldungen,
// deren erste Zeile vorgeschrieben ist — zwei Fertig-Meldungen desselben
// Unteragenten sind wortgleich, also ist "verlaengere den Anker" dort kein
// Ausweg. Der einzige Anker, der genau einen Knoten trifft, ist die Kennung;
// sie muss in den Zeilen stehen, die das Modell beim Fehlschlag liest.

test('resolveBoundaries: AMBIGUOUS candidates each carry their anchor marker, and a copied marker resolves', () => {
  const nodes = [userNode(1, 'do the thing now'), userNode(2, 'do the thing again')]
  let message = ''
  try {
    resolveBoundaries(nodes, { endAnchor: 'do the thing' })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /AMBIGUOUS: 2 nodes/)
  const lines = message.split('\n').filter((l) => l.startsWith('pos '))
  assert.equal(lines.length, 2)
  const markers = lines.map((l) => /\[a[0-9a-f]{6}\]/.exec(l)[0])
  assert.equal(markers.length, 2)
  assert.notEqual(markers[0], markers[1])
  // Der Marker aus der Kandidaten-Zeile ist ein Anker, der genau einen Knoten
  // trifft — dieselbe Abweisung, die den Text-Anker nicht auflösen konnte,
  // löst mit der Kennung sauber auf.
  const r = resolveBoundaries(nodes, { startAnchor: 'do the thing now', endAnchor: markers[1] })
  assert.equal(r.endSeq, 2)
})

test('resolveBoundaries: AMBIGUOUS lists the neighbouring markers, and the predecessor keeps the candidate', () => {
  const settlement = 'Background subagent abc finished and will do no further work'
  const nodes = [
    userNode(1, 'Erste Anweisung: baue die Bruecke'),
    assistantTextNode(2, settlement),
    assistantTextNode(3, 'ack, ich baue weiter an der Bruecke'),
    assistantTextNode(4, settlement),
  ]
  let message = ''
  try {
    resolveBoundaries(nodes, { startAnchor: 'Erste Anweisung', endAnchor: settlement })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /AMBIGUOUS: 2 nodes/)
  assert.match(message, /neighbouring messages/)
  // Der Vorgänger des zweiten Kandidaten ist die Meldung, die bei „bis genau
  // davor“ erhalten bleiben soll; ihre Kennung steht kopierbar in der Meldung.
  assert.ok(message.includes(markerTag(3) + ' pos 2 | seq 3 | assistant/message'))
  // Der kopierte Vorgänger-Marker ist der Anker, der den Kandidaten erhält.
  const r = resolveBoundaries(nodes, { startAnchor: 'Erste Anweisung', endAnchor: markerTag(3) })
  assert.equal(r.endSeq, 3)
})

test('resolveBoundaries: the not-found hint carries each candidate marker too', () => {
  const nodes = [userNode(1, 'Die Leseliste ist durchgearbeitet.'), userNode(2, 'weiter')]
  let message = ''
  try {
    resolveBoundaries(nodes, { endAnchor: 'Die Leseliste ist durchgearbeitet und abgelegt' })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /not found on the surface/)
  assert.match(message, /each with its marker/)
  assert.ok(message.includes(markerTag(1) + ' | user/message'))
})

// Layer-Cake (2026-10-29): der Schnitt-Preis. Die Zusagen, die die Anweisung
// dem Modell nennt: ein Schnitt am Ende ist billiger als einer in der Mitte,
// und die Kandidaten-Zeile trägt den Preis, damit das Modell vergleichen kann.
test('tailCutPrice: a cut at the end is cheaper than a cut in the middle', () => {
  const long = 'x'.repeat(6270) // 1000 Token bei 6,27 Zeichen/Token
  const nodes = [
    userNode(1, 'Anfang'),
    assistantTextNode(2, long),
    assistantTextNode(3, long),
    assistantTextNode(4, 'Ende'),
  ]
  // Schnitt bis Knoten 1 (Mitte): alles nach ihm — zwei lange Knoten plus Ende.
  const middle = tailCutPrice(nodes, 1)
  // Schnitt bis Knoten 3 (Ende): nur der kurze Schwanz danach.
  const end = tailCutPrice(nodes, 3)
  assert.ok(end < middle, `end ${end} muss kleiner sein als middle ${middle}`)
  // Der letzte Knoten: nichts nach ihm, Preis 0.
  assert.equal(tailCutPrice(nodes, nodes.length - 1), 0)
  // Die Schätzung ist eine Größenordnung: 6270 Zeichen sind ~1000 Token.
  assert.equal(nodeTokenEstimate(nodes[1]), Math.round(long.length / ZEICHEN_PRO_TOKEN))
  // Ein Schnitt bis Knoten 0 liest genau die Knoten 1..3 neu.
  assert.equal(cutPriceTokens(nodes, 0, 0), nodeTokenEstimate(nodes[1]) + nodeTokenEstimate(nodes[2]) + nodeTokenEstimate(nodes[3]))
})

test('nodeSummaryLine: the candidate line carries the cut price', () => {
  const settlement = 'Background subagent abc finished and will do no further work'
  const nodes = [
    userNode(1, 'Erste Anweisung: baue die Bruecke'),
    assistantTextNode(2, settlement),
    assistantTextNode(3, 'ack, ich baue weiter an der Bruecke'),
    assistantTextNode(4, settlement),
  ]
  let message = ''
  try {
    resolveBoundaries(nodes, { startAnchor: 'Erste Anweisung', endAnchor: settlement })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /AMBIGUOUS: 2 nodes/)
  // Die Kandidaten- und die Nachbar-Zeile tragen den Schnitt-Preis, damit das
  // Modell den Preis eines Schnitts in der Mitte gegen einen am Ende vergleichen
  // kann, ohne ihn zu raten.
  assert.match(message, /cut price ≈ \d+ tokens/)
})

test('gebautes lib/index.js trägt die Endpunkt-Regel: endAnchor optional, Vorgabe letzter Knoten', async () => {
  const { readFileSync } = await import('node:fs')
  const code = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.equal(code.includes('endAnchor may be OMITTED'), true)
  assert.equal(code.includes('LAST node on the surface'), true)
  assert.equal(code.includes('in-flight answer'), true)
  // Die alte Pflicht-Formulierung des ENDPUNKTS darf nicht zurückkehren. Der
  // summary-Feldtext sagt weiterhin "Required for scope" (summary ist Pflicht),
  // also prüfen wir den endAnchor-Beschreibungstext isoliert.
  const endDesc = code.slice(code.indexOf('endAnchor: { type'), code.indexOf('summary: { type'))
  assert.match(endDesc, /OPTIONAL: omit it/)
  assert.equal(endDesc.includes('Required for scope'), false)
  assert.equal(code.includes('provide endAnchor'), false)
})
