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
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

const SUMMARY_SYSTEM = `你在给一段被压缩掉的对话写「归档标签」。看下面这段原文，写出两样东西：

【短】不超过四十个字，说清这段在聊什么。这是以后放回上下文里的那一行，写给人看的，不是给机器看的。
【长】四五行，每行一句：聊了什么、得到什么结论、踩了什么坑、还欠什么。

规矩：
- 只写这段里真有的，不补不猜。
- 不写「用户」「助手」这种称呼，直接写事。
- 不写抱歉、不写总结陈词、不写「以上」。
- 短的那行不要句号结尾。`

export const name = 'metabolism-engine'
export const inject = ['tokenMeter', 'llm', 'tools']

/** 「同一个判断」的节流表：签名 → 上次记录时间。 */
const lastPlan = new Map()
/** 每个会话只记一次窗口数字，方便核对。 */
const seenWindow = new Set()

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
    dryRun: source.dryRun !== false,
    thresholdRatio: number(source.thresholdRatio, 0.8),
    retainRatio: number(source.retainRatio, 0.12),
    minChunkTokens: number(source.minChunkTokens, 2000),
    contextWindow: number(source.contextWindow, 0),
    /** 绝对阈值：总 token 超过这个数就开始压。0 表示退回按窗口比例算。 */
    thresholdTokens: number(source.thresholdTokens, 260000),
    /** 压完之后保留多少 token 的最近内容。0 表示退回按窗口比例算。 */
    retainTokens: number(source.retainTokens, 130000),
    /** 输出预留封顶：最多从窗口里扣掉这么多给回答，别让 256k 的默认值把窗口吃光。 */
    maxReserveTokens: number(source.maxReserveTokens, 65536),
    /** 归档时让模型写两行摘要；关掉就退回只有指针。 */
    summaryEnabled: source.summaryEnabled !== false,
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
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return {}
    const value = {}
    if (typeof parsed.takeover === 'boolean') value.takeover = parsed.takeover
    if (typeof parsed.dryRun === 'boolean') value.dryRun = parsed.dryRun
    if (Number.isFinite(Number(parsed.thresholdRatio))) value.thresholdRatio = Number(parsed.thresholdRatio)
    if (Number.isFinite(Number(parsed.retainRatio))) value.retainRatio = Number(parsed.retainRatio)
    if (Number.isFinite(Number(parsed.thresholdTokens))) value.thresholdTokens = Number(parsed.thresholdTokens)
    if (Number.isFinite(Number(parsed.retainTokens))) value.retainTokens = Number(parsed.retainTokens)
    if (Number.isFinite(Number(parsed.softTokens))) value.softTokens = Number(parsed.softTokens)
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
      if (mode().takeover !== true) return resolved
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
  const body = lines.map((seg, index) => {
    // 收口往前挪：切点后面要是工具结果，就会把一对调用/结果拆开
    let to = seg.to
    while (to > seg.from && isToolResultEvent(session, surface[to + 1])) to -= 1
    const fromSeq = surface[seg.from]
    const toSeq = surface[to]
    // 段里可能起头是工具调用、没有文字，往后找第一条有字的
    let head = seg.head
    if (head === '（没有文字）') {
      for (let at = seg.from; at <= to && at < seg.from + 8; at += 1) {
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
    return `${index + 1}. ${seg.at} 起 · 表层第 ${seg.from}–${to} 个节点 · ${span} · 约 ${Math.round(seg.tokens)} tokens · ${seg.count} 条 · 开头：${head}`
  })
  return { total, count: lines.length, text: body.join('\n') }
}

/** 手动压缩工具：catalog 看目录，forget 点名压掉哪一段。 */
function compactTool(ctx, options, log) {
  return {
    name: 'metabolism_compact',
    description: '手动压缩：catalog 列出这段会话分成的若干段（时间、seq、token、开头），forget 把指定的一段原文收进茅房、换成一指针。不等到阈值，由你决定留哪段、忘哪段。',
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
      if (isToolResultEvent(session, surface[endIdx + 1])) {
        return { ok: false, text: '切点后面紧跟着工具结果，会把一对调用和结果拆开。把 toSeq 往前挪一条。' }
      }
      const meter = ctx.tokenMeter
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
      const measurement = header === undefined ? meter.measure(session) : meter.measure(session, header)
      let tokens = 0
      for (let index = startIdx; index <= endIdx; index += 1) {
        const node = measurement.nodes.find((item) => item.seq === surface[index])
        tokens += Number(node?.heuristicTokens ?? node?.tokens ?? 0)
      }
      const range = { start: fromSeq, end: toSeq, startIdx, endIdx, tokens }
      const digest = options.summaryEnabled === false ? null : await summarizeWithModel(ctx, options, session, undefined, range, log)
      const result = writeCompaction(session, range, options, digest)
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

/** 一次压力判断：量一遍，选一段，够不够、能不能压。 */
async function step(ctx, options, agent, signal, log) {
  const session = agent?.session
  if (session === undefined) return
  const meter = ctx.tokenMeter
  if (meter === undefined || typeof meter.measure !== 'function') return

  // 0. 先裁掉超长的工具结果：宿主自带这个服务，直接借；没有就跳过
  pruneLongToolResults(ctx, options, session, log)

  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  const measurement = header === undefined ? meter.measure(session) : meter.measure(session, header)
  const totalTokens = Number(measurement?.totalTokens) || 0
  if (totalTokens <= 0) return

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
  const range = pickRange(session, measurement, retainTokens, totalTokens)
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

  log('info', `压力 ${totalTokens}/${thresholdTokens}，开始压：${plan}`)
  const digest = options.summaryEnabled === false
    ? null
    : await summarizeWithModel(ctx, options, session, agent, range, log)
  const result = writeCompaction(session, range, options, digest)
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
      maxTokens: 800,
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
  const long = matchBlock(text, '长')
  if (short === null && long === null) {
    // 模型没按格式来，就把整段当骨架，短行取第一句
    const fallback = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    return { short: fallback[0]?.slice(0, 40) ?? null, long: fallback.slice(0, 5).join('\n') || null }
  }
  return {
    short: short === null ? null : short.slice(0, 60),
    long,
  }
}

/** 从模型输出里抠出【短】/【长】两段。 */
function matchBlock(text, label) {
  const pattern = new RegExp(`【${label}】\\s*([\\s\\S]*?)(?=【(?:短|长)】|$)`)
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
function pickRange(session, measurement, retainTokens, totalTokens) {
  const nodes = measurement?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  const surface = session.surface?.nodes
  if (!Array.isArray(surface) || surface.length !== nodes.length) return null
  if (surface.some((seq, index) => seq !== nodes[index]?.seq)) return null

  const firstIdx = session.eventAt(surface[0])?.type === 'system/message' ? 1 : 0
  let accumulated = 0
  let keepFromIdx = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += Number(nodes[index].heuristicTokens ?? nodes[index].tokens ?? 0)
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null

  const tokensOf = (from, to) => {
    let sum = 0
    for (let index = from; index <= to; index += 1) sum += Number(nodes[index].heuristicTokens ?? nodes[index].tokens ?? 0)
    return sum
  }

  // 工具配对：按宿主的规矩——只有「这一刻没有悬着的调用」（计数回到 0）才是安全切点。
  // 在安全点里挑最靠后的那个，优先不超过「该收多少」，超了才取最近的一个。
  const balance = surfaceBalance(session)
  const idealCut = Math.max(0, Number(totalTokens) - retainTokens)
  let endIdx = -1
  let fallbackIdx = -1
  let running = 0
  for (let index = firstIdx; index < nodes.length - 1; index += 1) {
    running += Number(nodes[index].heuristicTokens ?? nodes[index].tokens ?? 0)
    if (Number(balance.after[index] ?? -1) !== 0) continue
    if (running <= idealCut) endIdx = index
    else {
      if (fallbackIdx < 0) fallbackIdx = index
      break
    }
  }
  if (endIdx < firstIdx && fallbackIdx >= firstIdx) endIdx = fallbackIdx
  if (endIdx < firstIdx) return null
  while (endIdx + 1 < surface.length - 1 && isToolResultEvent(session, surface[endIdx + 1])) endIdx += 1

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

/** 写一次压缩：开锁 → 写摘要 → 替换表层 → 收尾。 */
function writeCompaction(session, range, options, digest) {
  const shadowedSeqs = session.surface.nodes.slice(range.startIdx, range.endIdx + 1)
  const now = Date.now()
  const stamp = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  const day = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`
  const clock = `${pad(stamp.getHours())}-${pad(stamp.getMinutes())}-${pad(stamp.getSeconds())}`
  const compactionId = `metabolism-${now.toString(36)}-${randomUUID().slice(0, 4)}`
  // 文件名跟归档器用同一套规则：整个压缩编号当文件名，两边才对得上
  const archivePath = `${options.archiveRoot}\\${day}\\${compactionId}.jsonl`

  const pointer = `【这一段已归档，原文：${archivePath}；${shadowedSeqs.length} 条，约 ${range.tokens} tokens。要细节就去翻那个文件。】`
  // 上下文里只放一小句：有方向感，又不占地方
  const shortLine = digest?.short === null || digest?.short === undefined
    ? pointer
    : `【这一段已归档，原文：${archivePath}；${digest.short}】`
  // 钉住的要求：压进去也不丢
  const pins = readPins(options)
  const pinBlock = pins === null ? null : { type: 'text', text: `【钉住，别丢】\n${pins}` }
  // 茅房那份带五行骨架 + 指针，供以后翻查
  const archiveBlocks = [
    ...(digest?.long === null || digest?.long === undefined ? [] : [{ type: 'text', text: digest.long }]),
    { type: 'text', text: pointer },
    ...(pinBlock === null ? [] : [pinBlock]),
  ]

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
