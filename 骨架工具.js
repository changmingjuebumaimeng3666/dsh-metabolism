/**
 * dsh-metabolism 骨架工具：把「说明卡」按档位给出来，不一次倒全文。
 *
 * 四档（越往后越费上下文，按需爬）：
 *   clue      一行：日期＋标题＋关键词＋id            （几十字）
 *   brief     卡片里的四样，不带原话                （两三百字）
 *   full      整张卡，含原话摘录                    （一千字上下）
 *   evidence  回茅房读原文，按 seq 区间切           （最多几千字）
 *
 * 只读，不写任何东西；写卡由 engine 在压缩时顺手做。
 *
 * @module dsh-metabolism/骨架工具
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readIndex, rollup, skeletonRoot, writeL1 } from './骨架.js'

/** 本机覆盖：插件目录里的 本地配置.json（不进包，发布版没有这个文件）。 */
function localOverrides() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./本地配置.json', import.meta.url), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function defaultArchiveRoot() {
  const local = localOverrides()
  const fromLocal = typeof local.archiveRoot === 'string' ? local.archiveRoot.trim() : ''
  if (fromLocal.length > 0) return fromLocal
  const fromEnv = typeof process.env.DSH_METABOLISM_HOME === 'string' ? process.env.DSH_METABOLISM_HOME.trim() : ''
  if (fromEnv.length > 0) return fromEnv
  const base = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || homedir()
  return join(base, '代谢', '茅房')
}

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description: 'list（默认，看目录线索）、show（按 id 取某一档内容）或 rebuild（从茅房回填历史卡片，默认空跑）。',
    },
    id: { type: 'string', description: 'show 时必填：卡片 id，形如 L1-20261119-1528-3234。' },
    level: {
      type: 'string',
      description: 'show 的档位：clue 一行 / brief 四样不带原话（默认）/ full 整张卡 / evidence 回茅房读原文。',
    },
    limit: { type: 'integer', description: 'list 返回几条，1 到 30，默认 10。' },
    days: { type: 'integer', description: 'list 只看最近 N 天，1 到 3650；不填就全部。' },
    query: { type: 'string', description: 'list 时按关键词过滤标题与关键词（可选）。' },
    maxChars: { type: 'integer', description: 'evidence 最多取回多少字，默认 4000。' },
    dryRun: { type: 'boolean', description: 'rebuild 时是否只出报告不写卡（默认 true；要真写必须显式传 false）。' },
    limit: { type: 'integer', description: 'list 返回几条，1 到 30，默认 10；rebuild 一次最多写几张，默认 10。' },
    from: { type: 'string', description: 'rebuild 时只回填这个日期（含）之后的，形如 2026-11-17。' },
  },
  required: [],
  additionalProperties: false,
}

const OUTPUT = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '目录线索或某一档内容；没有时说明查了什么。' },
    hits: { type: 'integer', description: '返回条数。' },
  },
  required: ['text', 'hits'],
  additionalProperties: false,
}

function clockOf(iso) {
  const match = String(iso).match(/T(\d{2}:\d{2})/)
  return match === null ? '' : match[1]
}

function dayOf(iso) {
  return String(iso).slice(0, 10)
}

function clueOf(entry) {
  const span = `${clockOf(entry.from)}–${clockOf(entry.to)}`
  const words = Array.isArray(entry.keywords) && entry.keywords.length > 0 ? ` ｜ ${entry.keywords.join('、')}` : ''
  return `${entry.day} ${span} ｜ ${entry.title || '(无标题)'}${words} ｜ ${entry.id}`
}

/** 把一张卡切成「不带原话」的简要版：去掉开头那截元数据，也去掉原话。 */
function briefOf(text) {
  let body = text
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end !== -1) body = body.slice(end + 4)
  }
  const marker = '**原话**'
  const cut = body.indexOf(marker)
  const trimmed = (cut === -1 ? body : body.slice(0, cut)).trim()
  return `${trimmed}\n（原话与出处省略，要就看 full）`
}

