/**
 * 茅房召回：从归档的原文里按关键词/时间把说过的话捞回来。
 *
 * 设计沿用我们自己在记忆插件上验证过的那套（手艺房#9 的评测），把能用上的四条搬过来：
 *   1. 中文按二元组切词，并丢掉虚词表里的二元组（否则「的」「了」什么都能命中）；
 *   2. 排序主要看「少见的词命中了几个」，而不是命中多少次；
 *   3. 查询本身带时间词（今天/昨天/前天/上周/三号）就自动收窄日期；
 *   4. 返回的是原话片段 + 出处，不返回整段原文（要看细节再按 seq 取）。
 *
 * 2026-11-18 改动（评测 30 题，命中前五从 15/30 提到 25/30，单次查询 1400ms → 110ms）：
 *   - 建一份干净索引：剥掉宿主每轮塞进来的画像/记忆/技能表/时间注记，工具结果取出真正的文本，
 *     同一段话只留一条（原归档里约有一半是重复副本）；
 *   - 打分改成 BM25 + IDF 覆盖率，长文按长度压一压，问「多少/几」时带数字的那条加权；
 *   - 片段以命中的词为中心截图，不再永远从头截。
 * 索引坏了或还没建，退回原来的现扫现查，慢但一样能答。
 *
 * @module dsh-metabolism/recall
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { cosineTop, embedTexts, readVectors, vectorsReady, MODEL as VECTOR_MODEL } from './向量.js'
import { rerankScores } from './重排.js'
// 骨架工具跟着召回一起挂：同一个 tools 服务，省一条补丁条目（2026-11-19）。
import { apply as skeletonApply } from './骨架工具.js'
// 浮现也一起挂：它只要有事件口子，不需要 tools（默认关，开关里打开才动）。
import { apply as morphApply } from './浮现.js'
// 贴条（每轮最多一条）：同样只要有事件口子（默认关）。
import { apply as attachApply } from './贴条.js'

/** 词面与语义各占多少（合起来排位用倒数名次，不看绝对分）。 */
const RRF_LEXICAL = 1
const RRF_VECTOR = Number(process.env.METAB_RRF_VECTOR ?? localOverrides().rrfVector ?? 1)
const RRF_K = 60
/** 只在向量那一路出现的，余弦低于这个就不放进来（避免尾巴上的杂项）。 */
const VECTOR_ONLY_MIN_COS = Number(localOverrides().cosMin ?? 0)

/** 常见虚词二元组：这些命中不算数。 */
const STOP_BIGRAMS = new Set([
  '的', '了', '是', '在', '和', '就', '都', '也', '还', '把', '被', '让', '给', '跟',
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '一个', '一下',
  '就是', '还是', '因为', '所以', '但是', '如果', '已经', '现在', '然后', '这样',
  '那样', '自己', '没有', '不是', '真的', '可能', '应该', '需要', '觉得', '知道',
  '多少', '几个', '哪一', '时候', '为什', '是什', '么样', '我这', '你这', '他那',
])

const STOP_CHARS = new Set('的了是在和就都也还把被让给跟吗呢吧啊呀哦嗯这那有我没你他她它个不'.split(''))

/** 一条归档里最多收多少字（超长的工具输出只留开头，够检索）。 */
const MAX_UNIT_CHARS = 20000

/**
 * 长单元切成小块（2026-11-20）。一整段工具输出或一份评测输出当成一条，
 * 里面能对上几十个词，会把真答案整个挤下去——线上跑分只有 5/30 就是它干的。
 * 500 字一块、相邻重叠 100 字，保证跨块的句子还能连上。
 */
const CHUNK_CHARS = Math.max(200, Number(localOverrides().chunkChars) || 500)
const CHUNK_OVERLAP = Math.max(0, Number(localOverrides().chunkOverlap) || 100)

function chunksOf(text) {
  if (text.length <= CHUNK_CHARS) return [text]
  const out = []
  for (let at = 0; at < text.length; at += CHUNK_CHARS - CHUNK_OVERLAP) {
    out.push(text.slice(at, at + CHUNK_CHARS))
    if (at + CHUNK_CHARS >= text.length) break
  }
  return out
}

/** 把一句话切成检索用的词：拉丁词按空格，中文按二元组。 */
export function termsOf(text) {
  const terms = new Set()
  const latin = String(text).toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? []
  for (const word of latin) terms.add(word)
  const cjk = String(text).replace(/[a-z0-9_.\-]+/gi, ' ').match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjk) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (STOP_BIGRAMS.has(bigram)) continue
      if (STOP_CHARS.has(bigram[0]) && STOP_CHARS.has(bigram[1])) continue
      terms.add(bigram)
    }
    if (run.length === 1 && !STOP_CHARS.has(run)) terms.add(run)
  }
  return [...terms]
}

/** 从查询里认时间词，返回日期区间（含端点），认不出返回 null。 */
export function parseQueryTime(text, now = new Date()) {
  const day = (offset) => {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - offset)
    return date
  }
  const stamp = (date) => {
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  if (/昨夜|昨晚/.test(text)) return { from: stamp(day(1)), to: stamp(day(0)) }
  if (/今天|今日|今早|今晚|今儿/.test(text)) return { from: stamp(day(0)), to: stamp(day(0)) }
  if (/昨天|昨日/.test(text)) return { from: stamp(day(1)), to: stamp(day(1)) }
  if (/前天/.test(text)) return { from: stamp(day(2)), to: stamp(day(2)) }
  if (/大前天/.test(text)) return { from: stamp(day(3)), to: stamp(day(3)) }
  if (/上周|上星期/.test(text)) return { from: stamp(day(14)), to: stamp(day(7)) }
  if (/这周|本周|这星期/.test(text)) return { from: stamp(day(7)), to: stamp(day(0)) }
  const explicit = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (explicit !== null) {
    const date = new Date(Number(explicit[1]), Number(explicit[2]) - 1, Number(explicit[3]))
    return { from: stamp(date), to: stamp(date) }
  }
  const monthDay = text.match(/(\d{1,2})月(\d{1,2})[日号]/)
  if (monthDay !== null) {
    const date = new Date(now.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2]))
    return { from: stamp(date), to: stamp(date) }
  }
  return null
}

