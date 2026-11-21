/**
 * 贴条：设计稿 v3.1 第七节的第二层浮现——每轮最多贴一条。
 *
 * 跟开窗那层分工：
 *   开窗（浮现.js）：一次，把最近两天的目录铺给我看，让我知道「大概有哪些天」。
 *   每轮（这里）：拿老大这句话当查询，命中就贴一条到本轮末尾，告诉「这条跟眼前有关」。
 *
 * 三条硬约束（都是拿钱换来的教训）：
 *   1. 默认关。开关.json 里 "每轮一条": true 才动；改回 false 重启即可。
 *   2. 只在命中时贴，没命中一个字都不加；同一条 20 轮内不重复贴。
 *   3. 单条 ≤ 260 字。宁可少贴，不许把上下文顶起来。
 *
 * 为什么敢每轮动：只在请求末尾追加，前面一个字不改，前缀缓存照样命中。
 * 改写前面的内容才是把缓存打碎的元凶。
 *
 * 入口：由 recall.js 的 apply 顺手带上来。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BUDGET = 260
const COOLDOWN_TURNS = 20
const MIN_COVERAGE = 0.16

/** 读开关；读不到就当关着。BOM 要剥，不然 JSON.parse 直接抛。 */
function flagOn(flagPath, key) {
  try {
    const raw = readFileSync(flagPath, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)?.[key] === true
  } catch {
    return false
  }
}

/**
 * 白话里的虚词：先摘掉再切词，否则「那天」「到底」「有没有」这些会把命中率稀释掉。
 * 2026-11-19 加的——验收第一版十道题，缺的这四道全是虚词把分拉低了。
 */
const STOP_WORDS = [
  '那天', '那次', '那次', '这个', '那个', '这些', '那些', '怎么', '什么', '为什么', '到底',
  '有没有', '是不是', '怎么样', '我们', '你们', '他们', '一个', '一下', '一点', '就是',
  '然后', '还是', '可以', '需要', '现在', '时候', '所以', '但是', '如果', '因为', '已经',
  '没有', '不是', '这样', '那样', '多少', '几个', '哪里', '哪个', '咱们', '一下',
]

/**
 * 把一句话拆成可比对的词：先摘虚词，中文取二字组，英文数字按词。
 * 不追求准，只求快和稳——这是每轮都要跑的东西。
 */
/** 单字里没信息量的那些。其余单字照收——「壳」「账」「线」这种一字就能定住话题。 */
const STOP_CHARS = new Set('的了是在和就都很要会能有没不我你他这那上下里个们到去来说做用把被给对从让但而且或与也又还只再'.split(''))

export function gramsOf(text) {
  let clean = String(text ?? '').toLowerCase()
  for (const word of STOP_WORDS) clean = clean.split(word).join(' ')
  const out = new Set()
  for (const word of clean.match(/[a-z0-9_]{2,}/g) ?? []) out.add(word)
  // {1,} 不是 {2,}：摘掉虚词后常剩下单字（「壳」「账」），那些恰恰最定得住话题
  for (const run of clean.match(/[\u4e00-\u9fa5]{1,}/g) ?? []) {
    for (let at = 0; at + 2 <= run.length; at += 1) out.add(run.slice(at, at + 2))
    for (const char of run) if (!STOP_CHARS.has(char)) out.add(char)
  }
  return [...out]
}

/** 一条卡能被查到的全部文字。 */
function haystackOf(entry) {
  return [
    entry.title,
    ...(Array.isArray(entry.keywords) ? entry.keywords : []),
    entry.next,
    // 逐字原话也参与匹配：题多半是他当时的原话，只有摘要碰不上
    ...(Array.isArray(entry.quotes) ? entry.quotes : []),
  ]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' ')
}

/**
 * 在骨架目录里挑一条最相关的。
 * 只查 L1/L2，不扫原文——每轮都扫原文太贵，这层要的是快。
 */
export function pickOne(entries, query, cooled) {
  const grams = gramsOf(query)
  if (grams.length === 0) return null
  let best = null
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.layer !== 1 && entry.layer !== 2) continue
    // 标了噪音的卡（检查点残渣、Presented、路径当标题那类）不参与，占了位子也答不了话
    if (entry.noise === true) continue
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    if (cooled.has(entry.id)) continue
    const hay = haystackOf(entry).toLowerCase()
    if (hay.length === 0) continue
    let hit = 0
    for (const gram of grams) {
      if (hay.includes(gram)) hit += 1
    }
    if (hit === 0) continue
    const coverage = hit / grams.length
    if (coverage < MIN_COVERAGE) continue
    // 层浅的优先（L1 比 L2 具体），同分取新的
    const score = coverage * 100 + (entry.layer === 1 ? 10 : 0)
    if (best === null || score > best.score) best = { entry, score, coverage }
  }
  return best
}