/** 回茅房按 seq 区间读原文。 */
function evidenceOf(entry, maxChars) {
  const file = String(entry.ref ?? '')
  if (file.length === 0) return { text: '这张卡没记原文路径', hits: 0 }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { text: `原文读不到：${file}（${error?.message ?? error}）`, hits: 0 }
  }
  const from = Number(entry.seqFrom)
  const to = Number(entry.seqTo)
  const kept = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const seq = Number(event?.seq)
    if (Number.isFinite(from) && seq < from) continue
    if (Number.isFinite(to) && seq > to) continue
    const blocks = event?.data?.content ?? event?.data?.message?.content
    const text = Array.isArray(blocks)
      ? blocks.filter((block) => block?.type === 'text').map((block) => block.text).join(' ')
      : ''
    const who = event?.type === 'user/message' ? '老大' : event?.type === 'assistant/message' ? '我' : event?.type ?? '?'
    const body = text.trim().length > 0 ? text.trim().replace(/\s+/g, ' ') : `(${event?.type})`
    kept.push(`${seq} ${who}：${body.slice(0, 600)}`)
  }
  if (kept.length === 0) return { text: `这个区间里没有可读的文字（seq ${from}–${to}）`, hits: 0 }
  let out = ''
  let used = 0
  for (const line of kept) {
    if (used + line.length > maxChars) { out += '\n…（还有更多，调大 maxChars 或缩小 seq 区间）'; break }
    out += `${line}\n`
    used += line.length
  }
  return { text: `原文 ${file}（seq ${from}–${to}）\n${out}`, hits: kept.length }
}

/** 回填用的提示词：只要四样＋关键词＋原话，别写别的。 */
const REBUILD_SYSTEM = [
  '你在给一段过去的对话写「说明卡」，以后别人只看这张卡，不会再看原文。',
  '请按下面的格式输出，每一块都要有：',
  '【短】一行三十字以内，说清这段在干什么',
  '【在干什么】一到三行',
  '【仍然有效的要求】一行一条，来自用户原话里的约束；没有就写「无」',
  '【已经做到】一行一条；没有就写「无」',
  '【下一步】一行',
  '【关键词】三到八个词，逗号隔开',
  '【原话】三到五条原文摘录，一行一条，每条不超过六十字；没有就写「无」',
  '规矩：只写这段里真有的，不补不猜；拿不准写「不清楚」。',
].join('\n')

const LABELS = ['短', '在干什么', '仍然有效的要求', '已经做到', '下一步', '关键词', '原话']

/** 抠出【标签】之间的内容。 */
function blockOf(text, label) {
  const start = text.indexOf(`【${label}】`)
  if (start === -1) return null
  const bodyStart = start + label.length + 2
  let end = text.length
  for (const other of LABELS) {
    if (other === label) continue
    const at = text.indexOf(`【${other}】`, bodyStart)
    if (at !== -1 && at < end) end = at
  }
  const body = text.slice(bodyStart, end).trim()
  return body.length === 0 ? null : body
}

function lineList(block) {
  if (block === null) return []
  return block
    .split('\n')
    .map((line) => line.replace(/^[-*·\d.、]+\s*/, '').trim())
    .filter((line) => line.length > 0 && line !== '无' && line !== '（无）')
}

function wordList(block) {
  if (block === null) return []
  return block
    .split(/[,，、\s]+/)
    .map((word) => word.replace(/[（）()【】\[\]「」]/g, '').trim())
    .filter((word) => word.length > 0)
    .slice(0, 8)
}

/** 茅房里能回填的原文文件：跳过 dropped 转储与超大整包。 */
function archiveFiles(archiveRoot) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) { walk(full); continue }
      if (!name.endsWith('.jsonl')) continue
      if (name === 'dropped.jsonl') continue
      if (st.size > 12 * 1024 * 1024) continue
      out.push({ file: full, day: dir.split(/[\\/]/).pop(), name, size: st.size })
    }
  }
  walk(archiveRoot)
  out.sort((a, b) => `${a.day}/${a.name}`.localeCompare(`${b.day}/${b.name}`))
  return out
}