/** 剥掉宿主每轮塞进用户消息里的注入块：画像、记忆、技能表、系统提醒、时间注记。 */
export function stripInjected(text) {
  let out = text
  out = out.replace(/<current_user_request>([\s\S]*?)<\/current_user_request>/g, '\n$1\n')
  const blocks = [
    /<engram_profile>[\s\S]*?<\/engram_profile>/g,
    /<engram_memory_context[^>]*>[\s\S]*?<\/engram_memory_context>/g,
    /<engram_selection_rationale>[\s\S]*?<\/engram_selection_rationale>/g,
    /<available_skills>[\s\S]*?<\/available_skills>/g,
    /<system-reminder>[\s\S]*?<\/system-reminder>/g,
    /<compacted-summary>[\s\S]*?<\/compacted-summary>/g,
    /<current_user_request>[\s\S]*?<\/current_user_request>/g,
  ]
  for (const re of blocks) out = out.replace(re, '\n')
  out = out.replace(/^Time sampled while preparing turn [^\n]*$/gm, '')
  out = out.replace(/^Browser time zone for this request: [^\n]*$/gm, '')
  out = out.replace(/^Elapsed since the preceding [^\n]*$/gm, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** 同一条消息里同一段文字重复两遍时只留一遍（宿主有时会重复塞）。 */
function dedupeRepeated(text) {
  if (text.length < 200) return text
  const half = Math.floor(text.length / 2)
  const a = text.slice(0, half).trim()
  const b = text.slice(half).trim()
  if (a.length > 100 && (b === a || b.startsWith(a.slice(0, 200)))) return a
  return text
}

/** 一条消息里所有文字块拼起来（用户/助手消息用）。 */
function textBlocks(data) {
  const blocks = Array.isArray(data?.content) ? data.content : Array.isArray(data?.message?.content) ? data.message.content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'tool-call') parts.push(`[调用 ${block.name ?? '工具'}] ${block.arguments ?? ''}`)
    else if (block?.type === 'tool-result') parts.push(String(block.result?.content ?? block.result ?? ''))
  }
  return parts.join('\n').trim()
}

/** 工具结果：从 JSON 壳里把 content[].text 取出来，别把整个壳当正文。 */
function toolText(data) {
  const blocks = Array.isArray(data?.message?.content) ? data.message.content
    : Array.isArray(data?.content) ? data.content
    : []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (typeof block?.text === 'string') parts.push(block.text)
  }
  if (parts.length > 0) return parts.join('\n')
  const raw = JSON.stringify(data ?? {})
  return raw.length > 8000 ? raw.slice(0, 8000) : raw
}

/** 把一条会话事件拆成能检索的文字块（原样，不洗）。 */
export function unitsOfEvent(event) {
  const data = event?.data ?? {}
  const at = Number(event?.time) || 0
  const push = (role, text) => ({ role, text, time: at, seq: event?.seq })
  const out = []
  if (event?.type === 'user/message') {
    const text = textBlocks(data)
    if (text.length > 0) out.push(push('他', text))
  } else if (event?.type === 'assistant/message') {
    const text = textBlocks(data)
    if (text.length > 0) out.push(push('我', text))
  } else if (event?.type === 'tool/result') {
    const text = toolText(data)
    if (text.length > 0) out.push(push('工具', text))
  }
  return out
}

/** 列出某日期区间内的归档文件。 */
export function filesInRange(archiveRoot, range) {
  if (!existsSync(archiveRoot)) return []
  const files = []
  for (const name of readdirSync(archiveRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue
    if (range?.from !== undefined && name < range.from) continue
    if (range?.to !== undefined && name > range.to) continue
    const dir = join(archiveRoot, name)
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.jsonl')) files.push({ day: name, path: join(dir, file), file })
    }
  }
  files.sort((a, b) => (a.day === b.day ? a.file.localeCompare(b.file) : a.day.localeCompare(b.day)))
  return files
}

/** 画像的小节标题——带这些的整段都是画像，不是我们说过的话，一律丢掉。 */
const PROFILE_MARKERS = /## 硬闸|## 关于 ta|## 相处模式|## 回答规矩|## 语气规矩|## 心情与档位|## 开场规矩|## 接头规矩|## 日志规矩|## 我自己|## 开场三行/

/** 洗一条文字块：剥注入、去重复、压空白。空的不算数。 */
function cleanText(text) {
  let out = stripInjected(text)
  out = dedupeRepeated(out)
  out = out.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  // system-reminder 等系统快照的正文残留（标签滤掉后剩下裸正文，旧索引里还有）：整段丢
  if (/^(Current runtime context|The following information describes|This is an automatically generated checkpoint)/.test(out)) return ''
  // 画像片段（它作为 user 消息注入过、被归档进了茅房）：带画像小节标题的整段丢
  if (PROFILE_MARKERS.test(out)) return ''
  return out
}

/** 读一个归档文件里的文字块（clean=false 时给 expand 用原始文本）。 */
export function unitsOfFile(path, day, file, capBytes = Number.MAX_SAFE_INTEGER, clean = true) {
  const raw = readFileSync(path)
  const slice = raw.length > capBytes ? raw.subarray(0, capBytes) : raw
  const units = []
  for (const line of slice.toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    for (const unit of unitsOfEvent(event)) {
      const text = clean ? cleanText(unit.text) : unit.text
      if (text.length === 0) continue
      units.push({ ...unit, text, day, file })
    }
  }
  return units
}

// ---------- 索引 ----------

const INDEX_FILE = '单元.jsonl'

