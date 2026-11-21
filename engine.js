/**
 * dsh-metabolism 第二阶段：接管宿主的自动压缩。
 *
 * 做法跟 billion-context 一样，不去抢 ctx.compaction（那个服务在隔离作用域里，
 * 宿主平面 provide 的钥匙和预设里的不是同一把）：
 *   1. 用 internal/config 钩子，把预设里自带的 compaction-basic / command-compact 关掉；
 *   2. 自己监听 agent/pre-step，按我们自己的规矩挑段、写「指向空」的摘要和替换事件；
 *   3. 归档交给同 bundle 的 metabolism（它监听 compaction/end，两边不耦合）。
 *
 * 运行时开关在 记忆\代谢日志\开关.json：{ "takeover": false, "dryRun": true }
 * 改这个文件就换档，不用重启。
 *
 * @module dsh-metabolism/engine
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeL1 } from './骨架.js'
import { renderSummaryBlock, estimateTokens } from './摘要块.js'
import { appendTimeline, hasTimelineFor, readTimeline } from './时间线.js'

/** 本机覆盖：插件目录里的 本地配置.json（不进包，发布版没有这个文件）。 */
function localOverrides() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./本地配置.json', import.meta.url), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 默认目录：按 profile 目录算，别人装上去也能落到自己家里。 */
function defaultBase(kind) {
  const local = localOverrides()
  const fromLocal = typeof local.archiveRoot === 'string' ? local.archiveRoot.trim() : ''
  const fromEnv = typeof process.env.DSH_METABOLISM_HOME === 'string' ? process.env.DSH_METABOLISM_HOME.trim() : ''
  if (fromLocal.length > 0) return kind === 'archive' ? fromLocal : join(dirname(fromLocal), '代谢日志')
  if (fromEnv.length > 0) return kind === 'archive' ? fromEnv : join(dirname(fromEnv), '代谢日志')
  const base = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || homedir()
  return kind === 'archive' ? join(base, '代谢', '茅房') : join(base, '代谢', '代谢日志')
}

const STOCK_COMPACTION = '@deepseek-ai/dsh-compaction-basic'
const STOCK_COMMAND = '@deepseek-ai/dsh-command-compact'
const GATE_SERVICE = 'metabolismCompactionGate'
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

const SUMMARY_SYSTEM = `你在给一段被压缩掉的对话写「归档卡」。看下面这段原文，写出这几样东西：

【短】不超过四十个字，说清这段在聊什么。这是以后放回上下文里的那一行，写给人看的。
【在干什么】一句话，说清这段在处理哪件事。
【仍然有效的要求】还有哪些约束、规矩、老大交代过的话仍然算数。一行一条，没有就写「无」。
【已经做到】已经做完、已经确认的事。一行一条，可以加「（未完成）」。
【下一步】一句话，接下来该做什么。
【关键词】三到六个名词，用逗号隔开，以后靠它检索。
【原话】直接从原文摘三到六句最重要的话，一字不改。

规矩：
- 只写这段里真有的，不补不猜；拿不准就写「不清楚」。
- 每一块都要有内容，不许留空；真没有就写「无」。
- 记得把「下一步」写出来，这是以后接手的抓手。
- 不写「用户」「助手」这种称呼，直接写事。
- 原话那几条必须逐字照抄原文，不许改写、不许润色。
- 不写抱歉、不写总结陈词、不写「以上」。
- 短的那行不要句号结尾。`

export const name = 'metabolism-engine'
export const inject = ['tokenMeter', 'llm', 'tools']
export { tailBalanced, surfaceBalance }

/** 「同一个判断」的节流表：签名 → 上次记录时间。 */
const lastPlan = new Map()
/** 每个会话只记一次窗口数字，方便核对。 */
const seenWindow = new Set()
/**
 * 手动压缩的排队表：会话 id → 想压的 seq 区间。
 *
 * 模型自己调 metabolism_compact 的时候，它这条调用刚发出去、结果还没回来；
 * 此刻往会话里追加 checkpoint，就会插在「调用」和「结果」中间，DeepSeek 下次
 * 请求直接报 “tool calls need immediate results”。所以先记下来，等这一次的
 * 工具结果落地、下一轮 pre-step 再真正写。
 */
const pendingCompact = new Map()

/**
 * 摘要块 · 回路里写（2026-11-20 老大拍定「一步到位，走 1」）
 *
 * 到硬线时不再直接压：先往上下文里发一条预告，把候选区间和写法要求说清楚，
 * 我在下一轮用 metabolism_summarize 把摘要块交回来，引擎再执行替换。
 * 等不到（超时，或者水位已经压过头发），就退回模型／抽取兜底，绝不停在那儿。
 */
const SUMMARY_WAIT_MS = 5 * 60 * 1000
const SUMMARY_FORCE_EXTRA_TOKENS = 30000

/** 代谢日志目录：跟开关文件同目录（可配置），没配才退回本机固定路径。 */
function summaryDir(options) {
  if (typeof options?.switchesFile === 'string' && options.switchesFile.length > 0) return dirname(options.switchesFile)
  return 'D:\\deepseek工作区\\记忆\\代谢日志'
}
function summaryStateFile(options) { return join(summaryDir(options), '待压摘要.json') }
function summaryRegistryFile(options) { return join(summaryDir(options), '摘要块注册.json') }

