/**
 * dsh-metabolism 被动水合（2026-11-21）：让相关经历自己浮上来，不用模型主动去捞。
 * 借鉴 oh-omp 的 passive-hydration.ts，复用我们自己的 向量.js + recall.js。
 *
 * 每轮：取最近几轮热窗 → embed → 跟上一轮比余弦，距离 < 阈值就复用上次注入，否则检索 → 注入。
 * 默认关（hydrate !== true 时什么都不干），先影子跑。
 * 整条流水线有时间上限（4 秒）和注入字数上限，失败只记日志、返回空，绝不阻塞对话。
 *
 * @module dsh-metabolism/水合
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { embedTexts } from './向量.js'
import { search } from './recall.js'

const HOT_WINDOW_TURNS = 5
const COSINE_THRESHOLD = 0.15
const TOP_K = 5
const MAX_HYDRATION_MS = 4000
const MAX_INJECT_CHARS = 2400
const HOT_WINDOW_MAX_CHARS = 1500

// 每会话一份：上次热窗的向量 + 上次注入的文本
const perSession = new Map()

/** 系统注入类的文本（画像、骨架、提醒、水合自身、runtime 快照），一律跳过。 */
function isInjectedText(text) {
  if (typeof text !== 'string' || text.length === 0) return true
  const head = text.slice(0, 60)
  return /^<engram_profile|^<骨架|^<时间线|^【|^Time sampled|^<path>|^<recalled-context|^Current runtime context|^The following information describes|^This is an automatically generated checkpoint/.test(head)
}

/** 事件里的正文（只取 text 块）。 */
function textOf(event) {
  const blocks = event?.data?.message?.content ?? event?.data?.content
  if (!Array.isArray(blocks)) return null
  const joined = blocks
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join(' ')
  const trimmed = joined.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** 热窗：最近 N 条用户消息的文本拼起来。 */
function hotWindowText(session, turns) {
  const surface = session?.surface?.nodes ?? []
  if (!Array.isArray(surface)) return ''
  const parts = []
  let userCount = 0
  for (let index = surface.length - 1; index >= 0 && userCount < turns; index -= 1) {
    const event = session.eventAt(surface[index])
    if (event === undefined || event.type !== 'user/message') continue
    const text = textOf(event)
    if (text === null || text.length < 4 || isInjectedText(text)) continue
    parts.unshift(text)
    userCount += 1
  }
  return parts.join('\n').slice(0, HOT_WINDOW_MAX_CHARS)
}

/** 两个归一化向量的余弦（点积就是余弦）。 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index]
  return sum
}

/** 渲染注入文本。只注「他 / 我」的真人话，跳过工具输出和系统注入。 */
function renderInjected(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return ''
  const lines = ['【想起的事，自己浮上来的】']
  for (const hit of hits.slice(0, TOP_K)) {
    if (hit.role === '工具') continue
    const text = String(hit.text ?? '').replace(/\s+/g, ' ').slice(0, 160)
    if (text.length === 0 || isInjectedText(text)) continue
    lines.push(`- ${text}`)
  }
  if (lines.length <= 1) return ''
  const joined = lines.join('\n')
  return joined.length > MAX_INJECT_CHARS ? `${joined.slice(0, MAX_INJECT_CHARS)}…` : joined
}

/** 带时间上限的 embed；超时返回 null。 */
async function embedWithTimeout(text, started, options, log) {
  const elapsed = Date.now() - started
  const remaining = MAX_HYDRATION_MS - elapsed
  if (remaining <= 0) return null
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), remaining))
  const workspace = resolve(String(options.archiveRoot), '..', '..')
  const embed = embedTexts([text], workspace, { query: true, log }).catch(() => null)
  return await Promise.race([embed, timeout])
}

/** 带时间上限的检索；超时返回空。 */
async function searchWithTimeout(text, started, options, log) {
  const elapsed = Date.now() - started
  const remaining = MAX_HYDRATION_MS - elapsed
  if (remaining <= 0) return []
  const timeout = new Promise((resolve) => setTimeout(() => resolve([]), remaining))
  const run = search(options.archiveRoot, text, { semantic: true, limit: TOP_K, noRebuild: true }).then((r) => r?.hits ?? []).catch(() => [])
  return await Promise.race([run, timeout])
}

/**
 * 跑一次水合，返回要注入的文本；没东西可注入返回 null。
 * options.hydrate 为 true 才跑；options.workspace 给向量模型定位用。
 */
export async function hydrate(session, options, log = () => {}) {
  if (options.hydrate !== true) return null
  if (session === undefined || typeof session.append !== 'function') return null
  const started = Date.now()
  const text = hotWindowText(session, HOT_WINDOW_TURNS)
  if (text === '') {
    log('info', '水合：热窗空（最近几条都是注入或没取到），跳过')
    return null
  }
  const key = String(session.id ?? '')
  if (key === '') return null

  try {
    const prev = perSession.get(key)

    const vecs = await embedWithTimeout(text, started, options, log)
    if (vecs === null || vecs.length === 0) {
      log('info', '水合：embed 没成（超时或模型没就绪），这一轮跳过')
      return null
    }
    const embedding = vecs[0]

    // 余弦缓存：距离 < 阈值，复用上次注入，不再检索
    if (prev && cosine(prev.embedding, embedding) > (1 - COSINE_THRESHOLD)) {
      return prev.injectText !== '' ? prev.injectText : null
    }

    // miss：检索并注入
    const hits = await searchWithTimeout(text, started, options, log)
    const injectText = renderInjected(hits)
    perSession.set(key, { embedding, injectText })
    if (injectText === '') {
      log('info', '水合：检索没命中，这一轮不注入')
      return null
    }
    log('info', `水合：热窗命中 ${hits.length} 条，注入 ${injectText.length} 字（${Math.round((Date.now() - started) / 1000)}s）`)
    return injectText
  } catch (error) {
    log('warn', `水合失败：${error?.message ?? String(error)}`)
    return null
  }
}