/** 一条话真正发生的那天（按当地时间），取不到就用归档目录的日期。 */
function dayOf(time, fallback) {
  const at = Number(time)
  if (!Number.isFinite(at) || at <= 0) return fallback
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function indexPaths(indexDir) {
  return { dir: indexDir, file: join(indexDir, INDEX_FILE) }
}

/** 归档里最新的那个 jsonl 有多新（毫秒）。 */
function newestArchiveMtime(archiveRoot) {
  let newest = 0
  for (const entry of filesInRange(archiveRoot, null)) {
    try {
      const stat = statSync(entry.path)
      if (stat.mtimeMs > newest) newest = stat.mtimeMs
    } catch {
      // 读不到就跳过
    }
  }
  return newest
}

/**
 * 建索引：把整个归档洗一遍，去重后写成一行一条。
 * 22 万字的归档大约 8-10 秒。
 */
export function buildIndex(archiveRoot, indexDir, log = () => {}) {
  const paths = indexPaths(indexDir)
  if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true })
  const seen = new Set()
  const lines = []
  const files = {}
  for (const entry of filesInRange(archiveRoot, null)) {
    let units = []
    try {
      units = unitsOfFile(entry.path, entry.day, entry.file)
    } catch (error) {
      log(`读 ${entry.file} 失败：${error?.message ?? error}`)
      continue
    }
    try {
      const stat = statSync(entry.path)
      files[`${entry.day}/${entry.file}`] = { size: stat.size, mtime: stat.mtimeMs }
    } catch {
      // 记不上就记不上，下次全量再来
    }
    for (const unit of units) {
      for (const piece of chunksOf(unit.text)) {
        if (seen.has(piece)) continue
        seen.add(piece)
        const text = piece.length > MAX_UNIT_CHARS ? piece.slice(0, MAX_UNIT_CHARS) : piece
        lines.push(JSON.stringify({
          i: lines.length,
          d: dayOf(unit.time, entry.day),
          f: entry.file,
          s: unit.seq,
          t: unit.time,
          r: unit.role,
          n: piece.length,
          x: text,
        }))
      }
    }
  }
  writeFileSync(paths.file, lines.join('\n'), 'utf8')
  // 全量建完顺手记一份清单，下次就能走增量
  writeFileSync(manifestPath(indexDir), JSON.stringify({ version: 1, nextId: lines.length, files }), 'utf8')
  return { units: lines.length }
}

/** 索引是否比归档旧。 */
function indexStale(archiveRoot, indexDir) {
  const paths = indexPaths(indexDir)
  if (!existsSync(paths.file)) return true
  const manifest = readManifest(indexDir)
  if (manifest === null) return newestArchiveMtime(archiveRoot) > statSync(paths.file).mtimeMs
  const known = manifest.files ?? {}
  for (const entry of filesInRange(archiveRoot, null)) {
    const key = `${entry.day}/${entry.file}`
    let stat
    try {
      stat = statSync(entry.path)
    } catch {
      continue
    }
    const old = known[key]
    if (old === undefined || old.size !== stat.size) return true
  }
  return false
}

const MANIFEST_FILE = '已收录.json'

function manifestPath(indexDir) {
  return join(indexDir, MANIFEST_FILE)
}

function readManifest(indexDir) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(indexDir), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    if (parsed.files === undefined) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 增量：只把「新落地的归档文件」追加进索引，不重扫全库。
 *
 * 老大 2026-11-20 要的：茅房天天涨，每来一个新文件就把 212MB 重读一遍太蠢。
 * 没有清单或索引不存在时返回 null，调用方退回全量 buildIndex。
 * 去重只在这一次新增的批内做（跨文件的完全重复留给全量重建清）。
 */
export function appendToIndex(archiveRoot, indexDir, log = () => {}) {
  const paths = indexPaths(indexDir)
  if (!existsSync(paths.file)) return null
  const manifest = readManifest(indexDir)
  if (manifest === null) return null

  const known = manifest.files ?? {}
  const todo = []
  const present = new Set()
  for (const entry of filesInRange(archiveRoot, null)) {
    const key = `${entry.day}/${entry.file}`
    present.add(key)
    let stat
    try {
      stat = statSync(entry.path)
    } catch {
      continue
    }
    const old = known[key]
    if (old === undefined || old.size !== stat.size) todo.push({ entry, stat, key })
  }

  // 已经消失的文件从清单里清掉（索引里留着的那几条不动，宁可多不可少）
  const files = {}
  for (const [key, value] of Object.entries(known)) if (present.has(key)) files[key] = value
  for (const item of todo) files[item.key] = { size: item.stat.size, mtime: item.stat.mtimeMs }

  let nextId = Number(manifest.nextId) || 0
  const lines = []
  const seen = new Set()
  for (const { entry } of todo) {
    let units = []
    try {
      units = unitsOfFile(entry.path, entry.day, entry.file)
    } catch (error) {
      log(`读 ${entry.file} 失败：${error?.message ?? error}`)
      continue
    }
    for (const unit of units) {
      for (const piece of chunksOf(unit.text)) {
        if (seen.has(piece)) continue
        seen.add(piece)
        const text = piece.length > MAX_UNIT_CHARS ? piece.slice(0, MAX_UNIT_CHARS) : piece
        lines.push(JSON.stringify({
          i: nextId,
          d: dayOf(unit.time, entry.day),
          f: entry.file,
          s: unit.seq,
          t: unit.time,
          r: unit.role,
          n: piece.length,
          x: text,
        }))
        nextId += 1
      }
    }
  }

  if (lines.length > 0) {
    const current = readFileSync(paths.file)
    const needsBreak = current.length > 0 && current[current.length - 1] !== 0x0a
    appendFileSync(paths.file, `${needsBreak ? '\n' : ''}${lines.join('\n')}\n`, 'utf8')
  }

  writeFileSync(manifestPath(indexDir), JSON.stringify({ version: 1, nextId, files }), 'utf8')
  return { added: todo.length, units: lines.length }
}