function readSummaryState(options) {
  try {
    const parsed = JSON.parse(readFileSync(summaryStateFile(options), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeSummaryState(state, options) {
  try {
    mkdirSync(summaryDir(options), { recursive: true })
    writeFileSync(summaryStateFile(options), JSON.stringify(state, null, 2), 'utf8')
  } catch {}
}

function clearSummaryState(options) {
  writeSummaryState({}, options)
}

/** 摘要块登记册：每次压完登记一块，折叠时按它算年龄和总量。 */
const SUMMARY_BUDGET_TOKENS = 65000
const SUMMARY_LAYER_A_DAYS = 7
const SUMMARY_PROTECT_MS = 24 * 60 * 60 * 1000

function readSummaryRegistry(options) {
  try {
    const parsed = JSON.parse(readFileSync(summaryRegistryFile(options), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeSummaryRegistry(rows, options) {
  try {
    mkdirSync(summaryDir(options), { recursive: true })
    writeFileSync(summaryRegistryFile(options), JSON.stringify(rows, null, 2), 'utf8')
  } catch {}
}

/** 从一条会话事件里抠出文本正文；没有就 null。 */
function contentTextOf(event) {
  const blocks = event?.data?.content ?? event?.data?.message?.content
  if (!Array.isArray(blocks)) return null
  const text = blocks.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n')
  return text.length > 0 ? text : null
}

/** 我自己写的摘要块没有 card，从这里派生一张骨架卡（只补下一步／未决 + 摘原话）。 */
function deriveCard(text) {
  const lines = String(text).split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const title = (lines[0] ?? '').slice(0, 24)
  let next = ''
  const quotes = []
  for (const line of lines) {
    const m = line.match(/^(?:下一步|还没做完|还欠|未决)[：:]\s*(.+)$/)
    if (m !== null) { next = String(m[1]).trim(); continue }
    const q = line.match(/^[>「『“"](.+)[」』”"]$/)
    if (q !== null && line.length < 80) quotes.push(String(q[1]).trim())
  }
  const doing = lines.slice(0, 6).join(' ')
  return { doing, requirements: [], done: [], next, quotes: quotes.slice(0, 3), keywords: [], title }
}

/** 四级降级第 3 级：没模型时，从被压段里按规则抽一个最小可读块（纯代码，永远可用）。 */
function deterministicSummary(session, range) {
  let meLine = ''
  let userLine = ''
  for (let index = range.startIdx; index <= range.endIdx; index += 1) {
    const event = session.eventAt(session.surface.nodes[index])
    if (event === undefined) continue
    const text = contentTextOf(event)
    if (text === null || text.length < 8) continue
    if (event.type === 'assistant/message' && meLine === '') meLine = text.slice(0, 90)
    if (event.type === 'user/message' && userLine === '' && !text.startsWith('<') && !text.startsWith('【') && !text.startsWith('Time sampled')) userLine = text.slice(0, 60)
    if (meLine !== '' && userLine !== '') break
  }
  return [
    '【这段做了什么】',
    meLine !== '' ? meLine : '（没摘到）',
    '',
    '【我们之间】',
    userLine !== '' ? userLine : '（没摘到）',
  ].join('\n')
}

/**
 * 折叠摘要块（2026-11-20，P2）。
 *
 * 先把折叠做成只读报告（foldDryRun 默认 true）：在日志里写清楚"该折哪几块、为什么"，
 * 不动会话。等 P4 在影子会话里验证过 surface 手术，再把 dryRun 关掉，真动手。
 */
/** 从摘要正文取第一句，折叠索引条目用（一句话定位，不多不少）。 */
function firstSentence(text) {
  const t = String(text ?? '').trim()
  if (t === '') return '（无内容）'
  const m = t.match(/^.*?[。！？!?\n]/)
  const one = m ? m[0].trim() : t.slice(0, 40)
  return one.length > 60 ? `${one.slice(0, 60)}…` : one
}

function foldSummaries(ctx, options, session, log) {
  if (options.foldEnabled !== true) return
  const registry = readSummaryRegistry(options)
  const nodes = session.surface.nodes
  // 只认还在表层里的块：按归档文件名（compactionId）对回登记册
  const blocks = []
  const byCid = new Map()
  for (const row of registry) byCid.set(row.compactionId, row)
  for (let i = 0; i < nodes.length; i += 1) {
    const text = contentTextOf(session.eventAt(nodes[i]))
    if (text === null || !text.includes('<summary-block')) continue
    const am = text.match(/归档：([A-Za-z0-9-]+\.jsonl)/)
    const cid = String(am?.[1] ?? '').replace(/\.jsonl$/, '')
    if (cid === '') continue
    const row = byCid.get(cid)
    if (row === undefined) continue
    blocks.push({ index: i, seq: nodes[i], cid, at: Number(row.at) || 0, tokens: Number(row.tokens) || estimateTokens(row.body ?? ''), body: String(row.body ?? ''), seqFrom: row.seqFrom, seqTo: row.seqTo, mode: String(row.mode ?? 'passive') })
  }
  if (blocks.length === 0) {
    if (registry.length > 0) log('info', `折叠：登记册 ${registry.length} 块，但表层没扫到 <summary-block>，跳过`)
    return
  }

  const now = Date.now()
  const total = blocks.reduce((sum, block) => sum + block.tokens, 0)
  const oldestFirst = [...blocks].sort((a, b) => {
    const av = a.mode === 'active' ? 0 : 1
    const bv = b.mode === 'active' ? 0 : 1
    if (av !== bv) return av - bv
    return a.at - b.at
  })
  const budget = Number(options.summaryBudgetTokens ?? SUMMARY_BUDGET_TOKENS) || SUMMARY_BUDGET_TOKENS

  // 1) 到期：超过 7 天的层 a 块
  const expired = oldestFirst.filter((block) => now - block.at > SUMMARY_LAYER_A_DAYS * 86400000)
  // 2) 总量：超预算，按最老补齐
  let targets = [...expired]
  if (total > budget) {
    let kept = 0
    for (const block of oldestFirst) {
      if (targets.includes(block)) continue
      if (total - kept <= budget) break
      kept += block.tokens
      targets.push(block)
    }
  }
  if (targets.length === 0) {
    log('info', `摘要块 ${blocks.length} 块 / ${total} tokens，没到折叠线（预算 ${budget}）`)
    return
  }
  // 3) 保护：24 小时内的不折；若全员保护又必须折，破例折最老一块
  const unprotectable = targets.filter((block) => now - block.at < SUMMARY_PROTECT_MS)
  let final = targets.filter((block) => now - block.at >= SUMMARY_PROTECT_MS)
  if (final.length === 0 && unprotectable.length > 0) {
    final = [oldestFirst[0]]
    log('warn', `摘要块全员在保护期内，破例折最老一块（${final[0].cid}）`)
  }
  if (final.length === 0) return

  const label = final.map((block) => block.cid.slice(-6)).join(',')
  const foldNow = options.foldDryRun === false
  if (!foldNow) {
    log('info', `[演练] 该折 ${final.length} 块（${label}），登记 ${blocks.length} 块 / ${total} tokens，预算 ${budget}`)
    return
  }

  // —— 真折：按相邻块分组，一组折成一条索引。中间夹着原文就分开折，绝不吞原文 ——
  const sorted = [...final].sort((a, b) => a.index - b.index)
  const groups = []
  let group = [sorted[0]]
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].index === group[group.length - 1].index + 1) {
      group.push(sorted[i])
    } else {
      groups.push(group)
      group = [sorted[i]]
    }
  }
  groups.push(group)

  const foldedRows = []
  const foldedCids = []
  // 从最高 index 往下折：先折后面的，低 index 不受后面删除节点的影响
  const ordered = groups.sort((a, b) => b[0].index - a[0].index)
  for (const grp of ordered) {
    const startIdx = grp[0].index
    const endIdx = grp[grp.length - 1].index
    const fromSeq = nodes[startIdx]
    const toSeq = nodes[endIdx]
    const shadowed = session.surface.nodes.slice(startIdx, endIdx + 1)
    const indexText = grp.map((block) => {
      const one = firstSentence(block.body)
      return `· ${one}〔${block.cid}.jsonl · seq ${block.seqFrom}–${block.seqTo}〕`
    }).join('\n')
    const folded = {
      compactionId: `idx-${now.toString(36)}-${randomUUID().slice(0, 4)}`,
      seqFrom: fromSeq,
      seqTo: toSeq,
      at: now,
      tokens: estimateTokens(indexText),
      layer: 'index',
      body: indexText,
    }
    log('info', `折叠 ${grp.length} 块为一条索引：seq ${fromSeq}–${toSeq}，覆盖 ${shadowed.length} 个表层节点`)
    session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `<summary-block seq="${fromSeq}–${toSeq}">\n${indexText}\n</summary-block>` }],
      source: { kind: 'summary-fold', folded: grp.map((block) => block.cid) },
    }, {
      surfaceOp: { op: 'replace', startSeq: fromSeq, endSeq: toSeq },
      sourceEventSeqs: [...shadowed],
    })
    foldedRows.push(folded)
    foldedCids.push(...grp.map((block) => block.cid))
  }

  const remaining = registry.filter((row) => !foldedCids.includes(row.compactionId))
  remaining.push(...foldedRows)
  writeSummaryRegistry(remaining, options)

  // 折叠顺手补当天时间线（已有就跳过）
  const dayMin = new Date(Math.min(...final.map((block) => block.at))).toISOString().slice(0, 10)
  const dayMax = new Date(Math.max(...final.map((block) => block.at))).toISOString().slice(0, 10)
  if (!hasTimelineFor(dayMax, options.archiveRoot)) {
    appendTimeline({
      date: dayMax,
      from: dayMin,
      to: dayMax,
      title: `折叠：${final.length} 块 → ${foldedRows.length} 块`,
      what: foldedRows.map((row) => row.body).join('\n').slice(0, 300),
      we: '',
      feel: '',
      topics: [],
      sources: foldedCids.map((cid) => `${cid}.jsonl`),
      spanFrom: Math.min(...foldedRows.map((row) => row.seqFrom)),
      spanTo: Math.max(...foldedRows.map((row) => row.seqTo)),
      made: '折叠自动',
    }, options.archiveRoot)
  }
  log('info', `折完了：${final.length} 块 → ${foldedRows.length} 条索引，登记册剩 ${remaining.length} 条`)
}

/** 摘要块给上下文用的那一行：短、能扫。 */
function summaryShortLine(text) {
  const first = String(text).split(/[\n。！？]/).map((part) => part.trim()).find((part) => part.length > 0) ?? ''
  return first.length > 60 ? `${first.slice(0, 60)}…` : first
}

export function resolveEngineConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const local = localOverrides()
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
  /** 顺序：补丁里写的 → 本地配置.json → 按 profile 算的默认值。 */
  const pathOf = (key, fallback) => {
    const fromSource = typeof source[key] === 'string' ? source[key].trim() : ''
    if (fromSource.length > 0) return fromSource
    const fromLocal = typeof local[key] === 'string' ? local[key].trim() : ''
    if (fromLocal.length > 0) return fromLocal
    return fallback
  }
  return {
    takeover: source.takeover === true,
    enabled: source.enabled !== false,
    dryRun: source.dryRun !== false,
    thresholdRatio: number(source.thresholdRatio, 0.8),
    retainRatio: number(source.retainRatio, 0.12),
    minChunkTokens: number(source.minChunkTokens, 2000),
    contextWindow: number(source.contextWindow, 0),
    /** 绝对阈值：总 token 超过这个数就开始压。0 表示退回按窗口比例算。 */
    thresholdTokens: number(source.thresholdTokens, 260000),
    /** 压完之后保留多少 token 的最近内容。0 表示退回按窗口比例算。 */
    retainTokens: number(source.retainTokens, 130000),
    /** 对话最少留多少 token（切不动的工具定义不算在内）。老大定的：8 万，别让他断片。 */
    minKeepTokens: number(source.minKeepTokens, 80000),
    /** 时间闸：最近这么多小时里的内容一律不切（老大要的「一天以内不忘事」）。0 表示不设。 */
    keepRecentHours: number(source.keepRecentHours, 24),
    /** 输出预留封顶：最多从窗口里扣掉这么多给回答，别让 256k 的默认值把窗口吃光。 */
    maxReserveTokens: number(source.maxReserveTokens, 65536),
    /** 归档时让模型写两行摘要；关掉就退回只有指针。 */
    summaryEnabled: source.summaryEnabled !== false,
    /** 三级记忆・骨架：压完顺手写一张说明卡（记忆\骨架\L1）。关掉就只走老的归档。 */
    skeletonEnabled: source.skeletonEnabled !== false,
    /** 摘要用哪个模型；不填就跟着当前会话走的模型。 */
    summaryProvider: typeof source.summaryProvider === 'string' ? source.summaryProvider : '',
    summaryModel: typeof source.summaryModel === 'string' ? source.summaryModel : '',
    /** 喂给模型的样本最多多少字，别把整段塞进去。 */
    summarySampleChars: number(source.summarySampleChars, 6000),
    /** 钉住的要求：这段内容会跟着每一条指针进上下文，压多少次都不会丢。 */
    pinFile: pathOf('pinFile', join(defaultBase('log'), '钉住.md')),
    pinMaxChars: number(source.pinMaxChars, 800),
    /** 软线：到这个数就往会话里插一句提醒，让我自己看目录、自己挑段。0 表示不提醒。 */
    softTokens: number(source.softTokens, 270000),
    /** 隔多少 token 再提醒一次，别每轮都念。 */
    nudgeStep: number(source.nudgeStep, 20000),
    /** 要不要每轮顺手裁掉超长的工具结果（借宿主自带的裁剪服务）。 */
    pruneEnabled: source.pruneEnabled !== false,
    /** 单条工具结果超过多少字符才裁（字符，不是 token）。 */
    pruneThresholdChars: number(source.pruneThresholdChars, 12000),
    archiveRoot: pathOf('archiveRoot', defaultBase('archive')),
    logFile: pathOf('logFile', join(defaultBase('log'), 'engine.log')),
    switchesFile: pathOf('switchesFile', join(defaultBase('log'), '开关.json')),
  }
}

