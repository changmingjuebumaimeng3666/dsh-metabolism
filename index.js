/**
 * dsh-metabolism v1 — 茅房归档器.
 *
 * The DSH Web profile mounts its real compaction backend inside the Agent preset
 * (`compaction` group, isolated service), not on the host plane. So this plugin
 * does not try to own `ctx.compaction`: it sits on the host plane as a reader of
 * the session log and, every time a compaction commits, copies the raw events of
 * the shadowed span to `记忆\茅房\<日期>\` together with the summary the model saw.
 *
 * Contract used (see @deepseek-ai/dsh-compaction/src/types.ts):
 *   compaction/start   { compactionId, turn }
 *   compaction/summary { compactionId, summary, shadowedRange, shadowedSeqs, shadowedTokenCount }
 *   compaction/end     { compactionId, turn, error? }   // error ⇒ failed attempt, nothing archived
 *
 * @module dsh-metabolism
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Dedupe survives an HMR reload of this module. */
const SEEN = globalThis[Symbol.for('dsh-metabolism.seen')] ??= new Set()
/** One write queue for the whole process, so index.md never interleaves. */
const QUEUE = globalThis[Symbol.for('dsh-metabolism.queue')] ??= { tail: Promise.resolve() }

/** 本机覆盖：插件目录里的 本地配置.json（不进包，发布版没有这个文件）。 */
function localOverrides() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./本地配置.json', import.meta.url), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 默认归档目录：别人的机器上没有老大的 D 盘路径，按 profile 目录算。 */
function defaultArchiveRoot() {
  const local = localOverrides()
  const fromLocal = typeof local.archiveRoot === 'string' ? local.archiveRoot.trim() : ''
  if (fromLocal.length > 0) return fromLocal
  const fromEnv = typeof process.env.DSH_METABOLISM_HOME === 'string' ? process.env.DSH_METABOLISM_HOME.trim() : ''
  if (fromEnv.length > 0) return fromEnv
  const base = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || homedir()
  return join(base, '代谢', '茅房')
}

/** No schema dependency: the loader passes the patch's config through untouched. */
function resolveConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const root = typeof source.archiveRoot === 'string' && source.archiveRoot.trim().length > 0
    ? source.archiveRoot.trim()
    : defaultArchiveRoot()
  const minTokens = Number(source.minTokens)
  return {
    enabled: source.enabled !== false,
    archiveRoot: root,
    minTokens: Number.isFinite(minTokens) && minTokens > 0 ? Math.floor(minTokens) : 0,
  }
}

export function apply(ctx, config) {
  const options = resolveConfig(config)

  const log = (level, message) => {
    const logger = ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  }

  ctx.on('session/event', (session, event) => {
    if (!options.enabled) return
    if (event?.type !== 'compaction/end') return
    // A failed attempt leaves an error and no summary: archive nothing (红线).
    if (event.data?.error !== undefined) return

    const summary = findSummary(session, event)
    if (summary === undefined) {
      log('warn', 'metabolism: compaction/end without a matching compaction/summary; nothing archived')
      return
    }

    const compactionId = String(summary.data.compactionId)
    if (SEEN.has(compactionId)) return
    SEEN.add(compactionId)

    const shadowedTokenCount = Number(summary.data.shadowedTokenCount) || 0
    if (shadowedTokenCount < options.minTokens) return

    // Snapshot the raw events now, while the session is definitely alive.
    const seqs = Array.isArray(summary.data.shadowedSeqs) ? summary.data.shadowedSeqs : []
    const events = []
    for (const seq of seqs) {
      const shadowed = session.eventAt(seq)
      if (shadowed !== undefined) events.push(shadowed)
    }
    if (events.length === 0) {
      log('warn', `metabolism: compaction ${compactionId} shadowed no readable events; nothing archived`)
      return
    }

    const payload = {
      compactionId,
      endedAt: event.time,
      shadowedTokenCount,
      shadowedRange: summary.data.shadowedRange,
      summaryText: summaryTextOf(summary.data.summary),
      summaryModel: [summary.data.provider, summary.data.model].filter(Boolean).join(' / '),
      events,
    }

    QUEUE.tail = QUEUE.tail
      .then(() => archive(options.archiveRoot, payload))
      .then((written) => {
        log('info', `metabolism: archived ${events.length} events (${shadowedTokenCount} tokens) to ${written}`)
      })
      .catch((error) => {
        log('warn', `metabolism: archive failed for ${compactionId}: ${error?.message ?? String(error)}`)
      })
  })
}