let cache = null
let rebuilding = false

/** 把索引读进内存，顺手算好每个词的 df 和平均长度（一次 1-2 秒，之后查询几十毫秒）。 */
function loadIndex(archiveRoot, indexDir) {
  const paths = indexPaths(indexDir)
  if (cache !== null && cache.file === paths.file && cache.mtime === statSync(paths.file).mtimeMs) return cache
  const units = readFileSync(paths.file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  const lower = units.map((unit) => unit.x.toLowerCase())
  const df = new Map()
  for (const text of lower) {
    for (const term of new Set(termsOf(text))) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const avgLen = lower.reduce((sum, text) => sum + text.length, 0) / Math.max(1, lower.length)
  cache = { file: paths.file, mtime: statSync(paths.file).mtimeMs, units, lower, df, n: units.length, avgLen }
  return cache
}

const idfOf = (df, n) => Math.log(1 + (n - df + 0.5) / (df + 0.5))

const NUMERIC_Q = /多少|几[个条次位点天年]|多大|多长|多久|多重|多高/
const NUMERIC_DOC = /[0-9]|[一二三四五六七八九十百千万亿零两]+[万千百十个条行兆元块岁天年月日点时分秒次]/

/**
 * 时间加成：同样命中，新近的往前排（老大 2026-11-18 要的「近期优先」）。
 * 只做微调：今天的条目乘 1.35，三十天前乘 1.13，一年前接近 1.0——
 * 相关性仍然是主项，时间只用来分胜负，不许把无关的旧账顶上来。
 */
const RECENCY_WEIGHT = 0.35
const RECENCY_HALF_LIFE_DAYS = 30
function recencyFactor(time, options) {
  const weight = options.recency === undefined ? RECENCY_WEIGHT : Number(options.recency)
  if (!Number.isFinite(weight) || weight <= 0) return 1
  const stamp = Number(time)
  if (!Number.isFinite(stamp) || stamp <= 0) return 1
  const ageDays = Math.max(0, (Date.now() - stamp) / 86400000)
  return 1 + weight * Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS)
}

/** 「最近 N 天」换算成本地日期字符串（索引里的 d 是本地日期）。 */
function daysAgoDate(days) {
  const date = new Date(Date.now() - Math.max(0, days - 1) * 86400000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 用索引查：BM25 × 少见的词命中了几分 × 时间加成。 */
function searchIndex(query, options, archiveRoot, indexDir, log) {
  const limit = Math.max(1, Math.min(400, Number(options.pool ?? options.limit) || 5))
  let range = options.from !== undefined || options.to !== undefined
    ? { from: options.from, to: options.to }
    : parseQueryTime(String(query), options.now === undefined ? new Date() : new Date(options.now))
  if (range === null && Number(options.days) > 0) range = { from: daysAgoDate(Number(options.days)) }
  const terms = termsOf(query)
  if (terms.length === 0) return { terms, range, scanned: 0, files: 0, hits: [] }
  // 自指过滤（2026-11-20）：问句本身被归档过（题目文件、以前的提问），检索会把它自己翻出来，
  // 看着像命中其实是在复述问题。问句够长（≥10 字）且原样出现在条目里就跳过。
  const rawQuery = String(query).trim()
  const skipSelfRef = rawQuery.length >= 10
  // 块边界会把问句截断，整句对不上，所以再拿开头十二个字对一次。
  const selfPrefix = skipSelfRef ? rawQuery.slice(0, 16) : ''

  if (indexStale(archiveRoot, indexDir) && !rebuilding && options.noRebuild !== true) {
    rebuilding = true
    // 索引旧了：先用旧的答，后台补进去（重建期间不接新活）。
    // 先走增量：只读新落地的归档文件；清单缺失或没底子才退回全量。
    setTimeout(() => {
      try {
        const started = Date.now()
        const added = appendToIndex(archiveRoot, indexDir, log)
        cache = null
        if (added === null) {
          const built = buildIndex(archiveRoot, indexDir, log)
          log(`索引已全量重建：${built.units} 条，用时 ${Math.round((Date.now() - started) / 1000)}s`)
        } else {
          log(`索引已增量更新：追加 ${added.units} 条（${added.added} 个新文件），用时 ${Math.round((Date.now() - started) / 1000)}s`)
        }
      } catch (error) {
        log(`索引更新失败：${error?.message ?? error}`)
      } finally {
        rebuilding = false
      }
    }, 10)
  }

  const { units, lower, df, n, avgLen } = loadIndex(archiveRoot, indexDir)
  const weights = terms.map((term) => idfOf(df.get(term) ?? 0, n))
  const RARE_DF = 800
  const rare = terms.map((term) => (df.get(term) ?? 0) <= RARE_DF)
  const rareTotal = terms.reduce((sum, term, index) => (rare[index] ? sum + weights[index] : sum), 0)
  const wantsNumber = NUMERIC_Q.test(String(query))
  const K1 = 1.2
  const B = 0.75
  /** 工具结果权重：默认 0.3。设 1 就不压，设 0 等于一律不看工具输出。 */
  const TOOL_WEIGHT = options.toolWeight === undefined
    ? Math.max(0, Number(localOverrides().toolWeight ?? 0.3))
    : Math.max(0, Number(options.toolWeight))
  /** 词频封顶：一条里同一个词最多按 8 次算。设 1 就退回「只算有没有出现」的老口径。 */
  const TF_CAP = Math.max(1, Number(process.env.METAB_TF_CAP) || Number(localOverrides().tfCap) || 8)

  const hits = []
  let scanned = 0
  // 语义扩展词：只加分，不算进覆盖率（免得把原来的判断稀释掉）
  const extras = Array.isArray(options.extraTerms) ? options.extraTerms : []
  const extrasWeighted = extras.map((item) => ({ term: item.term, weight: (item.weight ?? 0.5) * idfOf(df.get(item.term) ?? 0, n) }))
  const excluded = Array.isArray(options.excludeFiles) ? new Set(options.excludeFiles) : null
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]
    if (excluded !== null && excluded.has(unit.f)) continue
    if (range !== null) {
      if (range.from !== undefined && unit.d < range.from) continue
      if (range.to !== undefined && unit.d > range.to) continue
    }
    scanned += 1
    const text = lower[index]
    if (skipSelfRef && (unit.x.includes(rawQuery) || unit.x.includes(selfPrefix))) continue
    const lengthNorm = 1 - B + (B * text.length) / avgLen
    let got = 0
    let rareGot = 0
    const matched = []
    for (let k = 0; k < terms.length; k += 1) {
      const at = text.indexOf(terms[k])
      if (at < 0) continue
      // 词频：同一个词出现几次就算几次（封顶 TF_CAP，免得一条工具输出靠堆词霸榜）
      let tf = 0
      for (let pos = at; pos >= 0 && tf < TF_CAP; pos = text.indexOf(terms[k], pos + terms[k].length)) tf += 1
      got += weights[k] * ((tf * (K1 + 1)) / (tf + K1 * lengthNorm))
      matched.push(terms[k])
      if (rare[k]) rareGot += weights[k]
    }
    if (matched.length === 0) {
      let extraGot = 0
      const extraMatched = []
      for (const extra of extrasWeighted) {
        if (!text.includes(extra.term)) continue
        extraGot += extra.weight
        extraMatched.push(extra.term)
      }
      if (extraMatched.length === 0) continue
      const extraNorm = 1 / (1 + K1 * (1 - B + (B * text.length) / avgLen))
      let extraScore = extraGot * (1 + K1) * extraNorm * 0.35
      if (wantsNumber && NUMERIC_DOC.test(unit.x)) extraScore *= 1.35
      extraScore *= recencyFactor(unit.t, options)
      hits.push({
        ...unit,
        index,
        day: unit.d,
        file: unit.f,
        seq: unit.s,
        time: unit.t,
        role: unit.r,
        text: unit.x,
        matched: extraMatched,
        score: extraScore,
      })
      continue
    }
    const rareCoverage = rareTotal > 0 ? rareGot / rareTotal : 1
    let score = got * rareCoverage
    // 工具结果降权（2026-11-20 量出来的）：前十条里 275 条是工具输出，真答案全被挤下去。
    // 全部剔掉后三十道题前五全中，所以按权重压着用，不删——万一答案真在工具输出里还捞得到。
    if (unit.r === '工具') score *= TOOL_WEIGHT
    if (wantsNumber && NUMERIC_DOC.test(unit.x)) score *= 1.35
    score *= recencyFactor(unit.t, options)
    hits.push({
      ...unit,
      index,
      day: unit.d,
      file: unit.f,
      seq: unit.s,
      time: unit.t,
      role: unit.r,
      text: unit.x,
      matched,
      score,
    })
  }
  hits.sort((a, b) => (b.score - a.score) || (b.t - a.t))
  return { terms, range, scanned, files: new Set(units.map((unit) => unit.f)).size, hits: hits.slice(0, limit) }
}

/** 现扫现查：索引还没建好时的退路，慢，但一样能答。 */
export function searchArchive(archiveRoot, query, options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 5))
  let range = options.from !== undefined || options.to !== undefined
    ? { from: options.from, to: options.to }
    : parseQueryTime(String(query), options.now === undefined ? new Date() : new Date(options.now))
  if (range === null && Number(options.days) > 0) range = { from: daysAgoDate(Number(options.days)) }
  const terms = termsOf(query)
  if (terms.length === 0) return { terms, range, scanned: 0, files: 0, hits: [] }
  // 自指过滤（2026-11-20）：问句本身被归档过（题目文件、以前的提问），检索会把它自己翻出来，
  // 看着像命中其实是在复述问题。问句够长（≥10 字）且原样出现在条目里就跳过。
  const rawQuery = String(query).trim()
  const skipSelfRef = rawQuery.length >= 10
  // 块边界会把问句截断，整句对不上，所以再拿开头十二个字对一次。
  const selfPrefix = skipSelfRef ? rawQuery.slice(0, 16) : ''

  const files = filesInRange(archiveRoot, range)
  const hits = []
  let scanned = 0
  for (const entry of files) {
    const units = unitsOfFile(entry.path, entry.day, entry.file)
    scanned += units.length
    for (const unit of units) {
      if (skipSelfRef && (unit.text.includes(rawQuery) || unit.text.includes(selfPrefix))) continue
      const lowered = unit.text.toLowerCase()
      const matched = terms.filter((term) => lowered.includes(term))
      if (matched.length === 0) continue
      const coverage = matched.length / terms.length
      if (coverage < Number(options.minCoverage ?? 0.3)) continue
      hits.push({ ...unit, day: unit.day, file: unit.file, seq: unit.seq, matched, coverage, score: (coverage * 100 + matched.length) * recencyFactor(unit.time, options) })
    }
  }
  hits.sort((a, b) => (b.score - a.score) || (b.time - a.time))
  return { terms, range, scanned, files: files.length, hits: hits.slice(0, limit) }
}