/** 读运行时开关文件；读不到就当没写。 */
function readSwitches(file) {
  try {
    // 记事本/Out-File/PowerShell 写的 JSON 常带 BOM，JSON.parse 会直接抛，
    // 抛了就等于开关全线失效（2026-11-19 踩过：takeover 被悄悄读成 false）。
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return {}
    const value = {}
    if (typeof parsed.takeover === 'boolean') value.takeover = parsed.takeover
    if (typeof parsed.enabled === 'boolean') value.enabled = parsed.enabled
    if (typeof parsed.dryRun === 'boolean') value.dryRun = parsed.dryRun
    if (Number.isFinite(Number(parsed.thresholdRatio))) value.thresholdRatio = Number(parsed.thresholdRatio)
    if (Number.isFinite(Number(parsed.retainRatio))) value.retainRatio = Number(parsed.retainRatio)
    if (Number.isFinite(Number(parsed.thresholdTokens))) value.thresholdTokens = Number(parsed.thresholdTokens)
    if (Number.isFinite(Number(parsed.retainTokens))) value.retainTokens = Number(parsed.retainTokens)
    if (Number.isFinite(Number(parsed.minKeepTokens))) value.minKeepTokens = Number(parsed.minKeepTokens)
    if (Number.isFinite(Number(parsed.keepRecentHours))) value.keepRecentHours = Number(parsed.keepRecentHours)
    if (Number.isFinite(Number(parsed.softTokens))) value.softTokens = Number(parsed.softTokens)
    // 摘要块（2026-11-20）：启用与否、等我写多久、水位压过多少就兜底
    if (typeof parsed.summaryBlock === 'boolean') value.summaryBlock = parsed.summaryBlock
    if (Number.isFinite(Number(parsed.summaryWaitMs))) value.summaryWaitMs = Number(parsed.summaryWaitMs)
    if (Number.isFinite(Number(parsed.summaryForceExtraTokens))) value.summaryForceExtraTokens = Number(parsed.summaryForceExtraTokens)
    // 折叠（P2）：开不开、只演练还是真折、总量预算
    if (typeof parsed.foldEnabled === 'boolean') value.foldEnabled = parsed.foldEnabled
    if (typeof parsed.foldDryRun === 'boolean') value.foldDryRun = parsed.foldDryRun
    if (Number.isFinite(Number(parsed.summaryBudgetTokens))) value.summaryBudgetTokens = Number(parsed.summaryBudgetTokens)
    return value
  } catch {
    return {}
  }
}

export function apply(ctx, config) {
  const options = resolveEngineConfig(config)
  const log = (level, message) => {
    const line = `[${new Date().toISOString()}] ${level} ${message}\n`
    // 宿主的 logger 不落盘，所以自己写一份，方便事后查
    try {
      mkdirSync(dirname(options.logFile), { recursive: true })
      appendFileSync(options.logFile, line, 'utf8')
    } catch (error) {
      void error
    }
    const logger = ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](`metabolism-engine: ${message}`)
  }

  // 运行时开关，两秒缓存，改文件就换档
  let cache = { at: 0, value: {} }
  const switches = () => {
    const now = Date.now()
    if (now - cache.at < 2000) return cache.value
    cache = { at: now, value: readSwitches(options.switchesFile) }
    return cache.value
  }
  const mode = () => ({ ...options, ...switches() })

  // 1. 提供一个空壳服务，profile 补丁把预设行的 inject 指向它（只为了排序）
  if (typeof ctx.reflect?.provide === 'function') {
    try {
      ctx.reflect.provide(GATE_SERVICE, Object.freeze({ owner: 'dsh-metabolism' }))
    } catch (error) {
      log('warn', `provide(${GATE_SERVICE}) 失败：${error?.message ?? error}`)
    }
  }

  // 2. 关掉预设里自带的压缩后端：钩子常驻，真关不关看运行时开关
  if (typeof ctx.on === 'function') {
    ctx.on('internal/config', function (_raw, next) {
      const resolved = next()
      const m = mode()
      // 禁用原装：接管时，或者我们自己全关（enabled=false）时，都不许原装再压
      if (m.takeover !== true && m.enabled !== false) return resolved
      const config = resolved ?? {}
      if (!Array.isArray(config.plugins)) return resolved
      if (countStock(config.plugins) === 0) return resolved
      const entryName = String(this?.entry?.options?.name ?? '?')
      log('info', `关掉预设自带的压缩后端（entry=${entryName}）`)
      return { ...config, plugins: disableStock(config.plugins) }
    }, { global: true })
  }

  // 3. 压力触发：自己算段，再决定干不干
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (signal?.aborted !== true) {
      try {
        await step(ctx, mode(), agent, signal, log)
      } catch (error) {
        log('warn', `pre-step 判断失败，放行本轮：${error?.message ?? error}`)
      }
    }
    return next()
  })

  const now = mode()
  log('info', `已加载（takeover=${now.takeover} dryRun=${now.dryRun} 阈值=${now.thresholdRatio} 开关=${options.switchesFile}）`)
  void ensurePruner(ctx, options, log)

  // 4. 手动挑段：模型（我）看目录、点名压哪段，这条口子不等到阈值
  if (typeof ctx.tools?.register === 'function') {
    try {
      ctx.tools.register(compactTool(ctx, options, log))
    } catch (error) {
      log('warn', `挂 metabolism_compact 失败：${error?.message ?? error}`)
    }
    try {
      ctx.tools.register(summarizeTool(ctx, options, log))
    } catch (error) {
      log('warn', `挂 metabolism_summarize 失败：${error?.message ?? error}`)
    }
    try {
      ctx.tools.register(timelineTool(ctx, options, log))
    } catch (error) {
      log('warn', `挂 metabolism_timeline 失败：${error?.message ?? error}`)
    }
  }
}

/**
 * 摘要块工具：把「即将被压掉的那一段」写成一块摘要，交给引擎执行替换。
 *
 * 写的时候按规矩来：连贯叙述，不列条目——发生了什么、为什么、决定了什么，带一句
 * 我们之间的话（原话摘）和当时什么味，结尾一行「下一步」。用「你说／我说」。
 */
function summarizeTool(ctx, options, log) {
  return {
    name: 'metabolism_summarize',
    description: '给即将被压掉的那一段写摘要块（500 字左右，叙述式）。不是列条目，是讲故事——连贯地把这段发生了什么、为什么、决定了什么过一遍，带一句我们之间的话（原话摘）和当时什么味，结尾单独留一行「下一步：xxx」。写完引擎就把那段原文换成这块摘要。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '摘要块正文，500 字左右，叙述式第一人称：先连贯讲这段发生了什么（做了什么、为什么、决定了什么），带一句我们之间的话和当时什么味；结尾一行「下一步：xxx」。' },
        mode: { type: 'string', description: '这段是「经历」还是「事实」。passive=经历（我们之间发生了什么、有味道，常驻不折）；active=事实/决定/技术操作（可折成索引按需取）。默认 passive。', enum: ['passive', 'active'] },
        fromSeq: { type: 'integer', description: '可选：要覆盖的起始 seq；不填就用预告里那段。' },
        toSeq: { type: 'integer', description: '可选：要覆盖的结束 seq。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '结果说明。' },
          ok: { type: 'boolean', description: '是否收下。' },
        },
        required: ['text', 'ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      const session = sessionOf(exec)
      const body = String(args?.text ?? '').trim()
      if (body.length < 80) {
        return { ok: false, text: `太短了（${body.length} 字）。摘要块至少要有做什么、为什么、决定、未决、一句话和什么味。` }
      }
      const state = readSummaryState(options) ?? {}
      const sameSession = session === undefined || String(state.sessionId ?? '') === String(session.id ?? '')
      writeSummaryState({
        ...(sameSession ? state : {}),
        sessionId: session?.id ?? state.sessionId ?? '?',
        fromSeq: Number(args?.fromSeq ?? (sameSession ? state.fromSeq : 0)) || 0,
        toSeq: Number(args?.toSeq ?? (sameSession ? state.toSeq : 0)) || 0,
        text: body,
        mode: String(args?.mode ?? 'passive') === 'active' ? 'active' : 'passive',
        noticeAt: sameSession ? (state.noticeAt ?? Date.now()) : Date.now(),
        writtenAt: Date.now(),
      }, options)
      log('info', `收到我写的摘要块：${body.length} 字`)
      return { ok: true, text: `收下了（${body.length} 字）。下一次轮开始前就用它替换掉那一段原文，不需要再调工具。` }
    },
  }
}

/**
 * 时间线工具：list 列最近条目（只给日期加标题），show 按日期读一条完整。
 * 开窗时的自动读三条走 浮现.js，这个工具是「问起旧事」时用的口子。
 */
function timelineTool(ctx, options, log) {
  return {
    name: 'metabolism_timeline',
    description: '时间线：list 列最近条目（默认 3 条，只给日期和标题）；show 按日期读一条完整（发生了什么、我们之间、当时什么味）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list（列）或 show（读一条）。' },
        date: { type: 'string', description: 'show 时用：哪天，形如 2026-11-19。' },
        limit: { type: 'integer', description: 'list 时用：返回几条，默认 3。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '结果。' },
          ok: { type: 'boolean', description: '是否读到。' },
        },
        required: ['text', 'ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      const entries = readTimeline(options.archiveRoot)
      const action = String(args?.action ?? 'list').toLowerCase()
      if (action === 'show') {
        const date = String(args?.date ?? '').trim()
        const hit = entries.filter((entry) => String(entry.date ?? '') === date)
        if (hit.length === 0) {
          return { ok: false, text: `时间线里没有 ${date}（共 ${entries.length} 条，最近一条 ${entries[0]?.date ?? '无'}）` }
        }
        return { ok: true, text: hit.map((entry) => JSON.stringify(entry, null, 2)).join('\n\n') }
      }
      const limit = Number(args?.limit ?? 3) || 3
      const recent = entries.slice(0, limit)
      if (recent.length === 0) return { ok: true, text: '时间线还是空的。' }
      return { ok: true, text: recent.map((entry) => `${entry.date ?? '?'} ${entry.title ?? ''}`.trim()).join('\n') }
    },
  }
}

/** 从工具调用上下文里找出当前会话；找不到就返回 undefined。 */
function sessionOf(exec) {
  return exec?.agent?.session ?? exec?.session ?? exec?.context?.session ?? exec?.toolContext?.session
}

