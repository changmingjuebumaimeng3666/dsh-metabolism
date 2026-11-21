/**
 * 守卫：模型生成的卡落盘前过闸。设计稿 v3.1 第四节。
 *
 * 方向修正（2026-11-19 实测后）：设计稿写的是「原文有的高信号，卡里必须逐字存活」，
 * 实测不可行——摘要本来就不会抄全部路径，按那个跑，十张卡九张被退回。
 * 真正会出事的是反过来的情况：卡里写了某个路径/编号，原文里根本没有（编的），
 * 或者写错了一个字符（对不上）。所以改成「以卡为准，回原文核对」。
 *
 * 三档处置：
 *   - 对得上的：放行，记一行。
 *   - 少量对不上（不超过一半）：把那几行原话删掉，字段里带的也清成留白——宁可少说。
 *   - 一半以上对不上：这张卡整条不用，退回只写指针。
 *
 * 第四条老规矩照旧：判不了就留白，这里不编。
 */

/** 最多核对几条，免得一张大卡拖慢压缩。 */
const MAX_CHECK = 60

/** 抓高信号串：路径、URL、UUID、全大写错误码、key=value、三位以上数字。 */
export function extractSignals(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const found = new Set()
  const rules = [
    /[A-Za-z]:\\[^\s，。；、）】"'<>|*?]+/g,                               // Windows 路径
    /https?:\/\/[^\s，。；）】"'<>]+/g,                                    // URL
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,  // UUID
    /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,                                  // 带下划线的全大写（EPERM_ACCESS_DENIED）
    /\b[\w.-]+=[^\s，。；、）】"']{2,}/g,                                    // key=value
    /\d{3,}/g,                                                             // 三位以上数字
  ]
  for (const rule of rules) {
    for (const hit of text.match(rule) ?? []) {
      const clean = hit.replace(/[.,;:)\]]+$/, '')
      if (clean.length >= 4 && clean.length <= 200) found.add(clean)
    }
  }
  return [...found].slice(0, MAX_CHECK)
}

/** 把一张卡里的所有文字拼起来。 */
function cardText(card) {
  return [
    card.doing,
    ...(Array.isArray(card.requirements) ? card.requirements : []),
    ...(Array.isArray(card.done) ? card.done : []),
    card.next,
    ...(Array.isArray(card.quotes) ? card.quotes : []),
    ...(Array.isArray(card.keywords) ? card.keywords : []),
  ]
    .filter((line) => typeof line === 'string' && line.length > 0)
    .join('\n')
}

/** 这一行里带了不该带的串，就整行换掉。 */
function scrub(line, bad, placeholder) {
  const text = String(line ?? '')
  if (text.length === 0) return text
  return bad.some((signal) => text.includes(signal)) ? placeholder : text
}

/**
 * 过闸。返回 { card, notes, dropped, missing }。
 * dropped 为 true 表示这张卡不能用，调用方应退回只写指针。
 */
export function guardCard(card, sample, options = {}) {
  const notes = []
  if (card === null || card === undefined) {
    return { card: null, notes, dropped: false, missing: [] }
  }
  const said = extractSignals(cardText(card))
  if (said.length === 0) {
    notes.push('卡里没有可核对的高信号串')
    return { card, notes, dropped: false, missing: [] }
  }

  // 原文样本作白名单。样本本身是摘录，可能不全，所以只在「对不上」时才动手，
  // 且要超过一半才整条退回——宁可漏掉几条，也不要把好卡判死。
  const source = new Set(extractSignals(sample))
  if (source.size === 0) {
    notes.push('没有原文样本，跳过核对')
    return { card, notes, dropped: false, missing: [] }
  }

  const wrong = said.filter((signal) => !source.has(signal))
  if (wrong.length === 0) {
    notes.push(`卡里 ${said.length} 条高信号全部对得上原文`)
    return { card, notes, dropped: false, missing: [] }
  }

  const ratio = wrong.length / said.length
  const dropRatio = Number(options.dropRatio) > 0 ? Number(options.dropRatio) : 0.5
  if (ratio > dropRatio) {
    notes.push(`卡里 ${wrong.length}/${said.length} 条高信号原文里没有（${Math.round(ratio * 100)}%），整条退回指针`)
    return { card: null, notes, dropped: true, missing: wrong }
  }

  // 少量对不上：把带错的行清掉，剩下的照用
  const blank = '（原文对不上，已留白）'
  card.quotes = (Array.isArray(card.quotes) ? card.quotes : []).filter(
    (line) => !wrong.some((signal) => String(line).includes(signal)),
  )
  card.doing = scrub(card.doing, wrong, blank)
  card.next = scrub(card.next, wrong, blank)
  card.requirements = (Array.isArray(card.requirements) ? card.requirements : [])
    .filter((line) => !wrong.some((signal) => String(line).includes(signal)))
  card.done = (Array.isArray(card.done) ? card.done : [])
    .filter((line) => !wrong.some((signal) => String(line).includes(signal)))
  notes.push(`卡里 ${wrong.length}/${said.length} 条高信号原文里没有，已清掉那几行：${wrong.slice(0, 5).join('、')}`)
  return { card, notes, dropped: false, missing: wrong }
}
