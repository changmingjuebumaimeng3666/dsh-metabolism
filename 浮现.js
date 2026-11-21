/**
 * 浮现：开窗时把「最近两天的日摘要 + 最近几段线索」轻轻送进这一轮，
 * 让我一开窗就知道昨天干到哪，不用等老大先问。
 *
 * 设计约束（三条，都是血的教训）：
 *   1. 默认关。开关.json 里 "浮现": true 才动，出岔子改回 false 重启即可。
 *   2. 只在 turn===1 且 step===1 注入一次，不每轮回注——每轮都塞会把前缀搅乱、缓存全失效。
 *   3. 总量封顶 1400 字。宁可少说，不许把上下文顶起来。
 *
 * 入口：由 recall.js 的 apply 顺手带上来（跟骨架工具一样，不单列补丁条目）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readTimeline } from './时间线.js'

const BUDGET = 1400

const readTile = (file) => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 开关在 记忆\代谢日志\开关.json；读不到就当关着。 */
function morphEnabled(flagPath) {
  try {
    // 记事本/Out-File 写的 JSON 常带 BOM，JSON.parse 会直接抛，先剥掉
    const raw = readFileSync(flagPath, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return parsed?.浮现 === true
  } catch {
    return false
  }
}

/** 从日摘要里抽「这一天的骨架」：标题行 + 头几条 + 最后几条。 */
function condenseDay(text, limit) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // 这几类是压缩检查点和工具结果的残渣，摆上去只是噪音
    .filter((line) => !/^# /.test(line))
    .filter((line) => !/automatically generated check/i.test(line))
    .filter((line) => !line.includes('<path>') && !line.includes('</path>'))
    .filter((line) => !/^-\s*\d{1,2}:\d{2}\s*(Presented|Read|Write|Listed|Edited)\b/.test(line))
  if (lines.length === 0) return ''
  const head = lines.slice(0, Math.min(5, lines.length))
  const tail = lines.length > 9 ? lines.slice(-3) : []
  const picked = head.concat(tail.length > 0 ? ['…'] : [], tail)
  const body = picked.join('\n')
  return body.length > limit ? `${body.slice(0, limit)}…` : body
}

/** 攒出这一轮要送的文字。 */
function composeBlock(skeletonDir, archiveRoot, now = Date.now()) {
  // 最近三条时间线：只给日期加一行标题，让我一开窗就知道这几天在走哪条路
  const timeline = readTimeline(archiveRoot).slice(0, 3)
  const parts = ['<骨架·开窗>', '这是本地骨架上最近两天的摘要，供接头用；细节要翻再调 metabolism_skeleton。']
  let used = parts.join('\n').length
  if (timeline.length > 0) {
    const tlBlock = ['<时间线·最近>', ...timeline.map((entry) => `${entry.date ?? '?'} ${entry.title ?? ''}`.trim()), '</时间线·最近>'].join('\n')
    parts.push(tlBlock)
    used += tlBlock.length
  }
  const days = []
  for (let back = 0; back <= 1; back += 1) {
    const d = new Date(now - back * 86400000)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const text = readTile(join(skeletonDir, 'L2', `${day}.md`))
    if (text.length > 0) days.push({ day, text })
  }
  for (const item of days) {
    const chunk = condenseDay(item.text, Math.min(600, BUDGET - used - 60))
    if (chunk.length === 0) continue
    parts.push(`【${item.day}】\n${chunk}`)
    used += chunk.length + 20
    if (used >= BUDGET) break
  }
  if (timeline.length === 0 && days.length === 0) return ''
  parts.push('</骨架·开窗>')
  const block = parts.join('\n')
  return block.length > BUDGET ? `${block.slice(0, BUDGET)}…\n</骨架·开窗>` : block
}

export function apply(ctx, options = {}) {
  const log = (level, message) => {
    try { ctx.logger?.[level]?.(message) } catch { /* 日志失败不抛 */ }
  }
  const archiveRoot = String(options.archiveRoot ?? '')
  if (archiveRoot === '') return
  const skeletonDir = join(archiveRoot, '..', '骨架')
  const flagPath = String(options.flagPath ?? join(archiveRoot, '..', '代谢日志', '开关.json'))
  const sessionSeen = new Set()

  ctx.effect(() => {
    const off = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (decision.kind === 'reject') return decision
        if (!morphEnabled(flagPath)) return decision
        if (payload?.step !== 1) return decision
        const agent = payload?.agent
        const sessionId = String(agent?.session?.id ?? agent?.id ?? '')
        if (sessionId === '' || sessionSeen.has(sessionId)) return decision
        const block = composeBlock(skeletonDir, archiveRoot)
        if (block.length === 0) return decision
        if (typeof agent?.inject !== 'function') return decision
        sessionSeen.add(sessionId)
        agent.inject({
          id: `metabolism-morph-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: block }],
          source: { kind: 'plugin:metabolism' },
        })
        log('info', `骨架浮现：送进 ${block.length} 字（turn ${payload?.turn ?? '?'}）`)
      } catch (error) {
        log('warn', `骨架浮现失败（不影响这一轮）：${error?.message ?? error}`)
      }
      return decision
    })
    return () => { off?.() }
  })
}

export const inject = []