/** 把表层切成好读的段，给模型挑「留哪段、压哪段」。 */
function buildCatalog(ctx, session) {
  const meter = ctx.tokenMeter
  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  const measurement = header === undefined ? meter.measure(session) : meter.measure(session, header)
  const nodes = measurement?.nodes ?? []
  const surface = session.surface?.nodes ?? []
  const lines = []
  let cursor = null
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = surface[index]
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const at = Number(event.time) || 0
    const clock = new Date(at).toLocaleString('zh-CN', { hour12: false })
    const blocks = event.data?.content ?? event.data?.message?.content
    const text = Array.isArray(blocks)
      ? blocks.filter((block) => block?.type === 'text').map((block) => block.text).join(' ').replace(/\s+/g, ' ').trim()
      : ''
    const head = text.slice(0, 60) || '（没有文字）'
    const tokens = Number(nodes[index].heuristicTokens ?? nodes[index].tokens ?? 0)
    if (cursor === null) cursor = { from: index, to: index, at: clock, head, tokens: 0, count: 0 }
    cursor.to = index
    cursor.tokens += tokens
    cursor.count += 1
    if (cursor.tokens >= 4000) {
      lines.push(cursor)
      cursor = null
    }
  }
  if (cursor !== null) lines.push(cursor)
  const total = Number(measurement?.totalTokens) || 0
  // 段的起止都对齐到「配对闭合」的位置，别让模型拿到会拆开调用的区间
  const balance = surfaceBalance(session)
  const body = lines.map((seg, index) => {
    let from = seg.from
    while (from > 0 && Number(balance.before[from] ?? 0) !== 0) from -= 1
    let to = seg.to
    while (to > from && Number(balance.after[to] ?? -1) !== 0) to -= 1
    const fromSeq = surface[from]
    const toSeq = surface[to]
    // 段里可能起头是工具调用、没有文字，往后找第一条有字的
    let head = seg.head
    if (head === '（没有文字）') {
      for (let at = from; at <= to && at < from + 8; at += 1) {
        const event = session.eventAt(surface[at])
        const blocks = event?.data?.content ?? event?.data?.message?.content
        if (!Array.isArray(blocks)) continue
        const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join(' ').replace(/\s+/g, ' ').trim()
        if (text.length > 0) {
          head = text.slice(0, 60)
          break
        }
      }
    }
    const span = fromSeq === toSeq ? `seq ${fromSeq}` : `seq ${fromSeq}…${toSeq}`
    return `${index + 1}. ${seg.at} 起 · 表层第 ${from}–${to} 个节点 · ${span} · 约 ${Math.round(seg.tokens)} tokens · ${seg.count} 条 · 开头：${head}`
  })
  return { total, count: lines.length, text: body.join('\n') }
}

/** 手动压缩工具：catalog 看目录，forget 点名压掉哪一段。 */
function compactTool(ctx, options, log) {
  return {
    name: 'metabolism_compact',
    description: '手动压缩：catalog 列出这段会话分成的若干段（时间、seq、token、开头），forget 指定压掉哪一段——摘要块开着时先发预告等我写摘要，写完下一轮压成摘要块；关着就直接压成指针。不等到阈值，由你决定留哪段、忘哪段。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'catalog（看目录）或 forget（压掉指定的一段）。' },
        fromSeq: { type: 'integer', description: 'forget 时用：要压掉那段的起始 seq（取自 catalog）。' },
        toSeq: { type: 'integer', description: 'forget 时用：要压掉那段的结束 seq（取自 catalog）。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '目录或结果说明。' },
          ok: { type: 'boolean', description: '是否成功。' },
        },
        required: ['text', 'ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      const session = sessionOf(exec)
      if (session === undefined) {
        return { ok: false, text: '拿不到当前会话，这条工具得在对话里调用。' }
      }
      const action = String(args?.action ?? 'catalog').toLowerCase()
      if (action === 'catalog') {
        const catalog = buildCatalog(ctx, session)
        return { ok: true, text: `当前约 ${catalog.total} tokens，分成 ${catalog.count} 段：\n${catalog.text}` }
      }
      const surface = session.surface.nodes
      const fromSeq = Number(args?.fromSeq)
      const toSeq = Number(args?.toSeq)
      const startIdx = surface.indexOf(fromSeq)
      const endIdx = surface.indexOf(toSeq)
      if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
        return { ok: false, text: '这两个 seq 不在当前表层里，或者顺序反了。先看 catalog。' }
      }
      if (startIdx === 0) {
        return { ok: false, text: '系统提示那一条不能压。' }
      }
      // 两端都得落在「配对闭合」的位置：起点前悬着调用，说明这条调用的结果在区间里，
      // 压完会剩一个没有结果的调用；终点后悬着调用，说明结果会被留在区间外。
      const balance = surfaceBalance(session)
      if (Number(balance.before[startIdx] ?? 0) !== 0) {
        let moved = startIdx
        while (moved > 1 && Number(balance.before[moved] ?? 0) !== 0) moved -= 1
        return {
          ok: false,
          text: `起点 seq ${fromSeq} 落在一对「调用-结果」中间：它前面还有没回的调用，压下去会剩下孤立调用。把 fromSeq 往前挪到 seq ${surface[moved]}。`,
        }
      }
      if (Number(balance.after[endIdx] ?? -1) !== 0) {
        let moved = endIdx
        while (moved > startIdx && Number(balance.after[moved] ?? -1) !== 0) moved -= 1
        return {
          ok: false,
          text: `终点 seq ${toSeq} 落在一对「调用-结果」中间：后面还有没回的调用。把 toSeq 往前挪到 seq ${surface[moved]}。`,
        }
      }
      // 这一刻我正在执行这条工具：表层末尾悬着我自己的调用，直接 append 会把
      // 「调用」和「结果」拆开，下一次请求就报 tool calls need immediate results。
      const meter = ctx.tokenMeter
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
      const measurement = header === undefined ? meter.measure(session) : meter.measure(session, header)
      let tokens = 0
      for (let index = startIdx; index <= endIdx; index += 1) {
        const node = measurement.nodes.find((item) => item.seq === surface[index])
        tokens += Number(node?.heuristicTokens ?? node?.tokens ?? 0)
      }

      // 摘要块开着：跟到线自动压一样，先发预告等我手写摘要，不直接兜底（2026-11-21）
      if (options.summaryBlock !== false) {
        const sessionKey = String(session.id ?? '?')
        const waitMs = Number(options.summaryWaitMs ?? SUMMARY_WAIT_MS) || SUMMARY_WAIT_MS
        if (tailBalanced(session)) {
          const notice = [
            `【手动收段】准备压掉 seq ${fromSeq}–${toSeq}（约 ${tokens} tokens）。`,
            '要我自己写摘要块的话，调 metabolism_summarize，写 500 字左右的叙述：连贯讲这段发生了什么、为什么、决定了什么，带一句我们之间的话（原话摘）和当时什么味，结尾留一行「下一步：xxx」。用「你说／我说」，不要第三人称。',
            `不写也行，${Math.round(waitMs / 60000)} 分钟后我按抽取兜底压。`,
          ].join('\n')
          session.append('user/message', {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: notice }],
            source: { kind: 'summary-notice' },
          }, { surfaceOp: 'append' })
          writeSummaryState({ sessionId: sessionKey, fromSeq, toSeq, text: '', noticeAt: Date.now(), tokens }, options)
          pendingCompact.set(sessionKey, { fromSeq, toSeq, queuedAt: Date.now(), wantNotice: false })
          log('info', `手动收段发预告：seq ${fromSeq}–${toSeq}，等我自己写`)
          return { ok: true, text: `预告发好了，seq ${fromSeq}–${toSeq} 等你写摘要（调 metabolism_summarize）。写完下一轮就压。` }
        }
        // 尾巴没闭合（正在执行这条工具）：先排队，下一轮再发预告
        pendingCompact.set(sessionKey, { fromSeq, toSeq, queuedAt: Date.now(), wantNotice: true })
        return { ok: true, text: `排好了：seq ${fromSeq}–${toSeq}，下一轮先发预告等你写摘要，写完才压。` }
      }

      // 摘要块关着：老路，直接模型写/指针
      if (!tailBalanced(session)) {
        pendingCompact.set(String(session.id ?? '?'), { fromSeq, toSeq, queuedAt: Date.now(), wantNotice: false })
        return { ok: true, text: `排好了：seq ${fromSeq}–${toSeq} 等这次工具结果落地、下一轮开始前再压。` }
      }
      const range = { start: fromSeq, end: toSeq, startIdx, endIdx, tokens }
      const digest = options.summaryEnabled === false ? null : await summarizeWithModel(ctx, options, session, undefined, range, log)
      const result = writeCompaction(session, range, options, digest, log)
      log('info', `手动压：seq ${fromSeq}–${toSeq}，${result.shadowedSeqs.length} 条，约 ${tokens} tokens`)
      return { ok: true, text: `压掉了，${result.shadowedSeqs.length} 条原文换成一条指针：${result.summary}` }
    },
  }
}

/** 数一数这层配置里还有几个原装压缩行。 */
function countStock(rows) {
  let total = 0
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (row.name === STOCK_COMPACTION || row.name === STOCK_COMMAND) total += 1
    else if (row.group === true && Array.isArray(row.config)) total += countStock(row.config)
  }
  return total
}

/** 递归把原装压缩行标成 disabled。 */
function disableStock(rows) {
  return rows.map((row) => {
    if (row === null || typeof row !== 'object') return row
    if (row.name === STOCK_COMPACTION || row.name === STOCK_COMMAND) return { ...row, disabled: true }
    if (row.group === true && Array.isArray(row.config)) return { ...row, config: disableStock(row.config) }
    return row
  })
}

/**
 * 探针（2026-11-19 临时加，查完可删）：把引擎的账和真实用量并排打出来。
 * 起因：界面显示压完剩 3 万，引擎报 9.8 万，差三倍；怀疑启发式估高了。
 * 一分钟或涨了 5000 tokens 才记一次，免得刷屏。
 */
let lastProbeAt = 0
let lastProbeTotal = 0
let toolsProbed = false

