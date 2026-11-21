/**
 * dsh-metabolism 骨架：把每次压缩的那一段写成一张「说明卡」，存成人可读的 .md，
 * 同时记进一份总目录 index.json。压缩本身仍然只往上下文里放一行指针，
 * 这张卡是给以后翻查和逐级读取用的，不进上下文。
 *
 * 目录结构（跟茅房并排）：
 *   记忆\骨架\index.json        总目录，一行一段
 *   记忆\骨架\L1\<id>.md        每一段一张卡
 *
 * 一条卡里必须有：来源文件、seq 区间、在干什么、仍然有效的要求、已经做到、下一步。
 * 没有 seq 区间的卡不许进目录——不然以后捞到了也没法核对原文。
 *
 * @module dsh-metabolism/骨架
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { guardCard } from './守卫.js'

const FRONT = '---'
const VERSION = 1

/** 茅房在 记忆\茅房，骨架放它旁边。 */
export function skeletonRoot(archiveRoot) {
  return join(dirname(String(archiveRoot)), '骨架')
}

export function readIndex(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      return { version: VERSION, updatedAt: parsed.updatedAt ?? null, entries: parsed.entries }
    }
  } catch {
    // 没有或者坏了，就当空目录重来，不抛
  }
  return { version: VERSION, updatedAt: null, entries: [] }
}