/** Newest compaction/summary for this compactionId, bounded to the tail. */
function findSummary(session, endEvent) {
  const compactionId = endEvent.data?.compactionId
  const endSeq = Number(endEvent.seq)
  const floor = Math.max(0, endSeq - 32)
  for (let seq = endSeq - 1; seq >= floor; seq -= 1) {
    const candidate = session.eventAt(seq)
    if (candidate === undefined) continue
    if (candidate.type === 'compaction/summary' && candidate.data?.compactionId === compactionId) return candidate
    if (candidate.type === 'compaction/start') return undefined
  }
  return undefined
}

function summaryTextOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
    .trim()
}

const pad = (value) => String(value).padStart(2, '0')

function dayKey(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function clockKey(ms) {
  const date = new Date(ms)
  return `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function clockText(ms) {
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatTokens(count) {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万`
  return String(count)
}

function firstLine(text, limit) {
  const lines = String(text).split('\n').map((part) => part.trim()).filter((part) => part.length > 0)
  const pick = lines.find((line) => !line.startsWith('#')) ?? (lines[0] ?? '').replace(/^#+\s*/, '')
  const line = pick.length > 0 ? pick : '(无摘要)'
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/** Write one archive triple: raw jsonl + summary md + index line. */
async function archive(root, payload) {
  const { events, compactionId, shadowedTokenCount, summaryText } = payload
  const endedAt = typeof payload.endedAt === 'number' ? payload.endedAt : Date.now()
  const times = events.map((event) => Number(event.time)).filter((time) => Number.isFinite(time))
  const startedAt = times.length > 0 ? Math.min(...times) : endedAt
  const finishedAt = times.length > 0 ? Math.max(...times) : endedAt

  const directory = join(root, dayKey(endedAt))
  await mkdir(directory, { recursive: true })

  const shortId = compactionId.replace(/[^0-9a-zA-Z-]/g, '') || 'unknown'
  // 跟压缩器同一套命名：整个压缩编号就是文件名，摘要里那行地址才对得上
  const base = shortId

  const rawName = await writeUnique(directory, base, '.jsonl', () =>
    events.map((event) => JSON.stringify({ seq: event.seq, type: event.type, time: event.time, data: event.data })).join('\n') + '\n')

  const summaryName = `${rawName.slice(0, -'.jsonl'.length)}.summary.md`
  await writeFile(
    join(directory, summaryName),
    [
      `# 压缩摘要 ${clockText(endedAt)}`,
      '',
      `- 压缩编号：${compactionId}`,
      `- 覆盖时间：${clockText(startedAt)} – ${clockText(finishedAt)}`,
      `- 原文：${rawName}`,
      `- 事件条数：${events.length}`,
      `- 折算 tokens：${shadowedTokenCount}`,
      `- 摘要模型：${payload.summaryModel || '(未记录)'}`,
      '',
      summaryText.length > 0 ? summaryText : '(这一段没有留下摘要正文)',
      '',
    ].join('\n'),
    'utf8',
  )

  const indexPath = join(directory, 'index.md')
  let existing = ''
  try {
    existing = await readFile(indexPath, 'utf8')
  } catch {
    existing = ''
  }
  if (existing === '') {
    existing = [
      `# 茅房 ${dayKey(endedAt)}`,
      '',
      '> 每行一段被压掉的原文。`.jsonl` 是宿主会话事件的原文备份，`.summary.md` 是当时模型拿到的摘要。',
      '> 要回看细节：先看 index 找时间，再开对应 jsonl 搜关键词。',
      '',
      '',
    ].join('\n')
  }
  const line = `- ${clockText(startedAt)}–${clockText(finishedAt)} ｜ ${events.length} 条 ｜ 约 ${formatTokens(shadowedTokenCount)} tokens ｜ ${rawName} ｜ ${firstLine(summaryText, 60)}\n`
  await writeFile(indexPath, existing + line, 'utf8')

  return join(directory, rawName)
}

/** Never overwrite an existing archive file; add -2, -3 on collision. */
async function writeUnique(directory, base, extension, render) {
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const name = attempt === 1 ? `${base}${extension}` : `${base}-${attempt}${extension}`
    try {
      await writeFile(join(directory, name), render(), { encoding: 'utf8', flag: 'wx' })
      return name
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error(`cannot find a free archive name for ${base}${extension}`)
}
