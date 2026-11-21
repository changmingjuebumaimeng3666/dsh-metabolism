/**
 * 时间线.js —— 跨天的因果线（2026-11-20 起）。
 *
 * 一条时间线 = 一天一条（或半天一条），写清哪天、发生了什么、我们之间发生了什么、
 * 当时什么味，带 seq 门牌。文件是 jsonl，只追加不改写；错了就再追加一条更正。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 时间线放在茅房上一级：记忆\时间线.jsonl。 */
export function timelineFile(archiveRoot) {
  return join(dirname(archiveRoot), '时间线.jsonl')
}

/** 追加一条；字段按设计稿：date/from/to/title/what/we/feel/topics/anchors/made。
 *  老的写法用 sources/spanFrom/spanTo，这里统一归一成 anchors，跟手工那 22 条对齐。 */
export function appendTimeline(entry, archiveRoot) {
  const file = timelineFile(archiveRoot)
  try {
    const normalized = { ...entry }
    if (!Array.isArray(normalized.anchors)) {
      normalized.anchors = (Array.isArray(normalized.sources) ? normalized.sources : [])
        .map((source) => ({ file: String(source ?? ''), day: normalized.date, fromSeq: normalized.spanFrom, toSeq: normalized.spanTo }))
    }
    delete normalized.sources
    delete normalized.spanFrom
    delete normalized.spanTo
    if (!normalized.id) normalized.id = `L-${String(normalized.date ?? '').replace(/-/g, '')}-${Date.now().toString(36).slice(-4)}`
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(normalized)}\n`, 'utf8')
    return { ok: true, file }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}

/** 读全部条目，按日期倒序（新的在前）；同一天按 to 时间倒序。 */
export function readTimeline(archiveRoot) {
  try {
    if (!existsSync(timelineFile(archiveRoot))) return []
    const entries = readFileSync(timelineFile(archiveRoot), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter((entry) => entry !== null)
    entries.sort((a, b) => {
      const da = `${String(a.date ?? '')} ${String(a.to ?? a.from ?? '00:00')}`
      const db = `${String(b.date ?? '')} ${String(b.to ?? b.from ?? '00:00')}`
      return db.localeCompare(da)
    })
    return entries
  } catch {
    return []
  }
}

/** 某一天是否已经有条目。 */
export function hasTimelineFor(day, archiveRoot) {
  return readTimeline(archiveRoot).some((entry) => String(entry?.date ?? '') === String(day))
}
