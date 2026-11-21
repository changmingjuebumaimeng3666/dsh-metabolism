/**
 * 摘要块.js —— 三层摘要的格式、预算、分层（2026-11-20 起）。
 *
 * 摘要块是写进会话的一条消息：压掉的那段原文，换成一块 300~500 字的摘要，
 * 带归档地址；七天后折成周块，三十天折成指针。这里只放格式和算账，
 * 不碰会话写入（那是 engine.js 的活）。
 */

/** 把一段摘要正文包成上下文里能读的块。 */
export function renderSummaryBlock({ text, seqFrom, seqTo, archiveName, tokenCount }) {
  const clean = String(text ?? '').trim()
  const lines = [
    `<summary-block seq="${seqFrom}–${seqTo}">`,
    clean,
    `归档：${archiveName}（seq ${seqFrom}–${seqTo}，约 ${tokenCount} tokens）`,
    '</summary-block>',
  ]
  return lines.join('\n')
}

/**
 * 估 token：中文按 1.6 字/token，其余按 4 字/token。偏保守，宁多不少。
 * 预算只用来记账和触发折叠，不追求精确，日志里写的是估算口径。
 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length
  const other = s.length - cjk
  return Math.ceil(cjk / 1.6 + other / 4)
}

/** 按天数分到哪一层：a=原摘要(0–7 天)，b=周块(7–30 天)，c=指针(30 天以外)。 */
export function layerOf(ageDays) {
  const days = Number(ageDays) || 0
  if (days <= 7) return 'a'
  if (days <= 30) return 'b'
  return 'c'
}

/** 折叠周块：任务线（来自骨架日摘要）+ 味道（来自原摘要各摘半句）。 */
export function foldWeekBlock({ taskLines, flavorLines, seqFrom, seqTo, archiveName }) {
  const task = (taskLines ?? []).filter((line) => String(line ?? '').trim().length > 0)
  const flavor = (flavorLines ?? []).filter((line) => String(line ?? '').trim().length > 0)
  const body = []
  if (task.length > 0) body.push(...task)
  if (flavor.length > 0) body.push('—', ...flavor)
  const text = body.join('\n')
  return {
    text,
    tokens: estimateTokens(text),
    block: renderSummaryBlock({ text, seqFrom, seqTo, archiveName, tokenCount: estimateTokens(text) }),
  }
}
