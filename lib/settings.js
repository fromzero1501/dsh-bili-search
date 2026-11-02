/**
 * dsh-bili-search 的设置存储。
 *
 * 一份 JSON 放在插件自己的数据目录（和 wbi 缓存、冷却状态同一个地方），
 * 不碰 profile、不碰宿主配置 —— 所以改设置不需要重启，也不会把启动链搞坏。
 *
 * 优先级固定三档：调用时显式给的参数 > 这里存的默认值 > 内置默认。
 *
 * 边界（有意为之，不要加）：
 *  - 不存 cookie 内容，只存路径；
 *  - 不给「关掉风控保护」的开关：间隔有 200ms 下限、单轮上限有 70 的硬顶、冷却只能缩短不能关；
 *  - 不开放「关掉硬闸」的开关：G2–G7 这些硬闸只能通过参数/默认值调严，不给整条关掉；
 *    播放量下限可以设 0（＝不卡播放），但那是显式的数值，不是隐藏开关。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const HOME_DIR = path.join(homedir(), '.bili-filter')
export const SETTINGS_FILE = path.join(HOME_DIR, 'settings.json')
export const LAST_RUN_FILE = path.join(HOME_DIR, 'last-run.json')
export const SETTINGS_VERSION = 1

export const DEFAULT_SETTINGS = {
  days: 30,
  duration: 'any',
  // 2026-11-03 用户定：临时条件的默认值（0=不限）。给了区间就以区间为准、档位忽略
  durationMin: 0,
  durationMax: 0,
  minPlay: 1000,
  targetN: 12,
  candidateLimit: 200,
  orders: ['totalrank'],
  upCap: 3,
  typename: '',
  exclude: '',
  mode: 'overview',
  deepTop: 5,
  commentTarget: 50,
  probe: true,
  gapMs: 340,
  cooldownMinutes: 10,
  cookiePath: '',
  outDir: '',
  formats: { md: true, csv: true, json: true },
  subtitle: { minCoverage: 0.6, minCharsPerMin: 80, maxCharsPerMin: 600, minSegments: 20 },
  // 2026-11-02 用户定：deep 收口后自动附「总结骨架」（九节 + L0 硬规则 + 评论规则）
  summary: true,
  summaryProfile: 'auto',
}

/** 硬下限 / 硬上限：设置页只能在这个区间里滑，越界直接拒绝保存 */
export const LIMITS = {
  gapMs: { min: 200, max: 2000 },
  cooldownMinutes: { min: 5, max: 60 },
  days: { min: 0, max: 3650 },
  minPlay: { min: 0, max: 1000000 },
  targetN: { min: 1, max: 50 },
  // 自定义时长区间（分钟）：0 = 该侧不限
  durationMin: { min: 0, max: 600 },
  durationMax: { min: 0, max: 600 },
  candidateLimit: { min: 5, max: 500 },
  upCap: { min: 1, max: 10 },
  deepTop: { min: 1, max: 10 },
  commentTarget: { min: 20, max: 100 },
  minCoverage: { min: 0.2, max: 1 },
  minCharsPerMin: { min: 20, max: 300 },
  maxCharsPerMin: { min: 200, max: 2000 },
  minSegments: { min: 5, max: 200 },
}

const DURATIONS = ['any', '1', '2', '3', '4']
const MODES = ['overview', 'deep']
// 总结骨架的主题模板（auto = 按关键词/标题自动判）
export const SUMMARY_PROFILES = ['auto', 'price', 'howto', 'review', 'event', 'idea', 'product', 'ranking', 'generic']
// 2026-11-02 用户定：只用综合排序（totalrank）。其余排序留作可选加回，默认关。
export const VALID_ORDERS = ['totalrank', 'click', 'pubdate', 'dm', 'stow']

/** 把任意输入规整成合法的排序列表：只认五个值、去重、totalrank 永远在最前；空 → 只有综合排序 */
export function orderList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,，、|｜/;；]+/)
  const picked = []
  for (const item of raw) {
    const key = String(item || '').trim().toLowerCase()
    if (VALID_ORDERS.includes(key) && !picked.includes(key)) picked.push(key)
  }
  if (!picked.includes('totalrank')) picked.unshift('totalrank')
  return picked
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 只认设置里认识的键，深合并一层嵌套对象 */
function merge(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in base)) continue
    if (isPlainObject(base[key]) && isPlainObject(value)) out[key] = { ...base[key], ...value }
    else out[key] = value
  }
  return out
}