/**
 * 从语义最近的几条原话里拣扩展词：查询里没有的、库里少见的词，按稀有程度加权。
 * 用途是把「虫子」这类问法扩到「蜈蚣」这种当时真说过的词上。
 */
function expansionTermsOf(seed, index, queryTerms, limit) {
  const tally = new Map()
  for (const hit of seed) {
    if (hit.score < 0.42) continue
    const unit = index.units[hit.index]
    if (unit === undefined) continue
    for (const term of termsOf(String(unit.x ?? ''))) {
      if (queryTerms.has(term)) continue
      const df = index.df.get(term) ?? 0
      if (df === 0 || df > 600) continue
      tally.set(term, (tally.get(term) ?? 0) + 1 / (df + 10))
    }
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => ({ term, weight: 0.5 }))
}

/**
 * 把词面结果和向量结果合起来排：两边各按名次给分（倒数名次相加），不看绝对分，
 * 所以 BM25 那边分数量级再大也压不住向量那边的一条「意思近但没对上词」的原话。
 */
async function fuseSemantic(lexical, query, options, dir, archiveRoot, log) {
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 5))
  const units = loadIndex(archiveRoot, dir).units
  if (!vectorsReady(dir, units.length)) return { ...lexical, semantic: false, hits: lexical.hits.slice(0, limit) }

  const workspace = resolve(archiveRoot, '..', '..')
  const [queryVector] = await embedTexts([String(query)], workspace, { query: true, log })
  const { count, matrix } = readVectors(dir)
  const range = lexical.range
  const excluded = Array.isArray(options.excludeFiles) ? new Set(options.excludeFiles) : null
  const inRange = (row) => {
    const unit = units[row]
    if (unit === undefined) return false
    // 工具结果不进向量那一路（2026-11-20 量出来的）：词面那路已经把它压到 0.3，
    // 向量这路要是不管，它又会从后面爬回前排，实测前五反而从 24 掉到 17。
    if (unit.r === '工具') return false
    if (excluded !== null && excluded.has(unit.f)) return false
    if (range === null || range === undefined) return true
    if (range.from !== undefined && unit.d < range.from) return false
    if (range.to !== undefined && unit.d > range.to) return false
    return true
  }

  // 语义扩展：先看意思最近的几条原话，从里头拣查询里没有的少见词，再按词面重排一遍。
  const index = loadIndex(archiveRoot, dir)
  if (options.expand === true) {
    const queryTerms = new Set(termsOf(String(query)))
    const seed = cosineTop(queryVector, matrix, count, { filter: inRange, k: 20 })
    const expansion = expansionTermsOf(seed, index, queryTerms, Number(options.expandLimit ?? 8))
    if (expansion.length > 0) {
      lexical = searchIndex(String(query), { ...options, extraTerms: expansion, pool: options.pool ?? 400 }, archiveRoot, dir, log)
    }
  }

  const pinned = lexical.hits.slice(0, Math.max(0, Math.min(5, Number(options.pinLexical ?? localOverrides().pinLexical ?? 0)))).filter((hit) => hit.index !== undefined)
  const pinnedRows = new Set(pinned.map((hit) => hit.index))

  const ranked = new Map()
  lexical.hits.forEach((hit, rank) => {
    if (hit.index === undefined || pinnedRows.has(hit.index)) return
    ranked.set(hit.index, (ranked.get(hit.index) ?? 0) + RRF_LEXICAL / (RRF_K + rank + 1))
  })

  const cosMin = Number(options.cosMin ?? VECTOR_ONLY_MIN_COS)
  const vectorHits = cosineTop(queryVector, matrix, count, { filter: inRange, k: Math.min(Number(options.vecK ?? 120), count) })
  const vectorRank = new Map()
  vectorHits.forEach((hit) => vectorRank.set(hit.index, hit.score))
  vectorHits.forEach((hit, rank) => {
    if (pinnedRows.has(hit.index)) return
    const already = ranked.has(hit.index)
    if (!already && hit.score < cosMin) return
    ranked.set(hit.index, (ranked.get(hit.index) ?? 0) + RRF_VECTOR / (RRF_K + rank + 1))
  })

  const terms = lexical.terms ?? []
  const rest = [...ranked.entries()]
    .map(([row, score]) => {
      const unit = units[row]
      if (unit === undefined) return null
      if (excluded !== null && excluded.has(unit.f)) return null
      const text = String(unit.x ?? '')
      const lower = text.toLowerCase()
      return {
        ...unit,
        index: row,
        day: unit.d,
        file: unit.f,
        seq: unit.s,
        time: unit.t,
        role: unit.r,
        text,
        matched: terms.filter((term) => lower.includes(term)),
        cos: vectorRank.get(row) ?? null,
        score,
      }
    })
    .filter((hit) => hit !== null)
    .sort((a, b) => (b.score - a.score) || (b.t - a.t))

  const head = pinned.map((hit) => ({ ...hit, cos: vectorRank.get(hit.index) ?? null }))
  return { ...lexical, semantic: true, hits: [...head, ...rest].slice(0, limit) }
}