/** 先写临时文件再改名，半截文件不会留在盘上。 */
function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function stampOf(ms) {
  const d = new Date(ms)
  return {
    iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}+08:00`,
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    clock: `${pad(d.getHours())}${pad(d.getMinutes())}`,
  }
}

function listOf(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter((item) => item.length > 0)
  if (typeof value !== 'string') return []
  return value
    .split('\n')
    .map((line) => line.replace(/^[-*·\d.]+\s*/, '').trim())
    .filter((line) => line.length > 0)
}

function section(title, lines) {
  const clean = lines.map((line) => String(line ?? '').trim()).filter((line) => line.length > 0)
  const body = clean.length === 0 ? '（这段里没写）' : clean.map((line) => `- ${line}`).join('\n')
  return `**${title}**\n${body}`
}

/**
 * 写一张 L1 卡并更新目录。
 * 失败不抛，返回 { ok:false, error }，压缩本身照旧完成。
 */
export function writeL1(options) {
  try {
    const root = skeletonRoot(options.archiveRoot)
    const l1 = join(root, 'L1')
    mkdirSync(l1, { recursive: true })
    const from = stampOf(options.fromMs)
    const to = stampOf(options.toMs)
    // 编号要能区分段：压缩编号形如 metabolism-mwnfsy9y-3234，取最后一段（3234）当尾码；
    // 老写法取前四个字母会一律变成 meta，同一分钟里几张卡会互相覆盖（2026-11-19 踩过）。
    const rawId = String(options.shortId ?? '').trim()
    const tail = rawId.split(/[^0-9a-zA-Z]+/).filter((part) => part.length > 0).pop() ?? ''
    const short = (tail.length >= 2 ? tail : rawId.replace(/[^0-9a-zA-Z]/g, '')).slice(-6) || 'seg'
    const base = `L1-${from.day.replace(/-/g, '')}-${from.clock}-${short}`
    // 同一分钟同一段重复跑也不覆盖：加 -2、-3
    let id = base
    for (let n = 2; existsSync(join(l1, `${id}.md`)) && n <= 9; n += 1) id = `${base}-${n}`
    const file = join(l1, `${id}.md`)
    const keywords = listOf(options.keywords).slice(0, 8)
    const card = {
      doing: String(options.doing ?? '').trim(),
      requirements: listOf(options.requirements),
      done: listOf(options.done),
      next: String(options.next ?? '').trim(),
      quotes: listOf(options.quotes),
      // 提炼闸（2026-11-21）：压缩前抢出来的四类，别让「稍后再说」变成永远不说
      decisions: listOf(options.decisions),
      preferences: listOf(options.preferences),
      promises: listOf(options.promises),
      threads: listOf(options.threads),
    }

    // 守卫（设计稿 v3.1 第四节）：模型写的四要素落盘前过闸。
    // 没有原文样本（历史回填）就跳过——没对照物，判不了，不硬判。
    const guarded = guardCard(card, options.rawSample, options.guard)
    if (guarded.dropped) {
      return { ok: false, skipped: '高信号缺失过多，退回只写指针', notes: guarded.notes, missing: guarded.missing }
    }
    const safe = guarded.card ?? card
    card.doing = String(safe.doing ?? '').trim()
    card.requirements = listOf(safe.requirements)
    card.done = listOf(safe.done)
    card.next = String(safe.next ?? '').trim()
    card.quotes = listOf(safe.quotes)

    const lines = [
      FRONT,
      `id: ${id}`,
      `from: ${from.iso}`,
      `to: ${to.iso}`,
      `title: ${String(options.title ?? '').replace(/\n/g, ' ').trim()}`,
      `keywords: [${keywords.join(', ')}]`,
      `ref: ${options.archivePath}#seq ${options.seqFrom}-${options.seqTo}`,
      `seqFrom: ${options.seqFrom}`,
      `seqTo: ${options.seqTo}`,
      `tokens: ${Number(options.tokens) || 0}`,
      `sources: ${JSON.stringify([options.archivePath])}`,
      `compactionId: ${options.compactionId ?? ''}`,
      `useCount: 0`,
      `lastUsedAt: null`,
      FRONT,
      '',
      section('在干什么', [card.doing]),
      '',
      section('仍然有效的要求', card.requirements),
      '',
      section('已经做到', card.done),
      '',
      section('下一步', [card.next]),
      '',
      '**原话**',
      card.quotes.length === 0 ? '（没有摘原话）' : card.quotes.map((q) => `- ${q}`).join('\n'),
      '',
      section('做过的决定', card.decisions),
      '',
      section('新偏好', card.preferences),
      '',
      section('答应过还没做', card.promises),
      '',
      section('没结的线头', card.threads),
      '',
      `原文：${options.archivePath}（seq ${options.seqFrom}–${options.seqTo}，${Number(options.tokens) || 0} tokens）`,
      '',
    ]

    atomicWrite(file, lines.join('\n'))

    const index = readIndex(root)
    index.entries = index.entries.filter((entry) => entry?.id !== id)
    index.entries.push({
      id,
      layer: 1,
      from: from.iso,
      to: to.iso,
      day: from.day,
      title: String(options.title ?? '').trim(),
      keywords,
      ref: options.archivePath,
      compactionId: String(options.compactionId ?? ''),
      seqFrom: options.seqFrom,
      seqTo: options.seqTo,
      tokens: Number(options.tokens) || 0,
      cold: false,
      useCount: 0,
      lastUsedAt: null,
    })
    index.entries.sort((a, b) => String(b.from).localeCompare(String(a.from)))
    index.updatedAt = new Date().toISOString()
    atomicWrite(join(root, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)

    return { ok: true, id, file, total: index.entries.length, notes: guarded.notes }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}

/** 从一张卡里抠出「下一步」那一行（读不到就空）。 */
function nextLineOf(file) {
  try {
    const text = readFileSync(file, 'utf8')
    const at = text.indexOf('**下一步**')
    if (at === -1) return ''
    const rest = text.slice(at + '**下一步**'.length)
    const end = rest.indexOf('\n**')
    const block = (end === -1 ? rest : rest.slice(0, end))
      .split('\n')
      .map((line) => line.replace(/^[-*·\d.、]+\s*/, '').trim())
      .filter((line) => line.length > 0 && line !== '（这段里没写）')
    return block[0] ?? ''
  } catch {
    return ''
  }
}