/** 从一段原文里拼出发给模型看的样本（只取人说的话，工具结果不进）。 */
function sampleOf(file, maxChars) {
  const events = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const blocks = event?.data?.content ?? event?.data?.message?.content
    if (!Array.isArray(blocks)) continue
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim()
    if (text.length === 0) continue
    const who = event?.type === 'user/message' ? '老大' : '我'
    events.push({ seq: Number(event?.seq), time: Number(event?.time), who, text })
  }
  if (events.length === 0) return null
  const seqs = events.map((e) => e.seq).filter(Number.isFinite)
  const times = events.map((e) => e.time).filter(Number.isFinite)
  const body = []
  let used = 0
  for (const event of events) {
    const cut = event.text.slice(0, 400)
    if (used + cut.length > maxChars) break
    used += cut.length
    body.push(`${event.who}：${cut}`)
  }
  return {
    text: body.join('\n'),
    seqFrom: seqs.length > 0 ? Math.min(...seqs) : undefined,
    seqTo: seqs.length > 0 ? Math.max(...seqs) : undefined,
    fromMs: times.length > 0 ? Math.min(...times) : Date.now(),
    toMs: times.length > 0 ? Math.max(...times) : Date.now(),
    count: events.length,
  }
}

async function writeCard(ctx, archiveRoot, model, sample, file, title) {
  const parts = []
  const stream = ctx.llm.stream({
    provider: model.provider,
    model: model.model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: REBUILD_SYSTEM }] },
      { role: 'user', content: [{ type: 'text', text: sample.text }] },
    ],
    maxTokens: 1200,
    purpose: 'compaction',
  })
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
    if (chunk?.type === 'finish' && chunk.error !== undefined && chunk.error !== null) {
      throw new Error(String(chunk.error?.message ?? chunk.error))
    }
  }
  const text = parts.join('').trim()
  if (text.length === 0) throw new Error('模型没回内容')
  const card = {
    doing: blockOf(text, '在干什么') ?? '',
    requirements: lineList(blockOf(text, '仍然有效的要求')),
    done: lineList(blockOf(text, '已经做到')),
    next: blockOf(text, '下一步') ?? '',
    keywords: wordList(blockOf(text, '关键词')),
    quotes: lineList(blockOf(text, '原话')),
  }
  const short = blockOf(text, '短')
  return writeL1({
    archiveRoot,
    fromMs: sample.fromMs,
    toMs: sample.toMs,
    shortId: file.split(/[\\/]/).pop().replace(/\.jsonl$/, ''),
    title: (short ?? title).slice(0, 60),
    keywords: card.keywords,
    doing: card.doing,
    requirements: card.requirements,
    done: card.done,
    next: card.next,
    quotes: card.quotes,
    archivePath: file,
    seqFrom: sample.seqFrom,
    seqTo: sample.seqTo,
    tokens: Math.round((sample.text?.length ?? 0) / 2.2),
    compactionId: file.split(/[\\/]/).pop().replace(/\.jsonl$/, ''),
  })
}