/** 主检索：有索引走索引，没索引先现扫并顺手建一份；向量在就合着排。 */
export async function search(archiveRoot, query, options = {}, indexDir = undefined, log = () => {}) {
  const dir = indexDir ?? join(archiveRoot, '..', '茅房索引')
  let lexical
  try {
    if (options.noRebuild !== true && indexStale(archiveRoot, dir) && !existsSync(indexPaths(dir).file)) {
      const started = Date.now()
      const built = buildIndex(archiveRoot, dir, log)
      log(`索引首次建好：${built.units} 条，用时 ${Math.round((Date.now() - started) / 1000)}s`)
    }
    lexical = searchIndex(query, { ...options, pool: options.pool ?? 400 }, archiveRoot, dir, log)
  } catch (error) {
    log(`走索引失败，退回现扫：${error?.message ?? error}`)
    return searchArchive(archiveRoot, query, options)
  }
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 5))
  // 要重排就得先把候选捞宽一点：只留 5 条再重排，等于让它在 5 条里换位子，前五永远不变（2026-11-20 踩过）。
  const wantRerank = options.rerank === true || localOverrides().rerank === true
  const poolSize = wantRerank ? Math.max(limit, Number(options.rerankTopN ?? localOverrides().rerankTopN ?? 10)) : limit
  let merged = { ...lexical, semantic: false, hits: lexical.hits.slice(0, poolSize) }
  if (options.semantic === true) {
    try {
      merged = await fuseSemantic(lexical, query, options, dir, archiveRoot, log)
    } catch (error) {
      log(`向量那步没成，只按词面答：${error?.message ?? error}`)
    }
  }
  const out = await applyRerank(merged, query, options, archiveRoot, log)
  return { ...out, hits: out.hits.slice(0, limit) }
}

