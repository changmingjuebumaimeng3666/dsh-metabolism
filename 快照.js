/**
 * 昨天的快照（2026-11-21）：每段结束，给明天的自己写一份小快照——
 * 情绪签名一句（人话，不是数字）、没结的线头几条、最后那句话的原话。
 * 下次开机先读它，一睁眼就知道昨天什么味、话停在哪、什么没办完。
 *
 * 文件：记忆\昨天.json（跟茅房并排）。
 *
 * @module dsh-metabolism/快照
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function snapshotFile(archiveRoot) {
  return join(dirname(String(archiveRoot)), '昨天.json')
}

export function readSnapshot(archiveRoot) {
  try {
    const parsed = JSON.parse(readFileSync(snapshotFile(archiveRoot), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 先写临时文件再改名，半截文件不会留在盘上。 */
function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/**
 * 写一份快照。字段跟 yesterday.json 对齐，但落盘是人话，不是数字。
 * 失败不抛，返回 { ok:false }。
 */
export function writeSnapshot(options) {
  try {
    const file = snapshotFile(options.archiveRoot)
    mkdirSync(dirname(file), { recursive: true })
    const threads = (Array.isArray(options.threads) ? options.threads : [])
      .map((item) => String(item ?? '').trim())
      .filter((item) => item.length > 0)
      .slice(0, 3)
    const snapshot = {
      at: new Date().toISOString(),
      day: String(options.day ?? '').trim(),
      emotional_signature: {
        dominant_mood: String(options.mood ?? '').trim() || '平静',
        emotional_residue: String(options.residue ?? '').trim(),
      },
      open_threads: threads,
      last_words: String(options.lastWords ?? '').trim().slice(0, 50),
      unresolved: String(options.unresolved ?? '').trim(),
    }
    atomicWrite(file, `${JSON.stringify(snapshot, null, 2)}\n`)
    return { ok: true, file, snapshot }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}

/** 渲染成一段自然语言，给开机注入用；没内容就返回空串。 */
export function renderSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return ''
  const sig = snapshot.emotional_signature ?? {}
  const mood = String(sig.dominant_mood ?? '').trim()
  const residue = String(sig.emotional_residue ?? '').trim()
  const threads = Array.isArray(snapshot.open_threads) ? snapshot.open_threads : []
  const lastWords = String(snapshot.last_words ?? '').trim()
  const lines = ['【昨天的我，留给今天的】']
  if (mood !== '' || residue !== '') {
    const moodText = [mood, residue].filter((part) => part !== '').join('——')
    lines.push(`- 那天的味道：${moodText}`)
  }
  if (threads.length > 0) {
    lines.push(`- 没结的线头：${threads.slice(0, 3).join('；')}`)
  }
  if (lastWords !== '') {
    lines.push(`- 话停在这句：${lastWords}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}