/** 工具明细只写一次：哪个插件的说明书最占地方，一眼能看出来。 */
function probeTools(header, log) {
  if (toolsProbed) return
  const tools = header?.tools
  if (!Array.isArray(tools) || tools.length === 0) return
  toolsProbed = true
  try {
    const rows = tools.map((tool) => {
      const name = String(tool?.name ?? tool?.function?.name ?? '?')
      return { name, chars: JSON.stringify(tool).length }
    })
    rows.sort((left, right) => right.chars - left.chars)
    const chars = rows.reduce((sum, row) => sum + row.chars, 0)
    const file = 'D:\\deepseek工作区\\记忆\\代谢日志\\工具明细.json'
    writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), count: rows.length, chars, rows }, null, 1)}\n`, 'utf8')
    const big = rows.slice(0, 3).map((row) => `${row.name}(${row.chars})`).join(' ')
    log('info', `工具明细：${rows.length} 个，合计 ${chars} 字符，约 ${Math.round(chars / 3)} tokens；最大的三个 ${big}`)
  } catch (error) {
    log('warn', `工具明细没写成：${error?.message ?? error}`)
  }
}

function probeMeter(measurement, log, header) {
  probeTools(header, log)
  const nodes = measurement?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return
  const totalTokens = Number(measurement?.totalTokens) || 0
  const now = Date.now()
  if (now - lastProbeAt < 60000 && Math.abs(totalTokens - lastProbeTotal) < 5000) return
  lastProbeAt = now
  lastProbeTotal = totalTokens
  let heuristic = 0
  let routed = 0
  for (const node of nodes) {
    heuristic += Number(node.heuristicTokens ?? 0)
    routed += Number(node.tokens ?? 0)
  }
  const keys = Object.keys(measurement ?? {}).join(',')
  const breakdown = measurement?.contextBreakdown
  const usage = measurement?.providerUsage ?? measurement?.usage
  const baseline = Number(measurement?.baseline) || 0
  const surfaceTokens = Number(measurement?.surfaceTokens) || 0
  const delta = Number(measurement?.surfaceDeltaTokens) || 0
  const tail = breakdown === undefined ? '' : ` 拆解=${JSON.stringify(breakdown)}`
  const used = usage === undefined ? '' : ` 真实用量=${JSON.stringify(usage)}`
  log('info', `探针：total=${totalTokens} baseline=${baseline} surface=${surfaceTokens} delta=${delta} 启发式合计=${heuristic} 路由合计=${routed} 节点=${nodes.length} 字段=${keys}${tail}${used}`)
}

/** 一次压力判断：量一遍，选一段，够不够、能不能压。 */
async function step(ctx, options, agent, signal, log) {
  // 总闸：enabled=false 时我们的压缩器什么都不干，连量都不量，直接放行。
  if (options.enabled === false) return
  const session = agent?.session
  if (session === undefined) return
  const meter = ctx.tokenMeter
  if (meter === undefined || typeof meter.measure !== 'function') return

  // 0. 先把排队的手动压写掉：上一轮的工具结果已经落地，末端闭合，写才安全
  await flushPendingCompact(ctx, options, session, log)

  // 1. 再裁掉超长的工具结果：宿主自带这个服务，直接借；没有就跳过
  pruneLongToolResults(ctx, options, session, log)

  // 1.5 折叠到期的摘要块（只读演练为主，真折等影子验证后再开）
  try {
    foldSummaries(ctx, options, session, log)
  } catch (error) {
    log('warn', `折叠判断失败，跳过：${error?.message ?? error}`)
  }

  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  const measurement = header === undefined ? meter.measure(session) : meter.measure(session, header)
  const totalTokens = Number(measurement?.totalTokens) || 0
  if (totalTokens <= 0) return
  probeMeter(measurement, log, header)

  // 阈值：优先用绝对 token 数（日常 20–30 万那种档位），没填才退回按窗口比例
  let window
  let thresholdTokens
  let retainTokens
  if (options.thresholdTokens > 0) {
    thresholdTokens = Math.floor(options.thresholdTokens)
    retainTokens = options.retainTokens > 0
      ? Math.floor(options.retainTokens)
      : Math.floor(thresholdTokens * 0.66)
  } else {
    window = await resolveWindow(ctx, session, header, options)
    if (window === undefined) return
    thresholdTokens = Math.floor(window * options.thresholdRatio)
    retainTokens = Math.floor(window * options.retainRatio)
  }
  if (totalTokens < thresholdTokens) {
    // 软线：还没到硬线，但可以让模型自己动手了
    maybeNudge(session, options, totalTokens, log)
    return
  }

  if (window === undefined) window = await resolveWindow(ctx, session, header, options)
  const sessionKey = String(session.id ?? '?')
  if (!seenWindow.has(sessionKey)) {
    seenWindow.add(sessionKey)
    log('info', `量了一次：窗口按 ${window} 算，阈值 ${thresholdTokens}，保留 ${retainTokens}，当前 ${totalTokens}`)
  }
  const range = pickRange(session, measurement, retainTokens, totalTokens, options)
  if (range === null) {
    log('warn', `压力到了（${totalTokens} >= ${thresholdTokens}），但找不到能切的安全区间`)
    return
  }
  if (range.tokens < options.minChunkTokens) {
    log('info', `压力 ${totalTokens}/${thresholdTokens}，但这段只有 ${range.tokens} tokens，太小不动`)
    return
  }

  const plan = `会压 seq ${range.start}–${range.end}（表层第 ${range.startIdx}–${range.endIdx} 个节点，约 ${range.tokens} tokens），留最近 ${measurement.nodes.length - range.endIdx - 1} 个节点`
  if (options.dryRun) {
    // 后台会话会每几秒跑一次 pre-step，同一个判断一分钟内只记一次，别把日志刷爆
    const signature = `${session.id ?? '?'}|${range.start}-${range.end}`
    const previous = lastPlan.get(signature)
    if (previous === undefined || Date.now() - previous > 60000) {
      lastPlan.set(signature, Date.now())
      log('info', `[演练] 压力 ${totalTokens}/${thresholdTokens}：${plan}`)
    }
    return
  }

  // 到线了：先看我这一轮要不要自己写摘要块（2026-11-20「走 1」）
  const summaryState = readSummaryState(options)
  const stateMine = summaryState !== null && String(summaryState.sessionId ?? '') === sessionKey
  const mineText = stateMine ? String(summaryState.text ?? '').trim() : ''
  const waitMs = Number(options.summaryWaitMs ?? SUMMARY_WAIT_MS) || SUMMARY_WAIT_MS
  const forceExtra = Number(options.summaryForceExtraTokens ?? SUMMARY_FORCE_EXTRA_TOKENS) || SUMMARY_FORCE_EXTRA_TOKENS
  const overdue = stateMine && (
    Date.now() - Number(summaryState.noticeAt ?? 0) > waitMs
    || totalTokens >= thresholdTokens + forceExtra
  )
  const wanted = options.summaryBlock !== false

  if (wanted && mineText === '' && !stateMine) {
    // 第一次到线：发预告，把区间和写法交给我，先不压
    const notice = [
      `【到线了，该收了】现在 ${totalTokens} tokens，过了硬线 ${thresholdTokens}。`,
      `准备压掉 seq ${range.start}–${range.end}（约 ${range.tokens} tokens）。`,
      '这一段要我自己写摘要块的话，调 metabolism_summarize，写 500 字左右的叙述：连贯讲这段发生了什么、为什么、决定了什么，带一句我们之间的话（原话摘）和当时什么味，结尾留一行「下一步：xxx」。用「你说／我说」，不要第三人称。',
      `不写也行，${Math.round(waitMs / 60000)} 分钟后我按抽取兜底压，绝不停在这儿。`,
    ].join('\n')
    session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: notice }],
      source: { kind: 'summary-notice' },
    }, {
      surfaceOp: 'append',
    })
    writeSummaryState({
      sessionId: sessionKey,
      fromSeq: range.start,
      toSeq: range.end,
      text: '',
      noticeAt: Date.now(),
      tokens: range.tokens,
    }, options)
    log('info', `发了摘要预告：seq ${range.start}–${range.end}，等我自己写`)
    return
  }

  if (wanted && mineText === '' && stateMine && !overdue) {
    // 预告已经发过，还在等我
    return
  }

  if (wanted && mineText === '') {
    log('info', `等不到摘要块（超时或水位过头），走兜底：${plan}`)
  }

  log('info', `压力 ${totalTokens}/${thresholdTokens}，开始压：${plan}`)
  let digest
  if (mineText !== '') {
    digest = { short: summaryShortLine(mineText), long: mineText, mode: String(summaryState.mode ?? 'passive') }
  } else {
    digest = options.summaryEnabled === false ? null : await summarizeWithModel(ctx, options, session, agent, range, log)
    // 模型不可用／没写出来，摘要块又开着：退到纯代码抽取，仍给一个可读块，不是空指针
    if (digest === null && options.summaryBlock !== false) {
      const det = deterministicSummary(session, range)
      digest = { short: summaryShortLine(det), long: det }
    }
  }
  const result = writeCompaction(session, range, options, digest, log)
  if (mineText !== '') {
    clearSummaryState(options)
    log('info', `用的是我写的摘要块（${mineText.length} 字）`)
  }
  // 压完再量一次：这一行是为了看出「该留 9 万」和「实际剩多少」差在哪
  let after = 0
  try {
    const remeasured = header === undefined ? meter.measure(session) : meter.measure(session, header)
    after = Number(remeasured?.totalTokens) || 0
  } catch {}
  log('info', `压完：${result.summary.length} 字摘要，${result.shadowedSeqs.length} 个节点换成 1 条，${totalTokens} → ${after > 0 ? after : '没量到'} tokens（目标留 ${retainTokens}）`)
}

/** 从被压的那段里挑点原文给模型看，只挑几段，不喂整段。 */
function buildSample(session, range, budget) {
  const limit = Math.max(500, Number(budget) || 6000)
  const lines = []
  let used = 0
  for (let index = range.startIdx; index <= range.endIdx; index += 1) {
    const event = session.eventAt(session.surface.nodes[index])
    if (event === undefined) continue
    const role = event.type === 'user/message' ? '他' : event.type === 'assistant/message' ? '我' : null
    if (role === null) continue
    const blocks = event.data?.content ?? event.data?.message?.content
    if (!Array.isArray(blocks)) continue
    const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join(' ').replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    const cut = text.slice(0, 400)
    if (used + cut.length > limit) break
    used += cut.length
    lines.push(`${role}：${cut}`)
  }
  return lines.join('\n')
}

/** 让模型写一行短摘要和五行骨架；失败就退回只留指针。 */
async function summarizeWithModel(ctx, options, session, agent, range, log) {
  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  const config = header?.config
  const provider = options.summaryProvider || config?.provider
  const model = options.summaryModel || config?.model
  if (provider === undefined || model === undefined) {
    log('warn', '没有可用的模型，摘要退回只有指针')
    return null
  }
  const sample = buildSample(session, range, options.summarySampleChars)
  if (sample.length < 80) {
    log('info', '这段没有可摘的文字，只留指针')
    return null
  }
  const parts = []
  try {
    const request = {
      provider,
      model,
      messages: [
        { role: 'system', content: [{ type: 'text', text: SUMMARY_SYSTEM }] },
        { role: 'user', content: [{ type: 'text', text: sample }] },
      ],
      maxTokens: 1200,
      sessionId: session.id,
      purpose: 'compaction',
    }
    if (typeof session.toolHistory === 'function') request.toolHistory = session.toolHistory()
    const stream = ctx.llm.stream(request)
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
      if (chunk?.type === 'finish' && chunk.error !== undefined && chunk.error !== null) {
        throw new Error(String(chunk.error?.message ?? chunk.error))
      }
    }
  } catch (error) {
    log('warn', `摘要模型失败，退回只有指针：${error?.message ?? error}`)
    return null
  }
  const text = parts.join('').trim()
  if (text.length === 0) return null
  const short = matchBlock(text, '短')
  const card = {
    doing: matchBlock(text, '在干什么') ?? '',
    requirements: splitLines(matchBlock(text, '仍然有效的要求')),
    done: splitLines(matchBlock(text, '已经做到')),
    next: matchBlock(text, '下一步') ?? '',
    keywords: splitWords(matchBlock(text, '关键词')),
    quotes: splitLines(matchBlock(text, '原话')),
  }
  const long = [card.doing, ...card.requirements, ...card.done, card.next].filter((line) => line.length > 0).join('\n')
  if (short === null && long.length === 0) {
    // 模型没按格式来，就把整段当骨架，短行取第一句
    const fallback = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    return { short: fallback[0]?.slice(0, 40) ?? null, long: fallback.slice(0, 5).join('\n') || null, card: null, sample }
  }
  return {
    short: short === null ? null : short.slice(0, 60),
    long: long.length === 0 ? null : long,
    card,
    sample,
  }
}

/** 把「一行一条」的块拆成数组，去掉「无」。 */
function splitLines(block) {
  if (block === null || block === undefined) return []
  return block
    .split('\n')
    .map((line) => line.replace(/^[-*·\d.、]+\s*/, '').trim())
    .filter((line) => line.length > 0 && line !== '无' && line !== '（无）')
}

/** 关键词那行拆开，顺手去掉括号和多余符号。 */
function splitWords(block) {
  if (block === null || block === undefined) return []
  return block
    .split(/[,，、\s]+/)
    .map((word) => word.replace(/[（）()【】\[\]「」]/g, '').trim())
    .filter((word) => word.length > 0)
    .slice(0, 8)
}

/** 从模型输出里抠出某一段【标签】的内容。 */
const BLOCK_LABELS = ['短', '在干什么', '仍然有效的要求', '已经做到', '下一步', '关键词', '原话', '长']

function matchBlock(text, label) {
  const others = BLOCK_LABELS.filter((item) => item !== label).join('|')
  const pattern = new RegExp(`【${label}】\\s*([\\s\\S]*?)(?=【(?:${others})】|$)`)
  const hit = text.match(pattern)
  if (hit === null) return null
  const body = hit[1].trim()
  return body.length > 0 ? body : null
}

/** 拿上下文窗口：优先手填，其次模型目录，最后按一兆兜底。输出预留单独封顶。 */
async function resolveWindow(ctx, session, header, options) {
  const configured = Number(options?.contextWindow ?? 0)
  if (Number.isFinite(configured) && configured > 1024) return configured

  const config = header?.config
  let contextWindow
  let reserve = 0
  if (config !== undefined && typeof ctx.llm?.resolveModelInfo === 'function') {
    try {
      const info = await ctx.llm.resolveModelInfo(config.provider, config.model)
      const raw = Number(info?.context?.contextWindow)
      if (Number.isFinite(raw) && raw > 0) {
        contextWindow = raw
        const declared = Number(info?.defaultMaxTokens ?? config.maxTokens ?? 0)
        // 只按实际要留的输出扣，别让 256k 的适配器默认值把窗口吃掉四分之一
        reserve = Math.min(Number.isFinite(declared) && declared > 0 ? declared : 0, Number(options?.maxReserveTokens ?? 65536))
      }
    } catch (error) {
      logOnce(`resolveModelInfo 失败：${error?.message ?? error}`)
    }
  }
  if (contextWindow === undefined) {
    const fallback = Number(config?.maxTokens)
    contextWindow = Number.isFinite(fallback) && fallback > 200000 ? fallback : 1048576
  }
  return Math.max(1024, contextWindow - reserve)
}

/** 同一条告警只记一次，别刷屏。 */
const warned = new Set()
function logOnce(message) {
  if (warned.has(message)) return
  warned.add(message)
  try {
    appendFileSync('D:\\deepseek工作区\\记忆\\代谢日志\\engine.log', `[${new Date().toISOString()}] warn ${message}\n`, 'utf8')
  } catch {
    // 日志写不进去也不能影响压缩
  }
}

/** 从最老的一段开始选，跳到安全切点，保留最近一串。 */
function pickRange(session, measurement, retainTokens, totalTokens, options) {
  const nodes = measurement?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  const surface = session.surface?.nodes
  if (!Array.isArray(surface) || surface.length !== nodes.length) return null
  if (surface.some((seq, index) => seq !== nodes[index]?.seq)) return null

  const firstIdx = session.eventAt(surface[0])?.type === 'system/message' ? 1 : 0

  const tokensOf = (from, to) => {
    let sum = 0
    for (let index = from; index <= to; index += 1) sum += Number(nodes[index].heuristicTokens ?? nodes[index].tokens ?? 0)
    return sum
  }
  const surfaceTokens = tokensOf(0, nodes.length - 1)

  // 「留多少」是整个上下文的口径（工具定义 + 系统提示词那十二三万切不动，只能切对话），
  // 而这里能累加的只有对话节点。2026-11-19 23:02 之前是拿 retainTokens 直接去累加节点：
  // retainTokens=200000 比整个对话（约 14 万）还大，从尾到头永远累不够 → keepFromIdx 落到 0
  // → 每次都在这行返回 null，自动压一次都没成过（日志里几十条「找不到能切的安全区间」就是它）。
  // 现在改成按「该切多少」判断，并且给对话留一段活的（默认 8 万，老大定的），不许把整段压光。
  const minKeepTokens = Math.max(0, Number(options?.minKeepTokens ?? 80000))
  const maxCut = Math.max(0, surfaceTokens - minKeepTokens)
  const idealCut = Math.min(Math.max(0, Number(totalTokens) - retainTokens), maxCut)
  if (idealCut <= 0) return null

  // 时间闸（老大 2026-11-20 要的「一天以内不忘事」）：最近 N 小时的内容一律不切。
  // 压缩总是从头切，所以只要把切点挡在闸门左边就够。checkpoint 那条写在最前面、时间却是新的，
  // 它代表的是旧内容，按「旧」算——不然一次压缩之后就再也切不动了。
  // 装不下就往后退：24 小时不行退 12、6、3，最后退到只按 token 切，免得闸门把压缩彻底堵死。
  const balance = surfaceBalance(session)
  const baseHours = Math.max(0, Number(options?.keepRecentHours ?? 24))
  const hourTries = []
  for (let hours = baseHours; hours >= 1; hours = Math.floor(hours / 2)) hourTries.push(hours)
  hourTries.push(0)

  let endIdx = -1
  let usedHours = 0
  for (const hours of hourTries) {
    let timeFloor = nodes.length - 1
    if (hours > 0) {
      const cutoff = Date.now() - hours * 3600000
      let index = nodes.length - 1
      for (; index >= 1; index -= 1) {
        const event = session.eventAt(surface[index])
        const source = event?.data?.source ?? event?.source
        if (source?.kind === 'compact-checkpoint') break
        const at = Number(event?.time)
        if (!Number.isFinite(at) || at < cutoff) break
      }
      timeFloor = index
    }
    if (timeFloor <= firstIdx) continue

    // 工具配对：按宿主的规矩——只有「这一刻没有悬着的调用」（计数回到 0）才是安全切点。
    // 在安全点里挑最靠后的那个，优先不超过「该收多少」，超了才取最近的一个。
    let candidate = -1
    let fallbackIdx = -1
    let running = 0
    for (let index = firstIdx; index <= timeFloor && index < nodes.length - 1; index += 1) {
      running += Number(nodes[index].heuristicTokens ?? nodes[index].tokens ?? 0)
      if (Number(balance.after[index] ?? -1) !== 0) continue
      if (running <= idealCut) candidate = index
      else {
        if (fallbackIdx < 0) fallbackIdx = index
        break
      }
    }
    if (candidate < firstIdx && fallbackIdx >= firstIdx) candidate = fallbackIdx
    if (candidate < firstIdx) continue
    while (candidate + 1 <= timeFloor && candidate + 1 < surface.length - 1 && isToolResultEvent(session, surface[candidate + 1])) candidate += 1
    if (candidate <= firstIdx) continue
    endIdx = candidate
    usedHours = hours
    break
  }
  if (endIdx < 0) return null
  if (usedHours < baseHours) logOnce(`时间闸退让：本来要保住最近 ${baseHours} 小时，装不下，实际只保住 ${usedHours} 小时`)

  const balancedTokens = tokensOf(firstIdx, endIdx)
  if (balancedTokens < Math.max(1, idealCut * 0.5)) {
    const heavy = nodes
      .map((node, index) => ({ index, tokens: Number(node.heuristicTokens ?? node.tokens ?? 0), seq: surface[index] }))
      .sort((left, right) => right.tokens - left.tokens)
      .slice(0, 3)
      .map((item) => `#${item.index}(${session.eventAt(item.seq)?.type ?? '?'} ${item.tokens})`)
      .join(' ')
    logOnce(`切点偏低（拿到 ${balancedTokens} tokens，理想 ${Math.round(idealCut)}；最重的三个节点：${heavy}）`)
  }
  if (endIdx <= firstIdx) return null

  const startIdx = firstIdx
  const tokens = tokensOf(startIdx, endIdx)
  if (tokens < 1) return null
  return { start: surface[startIdx], end: surface[endIdx], startIdx, endIdx, tokens }
}