/**
 * 重排（2026-11-20）：只动前 rerankTopN 条，拿问题和条目拼起来逐条打分，再按分数重排。
 * 实测本机一条 0.7 秒，所以默认只排十条，且失败就按原顺序返回，不能让重排把检索拖死。
 */
async function applyRerank(merged, query, options, archiveRoot, log) {
  const cfg = localOverrides()
  if (options.rerank !== true && cfg.rerank !== true) return merged
  const topN = Math.max(1, Math.min(30, Number(options.rerankTopN ?? cfg.rerankTopN ?? 10)))
  const head = merged.hits.slice(0, topN)
  if (head.length < 2) return merged
  try {
    const started = Date.now()
    const scores = await rerankScores(String(query), head.map((hit) => hit.text), resolve(archiveRoot, '..', '..'), {
      model: options.rerankModel ?? cfg.rerankModel,
      log,
    })
    if (!Array.isArray(scores) || scores.length !== head.length) return merged
    const ranked = head
      .map((hit, index) => ({ hit, score: Number(scores[index]) }))
      .sort((left, right) => right.score - left.score)
      .map((item) => ({ ...item.hit, rerank: item.score }))
    log(`重排：前 ${head.length} 条重打分，用时 ${Math.round((Date.now() - started) / 1000)}s`)
    return { ...merged, rerank: true, hits: [...ranked, ...merged.hits.slice(topN)] }
  } catch (error) {
    log(`重排没成，按原顺序答：${error?.message ?? error}`)
    return merged
  }
}

/** 片段以命中的词为中心，别老是从头截。 */
export function snippetOf(text, matched, size = 400) {
  const flat = String(text).replace(/\s+/g, ' ')
  if (flat.length <= size) return flat
  let at = -1
  const lower = flat.toLowerCase()
  for (const term of matched) {
    const index = lower.indexOf(term)
    if (index >= 0 && (at < 0 || index < at)) at = index
  }
  if (at < 0) return flat.slice(0, size) + '…'
  const start = Math.max(0, at - Math.floor(size * 0.4))
  const end = Math.min(flat.length, start + size)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** 给模型看的结果文本。 */
export function renderHits(result, limit = 5) {
  const scope = result.range === null
    ? '全部日期'
    : `${result.range.from ?? '最早'} 到 ${result.range.to ?? '最新'}`
  if (result.hits.length === 0) {
    return `茅房里没找到（查了 ${result.files} 个文件、${result.scanned} 条话，范围：${scope}）。查询词：${result.terms.join('、') || '（无实词）'}`
  }
  const lines = [`茅房召回到 ${result.hits.length} 条（共查 ${result.files} 个文件、${result.scanned} 条话，范围：${scope}${result.semantic === true ? '，词面+语义' : ''}）`, '']
  result.hits.slice(0, limit).forEach((hit, index) => {
    const time = new Date(hit.time).toLocaleString('zh-CN', { hour12: false })
    const body = snippetOf(hit.text, hit.matched ?? [])
    const cut = hit.text.length > 400 ? `（原文 ${hit.text.length} 字，这里是最相关的一段）` : ''
    lines.push(`${index + 1}. ${hit.day} ${time} · ${hit.role} · 命中 ${(hit.matched ?? []).join('、')}`)
    lines.push(`   ${body}${cut}`)
    lines.push(`   出处：${hit.file} · seq ${hit.seq}`)
  })
  return lines.join('\n')
}

/** 把一段归档原文整段取回来（按 seq 范围，可截断）。 */
export function expandSegment(archiveRoot, options = {}) {
  const day = typeof options.day === 'string' && options.day.length > 0 ? options.day : undefined
  const file = typeof options.file === 'string' && options.file.length > 0 ? options.file : undefined
  const fromSeq = Number.isFinite(Number(options.fromSeq)) ? Number(options.fromSeq) : 0
  const toSeq = Number.isFinite(Number(options.toSeq)) ? Number(options.toSeq) : Number.MAX_SAFE_INTEGER
  const maxChars = Math.max(500, Math.min(200000, Number(options.maxChars) || 20000))
  if (file === undefined) return { found: false, text: '要说清是哪个文件（出处里的 .jsonl 名字）。', pieces: 0 }
  const files = filesInRange(archiveRoot, day === undefined ? null : { from: day, to: day })
  const target = files.find((entry) => entry.file === file)
  if (target === undefined) return { found: false, text: `茅房里没有这个文件：${file}`, pieces: 0 }

  const units = unitsOfFile(target.path, target.day, target.file, Number.MAX_SAFE_INTEGER, false)
  const picked = units.filter((unit) => Number(unit.seq) >= fromSeq && Number(unit.seq) <= toSeq)
  if (picked.length === 0) {
    return { found: false, text: `在那个文件里没找到 seq ${fromSeq}–${toSeq} 的内容（共 ${units.length} 段话）。`, pieces: 0 }
  }
  const parts = []
  let used = 0
  let truncatedAt = null
  for (const unit of picked) {
    const time = new Date(unit.time).toLocaleString('zh-CN', { hour12: false })
    const body = unit.text.replace(/\s+/g, ' ').trim()
    const line = `— ${time} · ${unit.role} · seq ${unit.seq}\n${body}`
    if (used + line.length > maxChars) {
      truncatedAt = unit.seq
      break
    }
    used += line.length
    parts.push(line)
  }
  const head = `原文 ${target.day} / ${target.file} 的 seq ${fromSeq}–${toSeq}，取回 ${parts.length} 段`
  const tail = truncatedAt === null
    ? ''
    : `\n\n（到 seq ${truncatedAt} 为止，剩下的被长度上限截断了；把 fromSeq 收到 ${truncatedAt} 再取一次）`
  return { found: true, text: `${head}\n\n${parts.join('\n\n')}${tail}`, pieces: parts.length }
}

export const name = 'metabolism-recall'
// llm 是骨架工具回填时用来写卡的（不传就报 cannot get property "llm" without inject）
export const inject = ['tools', 'llm']

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description: 'search（默认，按关键词找）或 expand（按出处把整段原文取回来）。',
    },
    query: {
      type: 'string',
      description: '要找的内容，写人话即可；里面带「昨天」「上周」「11月16日」这类时间词会自动收窄日期。search 时必填。',
    },
    from: { type: 'string', description: '起始日期，形如 2026-11-17；不填就是全部。' },
    to: { type: 'string', description: '结束日期，形如 2026-11-17；不填就是全部。' },
    days: { type: 'integer', description: '只捞最近 N 天（1 到 3650）。老大要的「近期优先」：不填就全时段搜，但新近的会天然往前排。' },
    limit: { type: 'integer', description: '返回几条，1 到 20，默认 5。' },
    file: { type: 'string', description: 'expand 时用：出处里的 .jsonl 文件名。' },
    day: { type: 'string', description: 'expand 时用：那个文件所在日期，形如 2026-11-17。' },
    fromSeq: { type: 'integer', description: 'expand 时用：从哪个 seq 开始，默认从头。' },
    toSeq: { type: 'integer', description: 'expand 时用：到哪个 seq 为止，默认到底。' },
    maxChars: { type: 'integer', description: 'expand 时用：最多取回多少字，默认 20000。' },
    semantic: { type: 'boolean', description: 'search 时是否带上语义那一路（意思近的也算命中）。2026-11-18 实测还没超过纯词面，默认关；想试可以把 true 传进来。' },
  },
  required: [],
  additionalProperties: false,
}