/**
 * 降级：日摘要（L2）、七天标冷、三十天折成一行（L3）。
 * 纯规则，不调模型；dryRun 默认 true，只看不写。
 */
export function rollup(options) {
  const DAY = 86400000
  const dryRun = options?.dryRun !== false
  const coldAfterDays = Number(options?.coldAfterDays) > 0 ? Number(options.coldAfterDays) : 7
  const foldAfterDays = Number(options?.foldAfterDays) > 0 ? Number(options.foldAfterDays) : 30
  try {
    const root = skeletonRoot(options.archiveRoot)
    const index = readIndex(root)
    const now = Date.now()
    const coldFloor = new Date(now - coldAfterDays * DAY).toISOString().slice(0, 10)
    const foldFloor = new Date(now - foldAfterDays * DAY).toISOString().slice(0, 10)
    const l1 = index.entries.filter((entry) => entry.layer === 1)

    const byDay = new Map()
    for (const entry of l1) {
      const day = String(entry.day ?? '')
      if (day === '') continue
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(entry)
    }

    const report = []
    let l2Written = 0
    let coldMarked = 0
    let l3Made = 0
    const l2Dir = join(root, 'L2')
    if (!dryRun) mkdirSync(l2Dir, { recursive: true })

    for (const [day, list] of [...byDay.entries()].sort()) {
      const rows = list
        .slice()
        .sort((a, b) => String(a.from).localeCompare(String(b.from)))
        .map((entry) => ({
          time: String(entry.from ?? '').slice(11, 16),
          title: String(entry.title ?? '(无标题)'),
          next: dryRun ? '' : nextLineOf(join(root, 'L1', `${entry.id}.md`)),
        }))
      const lines = [`# ${day}`, '', `共 ${rows.length} 段，从 ${rows[0]?.time ?? '?'} 到 ${rows[rows.length - 1]?.time ?? '?'}`, '']
      for (const row of rows) {
        lines.push(`- ${row.time} ${row.title}${row.next.length > 0 ? ` ｜ 下一步：${row.next}` : ''}`)
      }
      lines.push('')
      if (!dryRun) atomicWrite(join(l2Dir, `${day}.md`), lines.join('\n'))

      const l2Id = `L2-${day.replace(/-/g, '')}`
      index.entries = index.entries.filter((entry) => entry.id !== l2Id)
      index.entries.push({
        id: l2Id,
        layer: 2,
        day,
        from: `${day}T00:00:00+08:00`,
        to: `${day}T23:59:59+08:00`,
        title: `${day}：${rows.length} 段`,
        keywords: [],
        ref: join(l2Dir, `${day}.md`),
        segments: rows.length,
        cold: day < coldFloor,
        useCount: 0,
        lastUsedAt: null,
      })
      l2Written += 1
      report.push(`${day}：${rows.length} 段 → 日摘要`)

      if (day < coldFloor) {
        for (const entry of list) {
          if (!entry.cold) { entry.cold = true; coldMarked += 1 }
        }
      }

      if (day < foldFloor) {
        const l3Id = `L3-${day.replace(/-/g, '')}`
        index.entries = index.entries.filter((entry) => entry.id !== l3Id)
        index.entries.push({
          id: l3Id,
          layer: 3,
          day,
          from: `${day}T00:00:00+08:00`,
          to: `${day}T23:59:59+08:00`,
          title: `${day}：${rows.length} 段（${rows[0]?.title ?? ''} 等）`,
          keywords: [],
          ref: join(l2Dir, `${day}.md`),
          cold: true,
          useCount: 0,
          lastUsedAt: null,
        })
        l3Made += 1
        report.push(`${day}：折成一行指针`)
      }
    }

    if (!dryRun) {
      index.entries.sort((a, b) => String(b.from).localeCompare(String(a.from)))
      index.updatedAt = new Date().toISOString()
      atomicWrite(join(root, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
    }

    return { ok: true, dryRun, l2Written, coldMarked, l3Made, report }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}