export function readSettings() {
  try {
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS, formats: { ...DEFAULT_SETTINGS.formats }, subtitle: { ...DEFAULT_SETTINGS.subtitle } }
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return merge(DEFAULT_SETTINGS, isPlainObject(raw) ? raw : {})
  } catch {
    // 文件坏了不要连累检索：退回内置默认，等用户保存时再覆盖成合法值
    return { ...DEFAULT_SETTINGS, formats: { ...DEFAULT_SETTINGS.formats }, subtitle: { ...DEFAULT_SETTINGS.subtitle } }
  }
}

function clampNumber(value, limit, label, errors) {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    errors.push({ field: label, message: '要填数字' })
    return null
  }
  if (limit && (n < limit.min || n > limit.max)) {
    errors.push({ field: label, message: '只能填 ' + limit.min + ' 至 ' + limit.max })
    return null
  }
  return n
}

/**
 * 校验并落盘。整笔校验通过才写，任何一项不合法都不动磁盘（避免写出半套设置）。
 * 返回 { ok, settings, errors }
 */
export function writeSettings(patch) {
  const errors = []
  const incoming = isPlainObject(patch) ? patch : {}
  const next = merge(readSettings(), incoming)

  if ('days' in incoming) {
    const n = clampNumber(incoming.days, LIMITS.days, 'days', errors)
    if (n !== null) next.days = Math.round(n)
  }
  if ('minPlay' in incoming) {
    const n = clampNumber(incoming.minPlay, LIMITS.minPlay, 'minPlay', errors)
    if (n !== null) next.minPlay = Math.round(n)
  }
  if ('targetN' in incoming) {    const n = clampNumber(incoming.targetN, LIMITS.targetN, 'targetN', errors)
    if (n !== null) next.targetN = Math.round(n)
  }
  if ('candidateLimit' in incoming) {
    const n = clampNumber(incoming.candidateLimit, LIMITS.candidateLimit, 'candidateLimit', errors)
    if (n !== null) next.candidateLimit = Math.round(n)
  }
  if ('orders' in incoming) {
    const raw = Array.isArray(incoming.orders) ? incoming.orders : String(incoming.orders || '').split(/[\s,，、|｜/;；]+/)
    const bad = raw
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item) => item && !VALID_ORDERS.includes(item))
    if (bad.length) {
      errors.push({ field: 'orders', message: '排序只认 ' + VALID_ORDERS.join(' / ') + '，不认识：' + bad.join('、') })
    } else {
      next.orders = orderList(raw)
    }
  }
  if ('upCap' in incoming) {
    const n = clampNumber(incoming.upCap, LIMITS.upCap, 'upCap', errors)
    if (n !== null) next.upCap = Math.round(n)
  }
  if ('deepTop' in incoming) {
    const n = clampNumber(incoming.deepTop, LIMITS.deepTop, 'deepTop', errors)
    if (n !== null) next.deepTop = Math.round(n)
  }
  if ('commentTarget' in incoming) {
    const n = clampNumber(incoming.commentTarget, LIMITS.commentTarget, 'commentTarget', errors)
    if (n !== null) next.commentTarget = Math.round(n)
  }
  if ('gapMs' in incoming) {
    const n = clampNumber(incoming.gapMs, LIMITS.gapMs, 'gapMs', errors)
    if (n !== null) next.gapMs = Math.round(n)
  }
  if ('cooldownMinutes' in incoming) {
    const n = clampNumber(incoming.cooldownMinutes, LIMITS.cooldownMinutes, 'cooldownMinutes', errors)
    if (n !== null) next.cooldownMinutes = Math.round(n)
  }
  if ('duration' in incoming) {
    const v = String(incoming.duration)
    if (!DURATIONS.includes(v)) errors.push({ field: 'duration', message: '只能是 any / 1 / 2 / 3 / 4' })
    else next.duration = v
  }
  // 2026-11-03：自定义时长区间（分钟），给了区间就以区间为准、档位忽略
  for (const field of ['durationMin', 'durationMax']) {
    if (!(field in incoming)) continue
    const n = clampNumber(incoming[field], LIMITS[field], field, errors)
    if (n !== null) next[field] = Math.round(n * 10) / 10
  }
  if (next.durationMin > 0 && next.durationMax > 0 && next.durationMin >= next.durationMax) {
    errors.push({ field: 'durationMax', message: '自定义时长要满足「下限 < 上限」（单位分钟）' })
  }
  if ('mode' in incoming) {
    const v = String(incoming.mode)
    if (!MODES.includes(v)) errors.push({ field: 'mode', message: '只能是 overview / deep' })
    else next.mode = v
  }
  if ('probe' in incoming) next.probe = Boolean(incoming.probe)
  if ('summary' in incoming) next.summary = Boolean(incoming.summary)
  if ('summaryProfile' in incoming) {
    const v = String(incoming.summaryProfile || '').toLowerCase()
    if (!SUMMARY_PROFILES.includes(v)) errors.push({ field: 'summaryProfile', message: '只能是 ' + SUMMARY_PROFILES.join(' / ') })
    else next.summaryProfile = v
  }
  if ('typename' in incoming) next.typename = String(incoming.typename || '')
  if ('exclude' in incoming) next.exclude = String(incoming.exclude || '')
  if ('cookiePath' in incoming) next.cookiePath = String(incoming.cookiePath || '')
  if ('outDir' in incoming) next.outDir = String(incoming.outDir || '')

  if ('formats' in incoming) {
    const f = isPlainObject(incoming.formats) ? incoming.formats : {}
    next.formats = {
      md: f.md === undefined ? next.formats.md : Boolean(f.md),
      csv: f.csv === undefined ? next.formats.csv : Boolean(f.csv),
      json: f.json === undefined ? next.formats.json : Boolean(f.json),
    }
    if (!next.formats.md && !next.formats.csv && !next.formats.json) {
      errors.push({ field: 'formats', message: '至少留一种落盘格式' })
    }
  }

  if ('subtitle' in incoming) {
    const s = isPlainObject(incoming.subtitle) ? incoming.subtitle : {}
    const pairs = [
      ['minCoverage', LIMITS.minCoverage, '字幕覆盖率下限'],
      ['minCharsPerMin', LIMITS.minCharsPerMin, '字数密度下限'],
      ['maxCharsPerMin', LIMITS.maxCharsPerMin, '字数密度上限'],
      ['minSegments', LIMITS.minSegments, '最少段数'],
    ]
    for (const [key, limit, label] of pairs) {
      if (!(key in s)) continue
      const n = clampNumber(s[key], limit, 'subtitle.' + label, errors)
      if (n !== null) next.subtitle[key] = key === 'minCoverage' ? n : Math.round(n)
    }
    if (next.subtitle.minCharsPerMin > next.subtitle.maxCharsPerMin) {
      errors.push({ field: 'subtitle', message: '密度下限不能大于上限' })
    }
  }

  if (errors.length) return { ok: false, settings: readSettings(), errors }

  try {
    mkdirSync(HOME_DIR, { recursive: true })
    const tmp = SETTINGS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify({ version: SETTINGS_VERSION, ...next }, null, 2), 'utf8')
    renameSync(tmp, SETTINGS_FILE)
  } catch (error) {
    return { ok: false, settings: readSettings(), errors: [{ field: 'file', message: '写不进去：' + String(error && error.message ? error.message : error) }] }
  }
  return { ok: true, settings: next, errors: [] }
}