/** 从卡里抠「下一步」那行。index 里不存这个，命中时才读一次文件。 */
function nextOf(l1Dir, id) {
  try {
    const text = readFileSync(join(l1Dir, `${id}.md`), 'utf8')
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

/** 拼出要贴的那一条。 */
export function blockOf(entry, coverage) {
  const day = String(entry.day ?? '').slice(5)
  const clock = String(entry.from ?? '').slice(11, 16)
  const title = String(entry.title ?? '').trim().slice(0, 60)
  const next = String(entry.next ?? '').trim().slice(0, 60)
  const line = `- ${day} ${clock} ${title}${next.length > 0 ? ` ｜ 下一步：${next}` : ''}`
  const ref = entry.seqFrom !== undefined && entry.seqTo !== undefined
    ? `（原文 seq ${entry.seqFrom}–${entry.seqTo}，要细节调 metabolism_skeleton 或 metabolism_recall）`
    : ''
  const body = [
    '<骨架·回想>',
    '（下面这条来自以前的归档，不是当前对话；只是提个醒，别当成他说的话）',
    line,
    ref,
    '</骨架·回想>',
  ]
    .filter((part) => part.length > 0)
    .join('\n')
  return body.length > BUDGET ? `${body.slice(0, BUDGET)}…\n</骨架·回想>` : body
}

export function apply(ctx, options = {}) {
  const log = (level, message) => {
    try { ctx.logger?.[level]?.(message) } catch { /* 日志失败不抛 */ }
  }
  const archiveRoot = String(options.archiveRoot ?? '')
  if (archiveRoot === '') return
  const skeletonDir = join(archiveRoot, '..', '骨架')
  const flagPath = String(options.flagPath ?? join(archiveRoot, '..', '代谢日志', '开关.json'))
  const cooled = new Map()

  ctx.effect(() => {
    const off = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (decision.kind === 'reject') return decision
        if (!flagOn(flagPath, '每轮一条')) return decision
        if (payload?.step !== 1) return decision

        const session = payload?.agent?.session
        if (session === undefined) return decision

        // 这一轮他说的话：从后往前找最近一条人说的（跳过我们自己注入的）
        let said = ''
        for (let seq = Number(session.seq) - 1; seq >= 0; seq -= 1) {
          const event = session.eventAt(seq)
          if (event === undefined) continue
          if (event.type !== 'user/message') continue
          const kind = String(event.data?.source?.kind ?? '')
          if (kind.startsWith('plugin:') || kind === 'compact-checkpoint') continue
          const blocks = event.data?.content ?? event.data?.message?.content
          if (!Array.isArray(blocks)) continue
          said = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim()
          break
        }
        if (said.length < 4) return decision

        let index
        try {
          index = JSON.parse(readFileSync(join(skeletonDir, 'index.json'), 'utf8').replace(/^\uFEFF/, ''))
        } catch {
          return decision
        }
        const entries = Array.isArray(index?.entries) ? index.entries : []
        if (entries.length === 0) return decision

        const pick = pickOne(entries, said, cooled)
        if (pick === null) return decision

        const agent = payload?.agent
        if (typeof agent?.inject !== 'function') return decision

        // index 里没有「下一步」，命中才去卡里抠一次
        const entry = { ...pick.entry }
        if (entry.layer === 1) {
          const next = nextOf(join(skeletonDir, 'L1'), entry.id)
          if (next.length > 0) entry.next = next
        }
        const block = blockOf(entry, pick.coverage)
        agent.inject({
          id: `metabolism-recall-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: block }],
          source: { kind: 'plugin:metabolism' },
        })
        cooled.set(pick.entry.id, Number(payload?.turn) || 0)
        // 冷却到期就放开
        for (const [id, turn] of cooled) {
          if ((Number(payload?.turn) || 0) - turn >= COOLDOWN_TURNS) cooled.delete(id)
        }
        log('info', `骨架贴条：${pick.entry.id}（命中 ${Math.round(pick.coverage * 100)}%）`)
      } catch (error) {
        log('warn', `骨架贴条失败（不影响这一轮）：${error?.message ?? error}`)
      }
      return decision
    })
    return () => { off?.() }
  })
}

export const inject = []
