/**
 * 重排层：把词面/向量捞出来的前几十条，跟问题一起喂给一个小模型，让它逐条判断「这条能不能回答这个问题」。
 *
 * 跟向量的区别：向量是分开算、比距离，快但糙；重排是把问题和条目拼在一起看（交叉编码），
 * 慢但准，所以只用在最后十来条候选上。
 *
 * 设计：
 *   1. 模型从镜像下到 记忆\代谢日志\模型，之后离线可用；换模型改 本地配置.json 里的 rerankModel；
 *   2. 模型或依赖不在就返回空，上层按原顺序答——不能因为重排挂了就查不了；
 *   3. 只对前 rerankTopN 条打分，其余保持原顺序。
 *
 * @module dsh-metabolism/重排
 */
const DEFAULT_MODEL = 'Xenova/bge-reranker-base'
const MAX_CHARS = 1000

let loaded = null

function setupEnv(env, workspace) {
  env.cacheDir = `${workspace}\\记忆\\代谢日志\\模型`
  env.allowLocalModels = false
  env.useBrowserCache = false
  env.remoteHost = 'https://hf-mirror.com'
  env.remotePathTemplate = '{model}/resolve/{revision}/'
}

/** 懒加载：tokenizer + 分类头。第一次要下模型，之后常驻。 */
export async function loadReranker(workspace, model = DEFAULT_MODEL, log = () => {}) {
  if (loaded !== null && loaded.model === model) return loaded
  const url = new URL('./node_modules/@huggingface/transformers/dist/transformers.node.mjs', import.meta.url)
  const mod = await import(url.href)
  setupEnv(mod.env, workspace)
  const started = Date.now()
  const tokenizer = await mod.AutoTokenizer.from_pretrained(model)
  const scorer = await mod.AutoModelForSequenceClassification.from_pretrained(model, { dtype: 'q8' })
  log(`重排模型已加载（${model}，${Math.round((Date.now() - started) / 1000)}s）`)
  loaded = { model, tokenizer, scorer }
  return loaded
}

/**
 * 给若干条候选打分。pairs: [{query, doc}] 或直接传 query + docs。
 * 返回与 docs 等长的分数数组（越高越相关）；失败返回 null。
 */
export async function rerankScores(query, docs, workspace, options = {}) {
  if (!Array.isArray(docs) || docs.length === 0) return []
  const model = options.model ?? DEFAULT_MODEL
  const { tokenizer, scorer } = await loadReranker(workspace, model, options.log ?? (() => {}))
  const batch = Math.max(1, Number(options.batch) || 8)
  const scores = []
  for (let at = 0; at < docs.length; at += batch) {
    const slice = docs.slice(at, at + batch)
    // 注意：第二个参数得放进 options.text_pair，直接当第二参数传会被当成配置丢掉，
    // 结果每一条都只编码了问题本身，分数一模一样（2026-11-20 踩过）。
    const inputs = await tokenizer(
      slice.map(() => String(query).slice(0, MAX_CHARS)),
      { text_pair: slice.map((doc) => String(doc).replace(/\s+/g, ' ').slice(0, MAX_CHARS)), padding: true, truncation: true, max_length: 512 },
    )
    const output = await scorer(inputs)
    const data = output.logits.data
    const dims = output.logits.dims
    const width = dims[dims.length - 1]
    for (let row = 0; row < slice.length; row += 1) {
      // 二分类：取「相关」那一类；单输出：取唯一那个值
      scores.push(width >= 2 ? data[row * width + width - 1] : data[row * width])
    }
  }
  return scores
}