/** 记一条「最近一次运行」，给设置页的状态区看 */
export function recordRun(info) {
  try {
    mkdirSync(HOME_DIR, { recursive: true })
    writeFileSync(LAST_RUN_FILE, JSON.stringify({ at: new Date().toISOString(), ...info }, null, 2), 'utf8')
  } catch {
    /* 记不上不影响检索 */
  }
}

export function readLastRun() {
  try {
    if (!existsSync(LAST_RUN_FILE)) return null
    return JSON.parse(readFileSync(LAST_RUN_FILE, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 把「调用时给的参数」和「设置里的默认值」合起来。
 * 显式给了就用显式的，没给就用设置里的 —— 这是用户要的优先级。
 */
export function effectiveParams(args, settings = readSettings()) {
  const a = args || {}
  const pick = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : value)
  return {
    days: Number(pick(a.days, settings.days)),
    minPlay: Number(pick(a.minPlay, settings.minPlay)),
    duration: String(pick(a.duration, settings.duration)),
    // 自定义时长区间：调用时给了就用给的，没给就吃设置页里的默认（0 = 不限）
    durationMin: Number(pick(a.durationMin, settings.durationMin)) || 0,
    durationMax: Number(pick(a.durationMax, settings.durationMax)) || 0,
    targetN: Number(pick(a.targetN, settings.targetN)),
    candidateLimit: Number(pick(a.candidateLimit, settings.candidateLimit)),
    orders: orderList(pick(a.orders, settings.orders)),
    upCap: Number(pick(a.upCap, settings.upCap)),
    exclude: String(pick(a.exclude, settings.exclude)),
    typename: String(pick(a.typename, settings.typename)),
    probe: a.probe === undefined ? Boolean(settings.probe) : Boolean(a.probe),
    mode: String(pick(a.mode, settings.mode)).toLowerCase(),
    deepTop: Number(pick(a.deepTop, settings.deepTop)),
    outDir: String(pick(a.outDir, settings.outDir)),
  }
}