const OUTPUT = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '命中的原话片段与出处；没找到时说明查了多少。' },
    hits: { type: 'integer', description: '命中条数。' },
  },
  required: ['text', 'hits'],
  additionalProperties: false,
}

/** 本机覆盖：插件目录里的 本地配置.json（不进包，发布版没有这个文件）。 */
function localOverrides() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./本地配置.json', import.meta.url), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 默认目录：按 profile 目录算，别人装上去也能用到自己家里。 */
function defaultBase(kind) {
  const local = localOverrides()
  const fromLocal = typeof local.archiveRoot === 'string' ? local.archiveRoot.trim() : ''
  if (fromLocal.length > 0) {
    if (kind === 'archive') return fromLocal
    const custom = typeof local.indexDir === 'string' ? local.indexDir.trim() : ''
    return custom.length > 0 ? custom : join(dirname(fromLocal), '茅房索引')
  }
  const fromEnv = typeof process.env.DSH_METABOLISM_HOME === 'string' ? process.env.DSH_METABOLISM_HOME.trim() : ''
  if (fromEnv.length > 0) return kind === 'archive' ? fromEnv : join(dirname(fromEnv), '茅房索引')
  const base = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || homedir()
  return kind === 'archive' ? join(base, '代谢', '茅房') : join(base, '代谢', '茅房索引')
}

export function apply(ctx, config) {
  const archiveRoot = typeof config?.archiveRoot === 'string' && config.archiveRoot.length > 0
    ? config.archiveRoot
    : defaultBase('archive')
  const indexDir = typeof config?.indexDir === 'string' && config.indexDir.length > 0
    ? config.indexDir
    : defaultBase('index')
  const log = (message) => {
    try {
      const logger = ctx.logger
      if (logger && typeof logger.warn === 'function') logger.warn(`metabolism-recall: ${message}`)
    } catch {
      // 日志坏了不影响召回
    }
  }

  const definition = {
    name: 'metabolism_recall',
    description: '在茅房归档里按关键词和日期翻找被压缩掉的原文（用户原话、我说过的话、工具输出），返回片段与出处。压缩把细节换成了一行地址，要用细节时用它捞回来。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT,
      // render 返回的是内容块数组，不是字符串（宿主会在这个数组上做 content.some 检查）
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      const action = String(args?.action ?? 'search').toLowerCase()
      if (action === 'expand') {
        const expanded = expandSegment(archiveRoot, {
          day: args?.day,
          file: args?.file,
          fromSeq: args?.fromSeq,
          toSeq: args?.toSeq,
          maxChars: args?.maxChars,
        })
        return { text: expanded.text, hits: expanded.found ? expanded.pieces : 0 }
      }
      const query = String(args?.query ?? '')
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5))
      const result = await search(archiveRoot, query, {
        limit,
        semantic: args?.semantic === true,
        from: typeof args?.from === 'string' && args.from.length > 0 ? args.from : undefined,
        to: typeof args?.to === 'string' && args.to.length > 0 ? args.to : undefined,
        days: Number.isFinite(Number(args?.days)) && Number(args?.days) > 0 ? Math.min(3650, Number(args.days)) : undefined,
      }, indexDir, log)
      return { text: renderHits(result, limit), hits: result.hits.length }
    },
  }

  if (typeof ctx.tools?.register !== 'function') {
    log('没有 tools 服务，召回工具没挂上')
    return
  }
  ctx.tools.register(definition)

  // 骨架工具同批挂上；它自己挂了也不影响召回
  try {
    skeletonApply(ctx, { archiveRoot })
  } catch (error) {
    log(`骨架工具没挂上：${error?.message ?? error}`)
  }

  // 浮现：默认关，开关.json 里 "浮现": true 才注入
  try {
    morphApply(ctx, { archiveRoot })
  } catch (error) {
    log(`浮现没挂上：${error?.message ?? error}`)
  }

  // 贴条：默认关，开关.json 里 "每轮一条": true 才动
  try {
    attachApply(ctx, { archiveRoot })
  } catch (error) {
    log(`贴条没挂上：${error?.message ?? error}`)
  }
}