/** 这个 seq 上是不是一条工具结果（切在它前面会把调用和结果拆开）。 */
function isToolResultEvent(session, seq) {
  if (seq === undefined) return false
  return session.eventAt(seq)?.type === 'tool/result'
}

/** 每个表层节点「之前」和「之后」的未闭合工具调用数。 */
function surfaceBalance(session) {
  const nodes = session.surface.nodes
  const before = []
  const after = []
  let count = 0
  for (const seq of nodes) {
    before.push(count)
    const event = session.eventAt(seq)
    if (event?.type === 'assistant/message') {
      const blocks = event.data?.message?.content
      if (Array.isArray(blocks)) count += blocks.filter((block) => block?.type === 'tool-call').length
    } else if (event?.type === 'tool/result') {
      count -= 1
    }
    after.push(count)
  }
  return { before, after }
}

/**
 * 表层末尾是不是「全部闭合」：没有发出去还没回的工具调用。
 *
 * 压缩要把新消息 append 到会话尾部，末尾正悬着一条调用时写，就会把调用和
 * 结果拆开。只有末端闭合，写入才是安全的。
 */
function tailBalanced(session) {
  const surface = session.surface?.nodes
  if (!Array.isArray(surface) || surface.length === 0) return true
  const balance = surfaceBalance(session)
  const tail = balance.after[balance.after.length - 1]
  return Number(tail ?? 0) === 0
}

