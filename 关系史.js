/**
 * 关系史（2026-11-22）：从压缩段落里抽「我们之间」的关系事件，存成时间线。
 *
 * 职责只到「抽 + 存」。怎么用（蒸馏进画像、常驻注入、聊天时捞）留给记忆插件，
 * 压缩器不掺和消费端。
 *
 * 数据落点：记忆\关系史\时间线.jsonl，一条一行：
 *   { "event": "发生了什么", "mood": "当时什么味", "quote": "原话一句", "at": 毫秒时间戳 }
 *
 * @module dsh-metabolism/关系史
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SYSTEM = [
  '下面是一段对话，每句前面有编号。逐句判断：这句算不算「我们之间」发生的事——吵架、和好、立规矩、改称呼、说重话又道歉、信任还是试探、考我/试探我记不记得、放权还是收权？',
  '技术干活、报错、调试、文档、代码都不算。',
  '算的抽出来，输出一行 JSON：{"event":"发生了什么","mood":"当时什么味","quote":"这句原话"}；不算的跳过。只有真的「我们之间」的事才输出，没有就输出 []。只输出 JSON，不要别的。',
].join('\n')

const MAX_SAMPLE = 6000
const MAX_EVENT = 200
const MAX_QUOTE = 200
const MAX_ENTRIES = 5
/** 每次喂多少句：逐句判断，批太大它也看不过来；60 句一次，调用次数砍一半。 */
const BATCH_SIZE = 60

/** 关系史目录：记忆\关系史（跟茅房同级）。 */
function dirOf(root) {
  return join(root, '..', '关系史')
}

/** 追加几条关系事件，返回写入条数。 */
export function appendRelationship(root, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0
  const dir = dirOf(root)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '时间线.jsonl')
  const now = Date.now()
  const lines = entries.map((entry) => JSON.stringify({
    event: String(entry.event ?? '').slice(0, MAX_EVENT),
    mood: String(entry.mood ?? '').slice(0, 40),
    quote: String(entry.quote ?? '').slice(0, MAX_QUOTE),
    at: Number(entry.at) || now,
  }))
  appendFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return lines.length
}

/** 读最近几条关系事件，给记忆插件/注入用。 */
export function readRelationship(root, limit = 3) {
  const file = join(dirOf(root), '时间线.jsonl')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
  return lines
    .slice(-Math.max(1, limit))
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((entry) => entry !== null)
}

/**
 * 用 flash 从一段文本里抽关系事件。texts 是被压段里「他 / 我」说过的话。
 * callModel(system, user) → 文本。没有 callModel、样本太短、或模型没抽出，都返回空数组。
 */
export async function extractRelationship(texts, callModel, log = () => {}) {
  if (typeof callModel !== 'function' || !Array.isArray(texts) || texts.length === 0) return []
  const entries = []
  // 逐条扫：每批 30 句，让它一句一句判断，夹在技术里的也跑不掉
  for (let at = 0; at < texts.length; at += BATCH_SIZE) {
    const rows = texts.slice(at, at + BATCH_SIZE)
    const user = rows.map((text, i) => `${i + 1}. ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')
    if (user.length < 20) continue
    try {
      const raw = await callModel(SYSTEM, user)
      const text = String(raw ?? '').trim()
      if (text === '' || text === '[]') continue
      for (const line of text.split('\n')) {
        const match = line.match(/\{.*\}/)
        if (match === null) continue
        try {
          const obj = JSON.parse(match[0])
          const event = String(obj.event ?? '').trim()
          if (event.length === 0) continue
          entries.push({
            event: event.slice(0, MAX_EVENT),
            mood: String(obj.mood ?? '').slice(0, 40),
            quote: String(obj.quote ?? '').slice(0, MAX_QUOTE),
          })
        } catch {
          // 一行不是合法 JSON，跳过这条
        }
      }
    } catch (error) {
      log('warn', `关系史抽取失败：${error?.message ?? String(error)}`)
      break
    }
    if (entries.length >= MAX_ENTRIES) break
  }
  return entries.slice(0, MAX_ENTRIES)
}
