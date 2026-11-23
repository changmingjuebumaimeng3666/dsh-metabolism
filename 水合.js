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
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { embedTexts } from './向量.js'
import { search } from './recall.js'

const HOT_WINDOW_TURNS = 5
const COSINE_THRESHOLD = 0.15
const TOP_K = 3
const COS_MIN = 0.35
const MAX_HYDRATION_MS = 4000
const MAX_INJECT_CHARS = 1200
const HOT_WINDOW_MAX_CHARS = 1500

// 每会话一份：上次热窗的向量 + 上次注入的文本
const perSession = new Map()

/** 内容哈希（FNV-1a 32 位，跟 engine.js 同源）：标签按它存。 */
function hashOf(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return String(h)
}

/** 读标签表 { 内容哈希: 标签 }；读不到就空。 */
function readTagMap(archiveRoot) {
  try {
    const file = join(archiveRoot, '..', '茅房索引', '标签.json')
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

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

/** 代码/技术符号密集的（反引号、箭头、花括号、路径、等号），是技术调试记录，不是口语对话。 */
function isTechNoise(text) {
  const code = (String(text).match(/[`{}()\[\]=>\/\\]/g) ?? []).length
  return code / Math.max(1, String(text).length) > 0.12
}

/** 英文为主的文本（agent 提示词、源码、checkpoint 多是英文）：咱俩的对话是中文，英文一律不注。 */
function isEnglishHeavy(text) {
  const letters = (String(text).match(/[a-zA-Z]/g) ?? []).length
  return letters / Math.max(1, String(text).length) > 0.5
}

/** 文档碎片/截断话/任务提示词的特征。 */
function isFragment(text) {
  return /^["'“「『」』#*-]/.test(text)
    || text.includes('## ')
    || text.includes('\n\n')
    || /请调研|请参考|请阅读|用 web_fetch|按以下步骤|以下三个来源|请写|请读/.test(text)
}

/** 规则粗筛：只留「他 / 我」的真人话，去脏、去重、按标签排除技术。返回干净的候选数组（最多 10 条）。 */
function cleanHits(hits, hotText = '', tags = {}) {
  if (!Array.isArray(hits) || hits.length === 0) return []
  const picked = []
  for (const hit of hits) {
    if (picked.length >= 10) break
    if (hit.role === '工具') continue
    const text = String(hit.text ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < 12 || isInjectedText(text)) continue
    if (text.includes('[调用')) continue
    if (isFragment(text)) continue
    if (isEnglishHeavy(text)) continue
    if (isTechNoise(text)) continue
    if (hit.cos !== null && hit.cos !== undefined && hit.cos < COS_MIN) continue
    if (hotText.length > 0 && hotText.includes(text.slice(0, 24))) continue
    // 标签：技术类直接不浮（flash 重排会再筛一遍，这里先砍掉大头）
    if (tags[hashOf(text)] === '技术') continue
    picked.push(text.slice(0, 140))
  }
  return picked
}

/** 渲染注入文本。 */
function renderPicked(picked) {
  if (!Array.isArray(picked) || picked.length === 0) return ''
  const lines = ['【翻出来的旧事，垫在下面，不是你刚才说的】']
  for (const t of picked.slice(0, TOP_K)) lines.push(`· ${t}`)
  const joined = lines.join('\n')
  return joined.length > MAX_INJECT_CHARS ? `${joined.slice(0, MAX_INJECT_CHARS)}…` : joined
}

/**
 * 用 flash 挑「最值得浮的 3 条」：跳过技术干活、报错、调试，只留经历/决定/偏好/情绪时刻。
 * 没传 callModel，或候选本来就不多，就不调模型、按原顺序取前 3。
 */
async function pickWorth(query, candidates, callModel, log) {
  if (typeof callModel !== 'function') return candidates.slice(0, TOP_K)
  if (candidates.length === 0) return []
  try {
    const system = '你是筛选助手。下面几条是从过往对话捞出来的内容，每条有编号。挑出最多 3 条「有味道、值得现在想起来」的——两人之间的经历、决定、偏好、情绪时刻，也包括咱俩的玩笑、斗嘴、闲话、没头没脑的段子（这些也是味道，别当垃圾丢掉）；只跳过纯技术干活、报错、调试、文档、代码。如果一条都不值得，就只输出 0。只输出选中的编号，一行一个数字。'
    const user = `眼前在聊：${String(query).slice(0, 300)}\n\n候选：\n${candidates.map((c, i) => `${i + 1}. ${c.slice(0, 160)}`).join('\n')}`
    const raw = await callModel(system, user)
    if (typeof log === 'function') log('info', `水合挑选：候选 ${candidates.length} 条，模型回「${String(raw).replace(/\s+/g, ' ').slice(0, 120)}」`)
    const nums = [...String(raw).matchAll(/\d+/g)].map((m) => Number(m[0]))
    const picked = [...new Set(nums.filter((n) => n >= 1 && n <= candidates.length))].slice(0, TOP_K)
    return picked.map((n) => candidates[n - 1]).filter(Boolean)
  } catch (error) {
    log('warn', `水合挑选失败，按原顺序取前 ${TOP_K}：${error?.message ?? String(error)}`)
    return candidates.slice(0, TOP_K)
  }
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
  const run = search(options.archiveRoot, text, { semantic: true, limit: 30, noRebuild: true }).then((r) => r?.hits ?? []).catch(() => [])
  return await Promise.race([run, timeout])
}

/**
 * 跑一次水合，返回要注入的文本；没东西可注入返回 null。
 * options.hydrate 为 true 才跑；options.workspace 给向量模型定位用。
 */
export async function hydrate(session, options, log = () => {}, callModel = undefined) {
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

    // 余弦缓存：距离 < 阈值，说明热窗没怎么变
    if (prev && cosine(prev.embedding, embedding) > (1 - COSINE_THRESHOLD)) {
      // 同一段已经注过一次，就别反复塞（2026-11-22 老大发现它在重复注入）
      if (prev.injected === true) return null
      if (prev.injectText !== '') return prev.injectText
    }

    // miss：检索 → 规则粗筛 → flash 挑最值得浮的 → 注入
    const hits = await searchWithTimeout(text, started, options, log)
    const cleaned = cleanHits(hits, text, readTagMap(options.archiveRoot))
    const picked = await pickWorth(text, cleaned, callModel, log)
    const injectText = renderPicked(picked)
    perSession.set(key, { embedding, injectText, injected: false })
    if (injectText === '') {
      log('info', '水合：检索没命中，这一轮不注入')
      return null
    }
    // 注完标一下，下轮同样的注入不再重复
    perSession.set(key, { embedding, injectText, injected: true })
    log('info', `水合：命中 ${hits.length} 条，筛后 ${cleaned.length}，注入 ${picked.length} 条（${Math.round((Date.now() - started) / 1000)}s）`)
    return injectText
  } catch (error) {
    log('warn', `水合失败：${error?.message ?? String(error)}`)
    return null
  }
}