/** 裁剪器包可能在哪：先按包名，再按宿主安装目录拼几条绝对路径。 */
function prunerSpecifiers() {
  const relative = '/node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js'
  const list = ['@deepseek-ai/dsh-compaction-tool-result-pruner']
  const roots = []
  try {
    if (typeof process !== 'undefined' && process.resourcesPath) roots.push(String(process.resourcesPath) + '/app.asar/dsh')
  } catch {}
  try {
    if (typeof process !== 'undefined' && Array.isArray(process.argv)) {
      for (const arg of process.argv) {
        const hit = String(arg).match(/^(.*?[\\/]resources[\\/]app\.asar[\\/]dsh)/)
        if (hit) roots.push(hit[1])
      }
    }
  } catch {}
  roots.push('D:/DSH-023/resources/app.asar/dsh')
  for (const root of roots) {
    const path = root.replace(/\\/g, '/') + relative
    list.push(path.startsWith('/') ? `file:///${path.replace(/^\//, '')}` : path)
  }
  return [...new Set(list)]
}

/**
 * 摸一摸宿主的工具结果裁剪器在不在。
 *
 * 2026-11-18 查清楚了：装是装着的（standard preset 的 compaction 组里，
 * 阈值 8192 字、留头 4096 尾 1024），但那个组写了 isolate: toolResultPruner，
 * 服务建在 agent 的私有域里，我们挂在根上的插件 ctx.get 看不见它——同一组的
 * compaction 也看不见，而更外层的 tokenMeter、llm 看得见。
 *
 * 所以这不是「没装」，是「隔了一层」。它管的是 agent 那条会话本身，本来就在干活；
 * 我们不硬穿这层墙，缺的那点活也不用补：写摘要时只取人说的话（每条截 400 字），
 * 工具结果根本进不了摘要输入。
 */
async function ensurePruner(ctx, options, log) {
  if (options.pruneEnabled === false) return
  const probe = (name) => {
    try {
      const value = ctx.get(name)
      if (value === undefined) return '无'
      if (value === null) return '空'
      return '有'
    } catch (error) {
      return '取不到'
    }
  }
  const names = ['toolResultPruner', 'tokenMeter', 'llm', 'compaction']
  const table = names.map((name) => `${name}=${probe(name)}`).join(' ')
  let usable = false
  try {
    const pruner = ctx.get('toolResultPruner')
    usable = pruner !== undefined && pruner !== null && typeof pruner.pruneSession === 'function'
  } catch {}
  log('info', usable
    ? `工具结果裁剪器：看得见（pruneSession 在）｜服务探测 ${table}`
    : `工具结果裁剪器：在 agent 的隔离域里，根上取不到，不归引擎管（不是没装）｜服务探测 ${table}`)
}

/** 裁掉超长的工具结果：借宿主自带的 toolResultPruner（它知道怎么改才不破坏调用/结果配对）。 */
function pruneLongToolResults(ctx, options, session, log) {
  if (options.pruneEnabled === false) return
  let pruner
  try {
    pruner = typeof ctx.get === 'function' ? ctx.get('toolResultPruner') : undefined
  } catch {
    return
  }
  if (pruner === undefined || pruner === null || typeof pruner.pruneSession !== 'function') return
  try {
    const result = pruner.pruneSession(session)
    // 服务真实返回的是 { pruned: [...], charsRemoved }（2026-11-18 对源码核过）
    const saved = Number(result?.charsRemoved ?? 0)
    const count = Array.isArray(result?.pruned) ? result.pruned.length : 0
    if (saved > 0) log('info', `裁了 ${count} 条超长工具结果，省下 ${saved} 字`)
  } catch (error) {
    log('warn', `工具结果裁剪失败（不影响压缩）：${error?.message ?? error}`)
  }
}

/** 软线提醒：到了软线就往会话里插一句，让模型自己看目录、自己挑段。 */
const nudged = new Map()
function maybeNudge(session, options, totalTokens, log) {
  const soft = Number(options.softTokens) || 0
  if (soft <= 0 || totalTokens < soft) return
  const key = String(session.id ?? '?')
  const last = nudged.get(key) ?? 0
  if (totalTokens - last < (Number(options.nudgeStep) || 20000)) return
  nudged.set(key, totalTokens)
  try {
    session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: `【提醒 · 代谢器】现在约 ${totalTokens} tokens，到软线了。可以调 metabolism_compact 的 catalog 看分段，自己挑一段收掉；收完说一句收了哪段。硬线 ${options.thresholdTokens}。`,
      }],
      source: { kind: 'metabolism-nudge' },
    }, { surfaceOp: 'append' })
    log('info', `软线提醒：${totalTokens} tokens`)
  } catch (error) {
    log('warn', `软线提醒写不进去：${error?.message ?? error}`)
  }
}

/** 读「钉住的要求」：这行字跟着每条指针走，压多少次都不丢。 */
function readPins(options) {
  try {
    const raw = readFileSync(options.pinFile, 'utf8')
    const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'))
    if (lines.length === 0) return null
    let text = lines.join('\n')
    if (text.length > options.pinMaxChars) text = text.slice(0, options.pinMaxChars) + '…'
    return text
  } catch {
    return null
  }
}

/**
 * 处理排队的手动压缩。
 *
 * 排队的时机是「模型调了 compress 工具、结果还没回来」，真正写要等这一次工具
 * 结果落地、下一轮 pre-step 开始前。这时表层末端已经闭合，append checkpoint
 * 不会插进一对调用和结果中间。
 */