export function apply(ctx, config) {
  const archiveRoot = typeof config?.archiveRoot === 'string' && config.archiveRoot.length > 0
    ? config.archiveRoot
    : defaultArchiveRoot()
  const root = skeletonRoot(archiveRoot)
  const log = (message) => {
    try {
      const logger = ctx.logger
      if (logger && typeof logger.warn === 'function') logger.warn(`metabolism-skeleton: ${message}`)
    } catch {
      // 日志坏了不影响只读
    }
  }

  const definition = {
    name: 'metabolism_skeleton',
    description: '看「骨架」目录：每次压缩留下的说明卡（在干什么／哪些要求还算数／做到哪／下一步＋原话）。list 看线索，show 按档位取内容，evidence 再回茅房翻原文。比 recall 更省：不用你想起关键词。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      const action = String(args?.action ?? 'list').toLowerCase()
      const index = readIndex(root)

      if (action === 'show') {
        const id = String(args?.id ?? '').trim()
        if (id.length === 0) return { text: '要给 id，先用 action=list 看目录', hits: 0 }
        const entry = index.entries.find((item) => item?.id === id)
        if (entry === undefined) return { text: `目录里没有 ${id}`, hits: 0 }
        const level = String(args?.level ?? 'brief').toLowerCase()
        if (level === 'clue') return { text: clueOf(entry), hits: 1 }
        if (level === 'evidence') {
          const maxChars = Math.max(500, Math.min(20000, Number(args?.maxChars) || 4000))
          return evidenceOf(entry, maxChars)
        }
        let card
        try {
          card = readFileSync(join(root, 'L1', `${id}.md`), 'utf8')
        } catch (error) {
          return { text: `卡片文件读不到：${error?.message ?? error}`, hits: 0 }
        }
        return { text: level === 'full' ? card : briefOf(card), hits: 1 }
      }

      if (action === 'rollup') {
        const dryRun = args?.dryRun !== false
        const result = rollup({
          archiveRoot,
          dryRun,
          coldAfterDays: args?.coldAfterDays,
          foldAfterDays: args?.foldAfterDays,
        })
        if (result.ok !== true) return { text: `降级失败：${result.error}`, hits: 0 }
        const head = dryRun ? '空跑（没写任何文件）：' : '已写：'
        const body = result.report.length > 0 ? result.report.join('\n') : '（没有可降级的段）'
        return {
          text: `${head}\n${body}\n\n日摘要 ${result.l2Written} 个，标冷 ${result.coldMarked} 段，折指针 ${result.l3Made} 个。`,
          hits: result.l2Written,
        }
      }

      if (action === 'rebuild') {
        const dryRun = args?.dryRun !== false
        const limit = Math.max(1, Math.min(30, Number(args?.limit) || 10))
        const floor = typeof args?.from === 'string' && args.from.length > 0 ? args.from : ''
        const done = new Set(
          index.entries
            .map((entry) => {
              if (entry?.compactionId) return String(entry.compactionId)
              // 老卡没记 compactionId，就从原文路径的文件名倒推
              return typeof entry?.ref === 'string' && entry.ref.length > 0
                ? entry.ref.split(/[\\/]/).pop().replace(/\.jsonl$/, '')
                : ''
            })
            .filter((key) => key.length > 0),
        )
        const all = archiveFiles(archiveRoot).filter((item) => floor === '' || item.day >= floor)
        const todo = all.filter((item) => !done.has(item.name.replace(/\.jsonl$/, '')))
        if (todo.length === 0) return { text: '茅房里的段都已经有卡了', hits: 0 }

        if (dryRun) {
          const picked = todo.slice(0, limit)
          const lines = [`待回填 ${todo.length} 段，这次最多处理 ${picked.length} 段（空跑，不写卡）：`]
          for (const item of picked) {
            const sample = sampleOf(item.file, 6000)
            if (sample === null) { lines.push(`- ${item.day}/${item.name} ｜ 没有可摘的文字，跳过`); continue }
            const head = sample.text.split('\n')[0]?.slice(0, 46) ?? ''
            lines.push(`- ${item.day}/${item.name} ｜ seq ${sample.seqFrom}–${sample.seqTo} ｜ ${sample.count} 条 ｜ 约 ${Math.round(sample.text.length / 2.2)} tokens ｜ ${head}`)
          }
          lines.push('')
          lines.push('要真写，再调一次，带 dryRun=false。')
          return { text: lines.join('\n'), hits: picked.length }
        }

        if (typeof ctx.llm?.stream !== 'function') {
          return { text: '这一轮拿不到模型（ctx.llm 不在），先不写', hits: 0 }
        }
        const local = localOverrides()
        const model = {
          provider: typeof local.summaryProvider === 'string' && local.summaryProvider.length > 0 ? local.summaryProvider : 'deepseek-account',
          model: typeof local.summaryModel === 'string' && local.summaryModel.length > 0 ? local.summaryModel : 'deepseek-flash',
        }
        const lines = []
        let written = 0
        let failed = 0
        for (const item of todo.slice(0, limit)) {
          const sample = sampleOf(item.file, 6000)
          if (sample === null) { lines.push(`跳过 ${item.day}/${item.name}：没有可摘的文字`); continue }
          try {
            const card = await writeCard(ctx, archiveRoot, model, sample, item.file, item.name)
            if (card?.ok) { written += 1; lines.push(`写好 ${card.id}`) }
            else { failed += 1; lines.push(`失败 ${item.name}：${card?.error ?? '未知'}`) }
          } catch (error) {
            const message = String(error?.message ?? error)
            // 模型对极短的段常常什么都不回：不空着，用原文首句落一张最薄的卡，标清楚是兜底
            if (message.includes('模型没回内容')) {
              const firstLine = sample.text.split('\n').find((line) => line.trim().length > 0) ?? ''
              const thin = writeL1({
                archiveRoot,
                fromMs: sample.fromMs,
                toMs: sample.toMs,
                shortId: item.name.replace(/\.jsonl$/, ''),
                compactionId: item.name.replace(/\.jsonl$/, ''),
                title: firstLine.replace(/^\S+?：/, '').slice(0, 40) || item.name,
                keywords: [],
                doing: `（模型没回内容，按原文首句兜底）${firstLine.replace(/^\S+?：/, '').slice(0, 120)}`,
                requirements: [],
                done: [],
                next: '（这段太短，没留下明确的下一步）',
                quotes: sample.text.split('\n').filter((line) => line.trim().length > 0).slice(0, 3),
                archivePath: item.file,
                seqFrom: sample.seqFrom,
                seqTo: sample.seqTo,
                tokens: Math.round((sample.text?.length ?? 0) / 2.2),
              })
              if (thin?.ok) { written += 1; lines.push(`兜底写好 ${thin.id}`) }
              else { failed += 1; lines.push(`兜底也失败 ${item.name}：${thin?.error ?? '未知'}`) }
              continue
            }
            failed += 1
            lines.push(`失败 ${item.name}：${message}`)
          }
        }
        return { text: `写了 ${written} 张，失败 ${failed} 张。\n${lines.join('\n')}`, hits: written }
      }

      let entries = index.entries
      const days = Number(args?.days)
      if (Number.isFinite(days) && days > 0) {
        const floor = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
        entries = entries.filter((entry) => String(entry?.day ?? '') >= floor)
      }
      const query = String(args?.query ?? '').trim()
      if (query.length > 0) {
        const needle = query.toLowerCase()
        entries = entries.filter((entry) => {
          const hay = `${entry?.title ?? ''} ${(entry?.keywords ?? []).join(' ')}`.toLowerCase()
          return hay.includes(needle)
        })
      }
      const limit = Math.max(1, Math.min(30, Number(args?.limit) || 10))
      const picked = entries.slice(0, limit)
      if (picked.length === 0) {
        return { text: `骨架目录里没有符合条件的段（共 ${index.entries.length} 段，目录在 ${root}）`, hits: 0 }
      }
      const lines = picked.map(clueOf)
      const more = index.entries.length > picked.length ? `\n（共 ${index.entries.length} 段，这里只给最近 ${picked.length} 条）` : ''
      return { text: lines.join('\n') + more, hits: picked.length }
    },
  }

  if (typeof ctx.tools?.register !== 'function') {
    log('没有 tools 服务，骨架工具没挂上')
    return
  }
  ctx.tools.register(definition)
}
