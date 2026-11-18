/**
 * 向量层：把每条原话算成一串数，查询时按「意思近」找，补词面检索的短板。
 *
 * 为什么要它：词面检索只认字。「问虫子」找不到「蜈蚣」那条，「问缓存」找不到「KV cache」那条，
 * 30 道自测题里漏掉的那 5 道全是这个病。向量不认字，只认意思。
 *
 * 设计要点：
 *   1. 本地跑（transformers.js + onnxruntime，WASM/node 都行），不联网、不花钱；
 *   2. 模型第一次用会从镜像下到 记忆\代谢日志\模型，之后离线可用；
 *   3. 向量存成二进制（一条 512 个 float32），库里自带一份头信息，索引重建时跟着重算；
 *   4. 模型或依赖不在，全部函数返回空，上层自动退回词面检索——不能因为向量挂了就查不了。
 *
 * @module dsh-metabolism/向量
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 用的模型：小、中文、512 维，量化后三十来兆。 */
const MODEL = 'Xenova/bge-small-zh-v1.5'
const DIM = 512
const HEADER = '向量头.json'
const BODY = '向量.bin'

/** 一条原话最多取多少字去算向量（模型最多 512 token，多算没用）。 */
const MAX_CHARS = 600

/** BGE 系列给查询加一句检索指令，效果更稳；文档不加。 */
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

let loaded = null

function pathsOf(indexDir) {
  return { dir: indexDir, header: join(indexDir, HEADER), body: join(indexDir, BODY) }
}

/** 模型缓存和依赖位置：都放在工作区里，不碰系统目录。 */
function setupEnv(env, workspace) {
  env.cacheDir = join(workspace, '记忆', '代谢日志', '模型')
  env.allowLocalModels = false
  env.useBrowserCache = false
  env.remoteHost = 'https://hf-mirror.com'
  env.remotePathTemplate = '{model}/resolve/{revision}/'
}

/** 懒加载模型：第一次调用要几秒，之后常驻。 */
export async function loadModel(workspace, log = () => {}) {
  if (loaded !== null) return loaded
  const url = new URL('./node_modules/@huggingface/transformers/dist/transformers.node.mjs', import.meta.url)
  const mod = await import(url.href)
  setupEnv(mod.env, workspace)
  const started = Date.now()
  const extract = await mod.pipeline('feature-extraction', MODEL, { dtype: 'q8' })
  log(`向量模型已加载（${Math.round((Date.now() - started) / 1000)}s）`)
  loaded = extract
  return extract
}

/** 一批文字算成向量（一条一个 Float32Array）。 */
export async function embedTexts(texts, workspace, options = {}) {
  const extract = await loadModel(workspace, options.log ?? (() => {}))
  const out = []
  const batch = Number(options.batch) || 8
  const prefix = options.query === true ? QUERY_PREFIX : ''
  for (let start = 0; start < texts.length; start += batch) {
    const slice = texts.slice(start, start + batch).map((text) => prefix + String(text).slice(0, MAX_CHARS))
    const result = await extract(slice, { pooling: 'mean', normalize: true })
    const flat = result.data
    const dims = result.dims
    for (let row = 0; row < slice.length; row += 1) {
      out.push(Float32Array.from(flat.subarray(row * dims[dims.length - 1], (row + 1) * dims[dims.length - 1])))
    }
  }
  return out
}

/** 向量索引在不在、是不是跟当前单元索引对得上（条数一致就算对得上）。 */
export function vectorsReady(indexDir, expectedCount) {
  const paths = pathsOf(indexDir)
  if (!existsSync(paths.header) || !existsSync(paths.body)) return false
  try {
    const header = JSON.parse(readFileSync(paths.header, 'utf8'))
    if (header.dim !== DIM) return false
    if (expectedCount !== undefined && header.count !== expectedCount) return false
    const size = statSync(paths.body).size
    return size === header.count * DIM * 4
  } catch {
    return false
  }
}

/** 把一批向量写成二进制文件。 */
export function writeVectors(indexDir, vectors, meta = {}) {
  const paths = pathsOf(indexDir)
  if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true })
  const buffer = Buffer.allocUnsafe(vectors.length * DIM * 4)
  vectors.forEach((vec, row) => {
    for (let k = 0; k < DIM; k += 1) buffer.writeFloatLE(vec[k] ?? 0, (row * DIM + k) * 4)
  })
  writeFileSync(paths.body, buffer)
  writeFileSync(paths.header, JSON.stringify({ model: MODEL, dim: DIM, count: vectors.length, builtAt: Date.now(), ...meta }, null, 2), 'utf8')
  loaded = null
  return { count: vectors.length, bytes: buffer.length }
}

/** 读向量索引进内存（40 兆左右，一次）。 */
export function readVectors(indexDir) {
  const paths = pathsOf(indexDir)
  const header = JSON.parse(readFileSync(paths.header, 'utf8'))
  const buffer = readFileSync(paths.body)
  const count = header.count
  const matrix = new Float32Array(count * DIM)
  for (let row = 0; row < count; row += 1) {
    for (let k = 0; k < DIM; k += 1) matrix[row * DIM + k] = buffer.readFloatLE((row * DIM + k) * 4)
  }
  return { header, count, dim: DIM, matrix }
}

/**
 * 余弦排序：给一个查询向量，返回 [{ index, score }]，score 是余弦（向量已归一化，点积就是余弦）。
 * filter(index) 返回 false 的行直接跳过（时间范围过滤用）。
 */
export function cosineTop(queryVec, matrix, count, options = {}) {
  const filter = options.filter ?? (() => true)
  const k = Math.max(1, Number(options.k) || 200)
  const dim = DIM
  const best = []
  for (let row = 0; row < count; row += 1) {
    if (!filter(row)) continue
    let sum = 0
    const base = row * dim
    for (let j = 0; j < dim; j += 1) sum += matrix[base + j] * queryVec[j]
    if (best.length < k) {
      best.push({ index: row, score: sum })
      if (best.length === k) best.sort((a, b) => a.score - b.score)
    } else if (sum > best[0].score) {
      best[0] = { index: row, score: sum }
      let pos = 0
      while (pos * 2 + 1 < best.length) {
        let child = pos * 2 + 1
        if (child + 1 < best.length && best[child + 1].score < best[child].score) child += 1
        if (best[pos].score <= best[child].score) break
        const tmp = best[pos]
        best[pos] = best[child]
        best[child] = tmp
        pos = child
      }
    }
  }
  return best.sort((a, b) => b.score - a.score)
}

export { MODEL, DIM, QUERY_PREFIX }