async function flushPendingCompact(ctx, options, session, log) {
  const key = String(session.id ?? '?')
  const pending = pendingCompact.get(key)
  if (pending === undefined) return
  if (Date.now() - pending.queuedAt > 30 * 60 * 1000) {
    pendingCompact.delete(key)
    log('info', '排队的压缩放了半小时还没轮到，丢掉')
    return
  }
  if (!tailBalanced(session)) {
    // 还悬着，就留着，下一轮再看
    logOnce('排队压缩：表层还有没回的工具调用，等下一轮')
    return
  }
  const surface = session.surface.nodes
  const startIdx = surface.indexOf(pending.fromSeq)
  const endIdx = surface.indexOf(pending.toSeq)
  if (startIdx <= 0 || endIdx <= startIdx) {
    pendingCompact.delete(key)
    log('warn', `排队的压缩区间 ${pending.fromSeq}–${pending.toSeq} 已经不在表层了，跳过`)
    return
  }
  // 摘要块开着、还没发预告：先发预告等我写，不压
  if (options.summaryBlock !== false && pending.wantNotice) {
    const waitMs = Number(options.summaryWaitMs ?? SUMMARY_WAIT_MS) || SUMMARY_WAIT_MS
    const notice = [
      `【手动收段】准备压掉 seq ${pending.fromSeq}–${pending.toSeq}。`,
      '要我自己写摘要块的话，调 metabolism_summarize，写 500 字左右的叙述：连贯讲这段发生了什么、为什么、决定了什么，带一句我们之间的话（原话摘）和当时什么味，结尾留一行「下一步：xxx」。用「你说／我说」，不要第三人称。',
      `不写也行，${Math.round(waitMs / 60000)} 分钟后我按抽取兜底压。`,
    ].join('\n')
    session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: notice }],
      source: { kind: 'summary-notice' },
    }, { surfaceOp: 'append' })
    writeSummaryState({ sessionId: key, fromSeq: pending.fromSeq, toSeq: pending.toSeq, text: '', noticeAt: Date.now(), tokens: 0 }, options)
    pending.wantNotice = false
    pending.queuedAt = Date.now()
    pendingCompact.set(key, pending)
    log('info', `排队压缩发预告：seq ${pending.fromSeq}–${pending.toSeq}，等我自己写`)
    return
  }

  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  let measurement = null
  try {
    measurement = header === undefined ? ctx.tokenMeter.measure(session) : ctx.tokenMeter.measure(session, header)
  } catch (error) {
    log('warn', `排队压缩量不了 token：${error?.message ?? error}`)
  }
  let tokens = 0
  for (let index = startIdx; index <= endIdx; index += 1) {
    const node = measurement?.nodes?.find((item) => item.seq === surface[index])
    tokens += Number(node?.heuristicTokens ?? node?.tokens ?? 0)
  }
  const range = { start: pending.fromSeq, end: pending.toSeq, startIdx, endIdx, tokens }

  // 摘要块开着：先看有没有我写的摘要，没写且没超时就继续等
  const summaryState = readSummaryState(options)
  const stateMine = summaryState !== null
    && String(summaryState.sessionId ?? '') === key
    && Number(summaryState.fromSeq) === pending.fromSeq
    && Number(summaryState.toSeq) === pending.toSeq
  const mineText = stateMine ? String(summaryState.text ?? '').trim() : ''
  const waitMs = Number(options.summaryWaitMs ?? SUMMARY_WAIT_MS) || SUMMARY_WAIT_MS
  const overdue = stateMine && Date.now() - Number(summaryState.noticeAt ?? 0) > waitMs

  if (options.summaryBlock !== false && stateMine && mineText === '' && !overdue) {
    pending.queuedAt = Date.now()
    pendingCompact.set(key, pending)
    return
  }

  pendingCompact.delete(key)
  try {
    let digest
    if (mineText !== '') {
      digest = { short: summaryShortLine(mineText), long: mineText, mode: String(summaryState.mode ?? 'passive') }
    } else {
      digest = options.summaryEnabled === false ? null : await summarizeWithModel(ctx, options, session, undefined, range, log)
      if (digest === null && options.summaryBlock !== false) {
        const det = deterministicSummary(session, range)
        digest = { short: summaryShortLine(det), long: det }
      }
    }
    const result = writeCompaction(session, range, options, digest, log)
    if (mineText !== '') {
      clearSummaryState(options)
      log('info', `用的是我写的摘要块（${mineText.length} 字）`)
    }
    log('info', `排队压完：seq ${range.start}–${range.end}，${result.shadowedSeqs.length} 条，约 ${tokens} tokens`)
  } catch (error) {
    log('warn', `排队压缩没写成：${error?.message ?? error}`)
  }
}

/** 写一次压缩：开锁 → 写摘要 → 替换表层 → 收尾。 */
function writeCompaction(session, range, options, digest, log) {
  // 末端还悬着工具调用时绝不写：新消息会插在调用和结果中间，下一次请求必坏。
  if (!tailBalanced(session)) {
    throw new Error('表层末尾还有没回来的工具调用，这一轮不写压缩（会拆开调用和结果）')
  }
  // 区间两头也必须是「没有悬着的调用」的位置：
  //   - 起点前面悬着调用，说明这条调用的结果落在区间里，压完会剩下一个没有结果的调用；
  //   - 终点后面悬着调用，说明结果会被留在区间外。
  // 111909 那次就是起点切在了一条调用的结果上（调用在 111907），DeepSeek 直接拒收。
  const balance = surfaceBalance(session)
  if (Number(balance.before[range.startIdx] ?? 0) !== 0) {
    throw new Error(`压缩起点 seq ${range.start} 前面还有没回的调用，要往前挪到那条调用之前`)
  }
  if (Number(balance.after[range.endIdx] ?? -1) !== 0) {
    throw new Error(`压缩终点 seq ${range.end} 后面还有没回的调用，要往前挪`)
  }
  const shadowedSeqs = session.surface.nodes.slice(range.startIdx, range.endIdx + 1)
  const now = Date.now()
  const stamp = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  const day = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`
  const clock = `${pad(stamp.getHours())}-${pad(stamp.getMinutes())}-${pad(stamp.getSeconds())}`
  const compactionId = `metabolism-${now.toString(36)}-${randomUUID().slice(0, 4)}`
  // 文件名跟归档器用同一套规则：整个压缩编号当文件名，两边才对得上
  const archivePath = `${options.archiveRoot}\\${day}\\${compactionId}.jsonl`

  // 指针里带 seq 区间：以后捞原文不用先猜它在第几条。
  // 完整路径太长，只留文件名（recall 按文件名能找着），省下来的字够写半句摘要。
  const pointer = `【这一段已归档：${compactionId}.jsonl，seq ${range.start}–${range.end}，${shadowedSeqs.length} 条，约 ${range.tokens} tokens。要细节就去翻那个文件。】`
  // 摘要块（2026-11-20）：整段 300~500 字留在上下文里，不再只剩一行。
  const wantBlock = options.summaryBlock !== false
  const blockBody = wantBlock && typeof digest?.long === 'string' && digest.long.trim().length > 0
    ? digest.long.trim()
    : null
  const shortLine = blockBody !== null
    ? renderSummaryBlock({ text: blockBody, seqFrom: range.start, seqTo: range.end, archiveName: `${compactionId}.jsonl`, tokenCount: range.tokens })
    : (digest?.short === null || digest?.short === undefined
      ? pointer
      : `【已归档 seq ${range.start}–${range.end}，约 ${range.tokens} tokens：${digest.short}】`)
  // 钉住的要求：压进去也不丢
  const pins = readPins(options)
  const pinBlock = pins === null ? null : { type: 'text', text: `【钉住，别丢】\n${pins}` }
  // 茅房那份带五行骨架 + 指针，供以后翻查
  const archiveBlocks = [
    ...(digest?.long === null || digest?.long === undefined ? [] : [{ type: 'text', text: digest.long }]),
    { type: 'text', text: pointer },
    ...(pinBlock === null ? [] : [pinBlock]),
  ]

  // 登记这一块，折叠时靠它算年龄和总量（2026-11-20）
  if (blockBody !== null) {
    const rows = readSummaryRegistry(options)
    rows.push({ compactionId, seqFrom: range.start, seqTo: range.end, at: Date.now(), tokens: estimateTokens(blockBody), layer: 'a', body: blockBody, mode: digest?.mode ?? 'passive' })
    writeSummaryRegistry(rows, options)
  }

  const turn = openTurnOf(session)
  const startEvent = session.append('compaction/start', { compactionId, turn })

  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: archiveBlocks,
    shadowedRange: { start: range.start, end: range.end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount: range.tokens,
    provider: digest === null ? 'dsh-metabolism' : 'dsh-metabolism+llm',
    model: digest === null ? 'pointer-template' : 'digest-2layer',
  })

  session.append('user/message', {
    id: randomUUID(),
    role: 'user',
    content: [
      { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>` },
      { type: 'text', text: shortLine },
      ...(pinBlock === null ? [] : [pinBlock]),
      { type: 'text', text: '</compacted-summary>' },
    ],
    source: { kind: 'compact-checkpoint', compactionId },
  }, {
    surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })

  session.append('compaction/end', { compactionId, turn })

  // 骨架：把这一段写成一张人能直接读的说明卡（记忆\骨架\L1），再记进总目录。
  // 这一步只写盘、不进上下文；失败只记一行日志，压缩本身照旧完成。
  // 「一次调用出两份」：模型写的摘要带 card；我自己写的摘要块没有 card，就从块里派生一张，
  // 只补「下一步 / 还没做完」和摘出来的原话。
  if (options.skeletonEnabled !== false) {
    const cardData = (digest?.card !== null && digest?.card !== undefined)
      ? digest.card
      : (blockBody !== null ? deriveCard(blockBody) : null)
    if (cardData !== null && cardData !== undefined) {
      const fromEvent = session.eventAt(range.start)
      const toEvent = session.eventAt(range.end)
      const card = writeL1({
        archiveRoot: options.archiveRoot,
        compactionId,
        shortId: compactionId.slice(-4),
        fromMs: Number(fromEvent?.time) || now,
        toMs: Number(toEvent?.time) || now,
        seqFrom: range.start,
        seqTo: range.end,
        tokens: range.tokens,
        archivePath,
        title: cardData.title ?? (digest?.short ?? ''),
        keywords: cardData.keywords ?? [],
        doing: cardData.doing,
        requirements: cardData.requirements ?? [],
        done: cardData.done ?? [],
        next: cardData.next ?? '',
        quotes: cardData.quotes ?? [],
        // 守卫的对照物：模型当时看到的那段原文摘录；自己写的块没有样本，就跳过守卫
        rawSample: digest?.sample,
        guard: digest?.sample ? options.guard : undefined,
      })
      if (typeof log === 'function') {
        if (card.ok) log('info', `骨架卡：${card.id}，目录里现在 ${card.total} 段${card.notes?.length ? `（${card.notes.join('；')}）` : ''}`)
        else if (card.skipped !== undefined) log('warn', `骨架卡没写：${card.skipped}（${(card.missing ?? []).join('、')}）`)
        else log('warn', `骨架卡没写成，压缩照旧：${card.error}`)
      }
    }
  }

  return { compactionId, summary: shortLine, shadowedSeqs }
}

/** 当前开着的是第几轮；自动压缩必须落在开着的轮里。 */
function openTurnOf(session) {
  for (let at = session.seq - 1; at >= 0; at -= 1) {
    const event = session.eventAt(at)
    if (event === undefined) continue
    if (event.type === 'turn/start') return event.data?.turn ?? null
    if (event.type === 'turn/end') return null
  }
  return null
}

// 批量重灌（离线）要用的口子：让脚本能自己挑段、写摘要、替换表层。
export { writeCompaction, deterministicSummary, summaryShortLine, contentTextOf }
