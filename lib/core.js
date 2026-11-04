/**
 * dsh-bili-search · 检索 + 筛选核心
 *
 * 设计依据（均已实测，不是推断）：
 *  - `bili` CLI 的 search 只有 bvid/title/author/play/duration 五字段、无排序无时间过滤 → 列表检索一律直连
 *    `x/web-interface/search/type`（page_size=50、order=totalrank/click/pubdate/dm/stow、pubtime_begin_s/end_s、duration 档生效）。
 *  - 不带 cookie 直接请求返回 -412 request was banned → 必须复用 bili CLI 的凭证。
 *  - `numResults` 恒为 1000 是服务端封顶，不是真实总数，禁止进任何统计口径。
 *  - duration 存在 "4558:10" 这类脏值 → 解析容错，异常即淘汰。
 *  - 传输层用 curl 子进程而不是 node fetch：同一秒内同一个 cookie 同一条 URL，
 *    curl 回 200、node fetch 回 412 拦截页（UA/Referer/编码/HTTP2 全试过，与 header 无关，
 *    是 TLS 指纹层面被拦）。所以默认走 curl，curl 不存在才退回 fetch。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { readSettings, orderList } from './settings.js'
import { buildSummarySkeleton } from './summary.js'

export const LOG = '[bili-search]'

function log(message) {
  console.error(LOG, message)
}
export const VERSION = '0.5.1'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// 实测（2026-11-01）：不带 wbi 签名的 /x/web-interface/search/type 会被回 3286 字节的 HTML
// 拦截页；同一时刻 nav 却能正常返回 code=0 —— 说明不是 IP 封、也不是 cookie 失效，而是这个
// 端点要求 wts + w_rid 签名。加上签名后立刻 code=0、正常返回 20 条。所以必须走 wbi 端点。
const WBI_SEARCH_API = 'https://api.bilibili.com/x/web-interface/wbi/search/type'
// 免签名通道（2026-11-04 实测：无 cookie、无 wbi 签名同样 code=0，page_size=50 生效）
const SEARCH_API = 'https://api.bilibili.com/x/web-interface/search/type'
// 聚合搜索：一次回全部分组（video / bili_user / media_bangumi …），每页 20 条，也是免签名
const ALL_SEARCH_API = 'https://api.bilibili.com/x/web-interface/search/all/v2'
const NAV_API = 'https://api.bilibili.com/x/web-interface/nav'
const REFERER_SEARCH = 'https://search.bilibili.com/'
const REFERER_WWW = 'https://www.bilibili.com/'

/** wbi mixinKey 的固定重排表（官方前端写死的 64 位顺序，不随账号变化） */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
]

export const ORDERS = ['totalrank', 'click', 'pubdate', 'dm', 'stow']
export const ORDER_LABEL = {
  totalrank: '综合',
  click: '播放',
  pubdate: '最新',
  dm: '弹幕',
  stow: '收藏',
}

/** duration 档位：B站 服务端筛选口径 */
export const DURATION_BANDS = {
  any: null,
  1: { code: 1, label: '≤10 分钟', maxSec: 600 },
  2: { code: 2, label: '10–30 分钟', minSec: 600, maxSec: 1800 },
  3: { code: 3, label: '30–60 分钟', minSec: 1800, maxSec: 3600 },
  4: { code: 4, label: '>60 分钟', minSec: 3600 },
}

// 实测：短时间里连跑 40+ 次搜索接口会踩到 HTTP 412（回拦截页），所以间隔放宽到 500ms，
// 单轮上限 24 次，宁可少取几页也别把 IP 送进黑名单。
let GAP_MS = 340
const BASE_MAX_CALLS = 24
let MAX_CALLS = BASE_MAX_CALLS

// 风控退避与冷却。实测：短时间内连打约 100 次请求后，连 curl 都统一回 412（IP 级节流），
// 冷却几分钟才恢复。所以命中风控后不是「立刻重试」，而是退避两档、仍失败就把冷却状态落盘，
// 下次启动直接拒绝并告知还要等几分钟 —— 硬刷只会把冷却窗口越拖越长。
const BACKOFF_MS = process.env.BILI_FILTER_BACKOFF_MS
  ? process.env.BILI_FILTER_BACKOFF_MS.split(',').map((n) => Number(n) || 0)
  : [6000, 18000]
let COOLDOWN_MS = 10 * 60 * 1000
const STATE_FILE = path.join(homedir(), '.bili-filter', 'state.json')

// 2026-11-02 用户定：候选池复用。list 阶段取回来的池子留在内存里，final 阶段同参数直接复用，
// 不再把整轮检索重搜一遍（final 一次能省掉 10 次上下的调用）。参数变了就自然换 key。
const POOL_TTL_MS = 5 * 60 * 1000
const poolCache = new Map()

/** 池子缓存的 key：只放「会影响取样结果」的维度（硬闸参数如 minPlay/exclude 不进 key） */
export function poolKeyOf(options = {}) {
  const parts = [
    String(options.keyword || '').trim(),
    Number(options.days || 0),
    String(options.duration || 'any'),
    // 2026-11-03：自定义时长区间会改变取样时的请求（档位参数不下发），必须进 key
    Number(options.durationMin || 0),
    Number(options.durationMax || 0),
    String(options.typename || ''),
    Math.max(1, Number(options.pagesPerOrder) || 4),
    orderList(options.orders).join(','),
  ]
  return parts.join('|')
}

export function clearPoolCache() {
  poolCache.clear()
}

/**
 * 把设置页里存的运行时参数拉进来（间隔 / 冷却时长 / 评论条数 / 字幕质量闸 / 落盘偏好）。
 * 每次检索开始时调一次：改设置不用重启，下一次调用就生效。
 * 间隔和冷却有硬下限，设置页那头已经卡住，这里再兜一次底。
 */
export function syncRuntimeSettings() {
  const s = readSettings()
  GAP_MS = Math.max(200, Math.min(2000, Number(s.gapMs) || 340))
  COOLDOWN_MS = Math.max(5, Math.min(60, Number(s.cooldownMinutes) || 10)) * 60 * 1000
  COMMENT_TARGET = Math.max(20, Math.min(100, Number(s.commentTarget) || 50))
  const sub = s.subtitle || {}
  if (Number.isFinite(Number(sub.minCoverage))) SUB_CFG.minCoverage = Number(sub.minCoverage)
  if (Number.isFinite(Number(sub.minCharsPerMin))) SUB_CFG.minCharsPerMin = Number(sub.minCharsPerMin)
  if (Number.isFinite(Number(sub.maxCharsPerMin))) SUB_CFG.maxCharsPerMin = Number(sub.maxCharsPerMin)
  if (Number.isFinite(Number(sub.minSegments))) SUB_CFG.minSegments = Number(sub.minSegments)
  return s
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ *
 * 凭证
 * ------------------------------------------------------------------ */

export function credentialPath() {
  return process.env.BILI_CREDENTIAL || path.join(homedir(), '.bilibili-cli', 'credential.json')
}

/**
 * 凭证状态（2026-11-04 用户定：没有凭证也要能跑 overview —— 搜索端点免登录，
 * 凭证只影响「按账号召回」与部分需要登录的资源，不该让整个插件起不来）。
 */
export function credentialState() {
  const file = credentialPath()
  if (!existsSync(file)) return { ok: false, path: file, reason: '没有凭证文件（还没跑过 `bili login`）' }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw.sessdata) return { ok: false, path: file, reason: '凭证里没有 sessdata' }
    return { ok: true, path: file, reason: '' }
  } catch (error) {
    return { ok: false, path: file, reason: '凭证文件读不出来：' + String(error.message || error) }
  }
}

/** 拼 Cookie 串；没有可用凭证时返回空串（匿名请求，不当成错误） */
export function loadCookie() {
  const file = credentialPath()
  if (!existsSync(file)) return ''
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return ''
  }
  if (!raw.sessdata) return ''
  const parts = []
  if (raw.sessdata) parts.push('SESSDATA=' + raw.sessdata)
  if (raw.bili_jct) parts.push('bili_jct=' + raw.bili_jct)
  if (raw.buvid3) parts.push('buvid3=' + raw.buvid3)
  if (raw.dedeuserid) parts.push('DedeUserID=' + raw.dedeuserid)
  return parts.join('; ')
}

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

let callCount = 0

/** 带预算/冷却/退避的接口调用（导出给探针脚本用） */
export async function callApi(url, { referer = 'https://search.bilibili.com/' } = {}) {
  if (callCount >= MAX_CALLS) throw riskError('本轮接口调用已达上限 ' + MAX_CALLS + ' 次，中止以免触发风控。')
  assertNotCooling()

  let lastRisk = null
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    await sleep(GAP_MS)
    callCount += 1
    try {
      return await onceApi(url, referer)
    } catch (error) {
      if (!error.risk) throw error
      lastRisk = error
      const wait = BACKOFF_MS[attempt]
      if (wait === undefined) break
      log('命中风控，等 ' + Math.round(wait / 1000) + ' 秒后重试（第 ' + (attempt + 1) + '/' + BACKOFF_MS.length + ' 次重试）')
      await sleep(wait)
    }
  }
  writeCooldown(lastRisk?.message || '风控')
  throw riskError(
    lastRisk.message + ' 已进入冷却 ' + Math.round(COOLDOWN_MS / 60000) + ' 分钟，期间不会再打接口；' +
      '别连续手动重试，越刷冷却越长。',
  )
}

async function onceApi(url, referer) {
  const text = await fetchText(url, referer)
  // 412/403 时 B 站会直接回一张 HTML 拦截页（实测 <title>出错啦! - bilibili.com</title>），
  // 也可能回 {"code":-412}。两种情况都必须当风控上抛，不能当「没结果」吞掉。
  let json
  try {
    json = JSON.parse(text)
  } catch {
    if (/request was banned|出错啦/.test(text) || /^\s*</.test(text)) {
      throw riskError('被 B 站风控（回的是拦截页），这一轮先停。')
    }
    throw new Error('接口返回的不是 JSON：' + text.slice(0, 120))
  }
  if (json.code === -412) throw riskError('被风控（-412 request was banned）。')
  if (json.code !== 0) throw new Error('接口返回 ' + json.code + ' ' + (json.message || ''))
  return json.data
}

/* ---------------------------- 冷却状态 ---------------------------- */

function readCooldown() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return typeof state.until === 'number' ? state : null
  } catch {
    return null
  }
}

/** 距冷却结束还有多少毫秒（0 表示没在冷却） */
export function cooldownRemainMs() {
  const state = readCooldown()
  if (!state) return 0
  const remain = state.until - Date.now()
  return remain > 0 ? remain : 0
}

function assertNotCooling() {
  const remain = cooldownRemainMs()
  if (remain > 0) {
    const mins = Math.ceil(remain / 60000)
    throw riskError('还在风控冷却中，约再等 ' + mins + ' 分钟（' + new Date(readCooldown().until).toLocaleTimeString() + ' 之后）。')
  }
}

function writeCooldown(reason) {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ until: Date.now() + COOLDOWN_MS, reason, at: new Date().toISOString() }, null, 2),
      'utf8',
    )
  } catch {
    /* 冷却状态写不进去不影响抛错 */
  }
}

/** 手动清冷却（用户在 B 站页面确认已恢复正常后可以用） */
export function clearCooldown() {
  try {
    unlinkSync(STATE_FILE)
    return true
  } catch {
    return false
  }
}

/* ---------------------------- wbi 签名 ---------------------------- *
 * search 接口不带签名一律回拦截页（实测），所以每个检索请求都要带 wts + w_rid。
 * 密钥从 nav 的 wbi_img 取，一天变一次 → 落盘缓存 1 小时，避免每次跑都多打一次 nav。
 * ------------------------------------------------------------------ */

const WBI_FILE = path.join(homedir(), '.bili-filter', 'wbi.json')
const WBI_TTL_MS = 60 * 60 * 1000
let wbiMemory = null

function keyFromUrl(url) {
  const file = String(url || '').split('/').pop() || ''
  return file.split('.')[0]
}

function mixinKeyOf(imgKey, subKey) {
  const raw = imgKey + subKey
  return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
}

function readWbiCache() {
  if (wbiMemory && Date.now() - wbiMemory.at < WBI_TTL_MS) return wbiMemory
  try {
    const cached = JSON.parse(readFileSync(WBI_FILE, 'utf8'))
    if (cached && cached.imgKey && cached.subKey && Date.now() - cached.at < WBI_TTL_MS) {
      wbiMemory = cached
      return cached
    }
  } catch {
    /* 没缓存就去取 */
  }
  return null
}

async function ensureWbi() {
  const cached = readWbiCache()
  if (cached) return cached
  const data = await callApi(NAV_API, { referer: REFERER_WWW })
  const img = data && data.wbi_img ? data.wbi_img : null
  if (!img || !img.img_url || !img.sub_url) throw new Error('取不到 wbi 密钥（nav 没回 wbi_img），B 站可能改接口了')
  const next = { imgKey: keyFromUrl(img.img_url), subKey: keyFromUrl(img.sub_url), at: Date.now() }
  wbiMemory = next
  try {
    mkdirSync(path.dirname(WBI_FILE), { recursive: true })
    writeFileSync(WBI_FILE, JSON.stringify(next), 'utf8')
  } catch {
    /* 缓存写不进去就每次现取，不影响正确性 */
  }
  return next
}

/** 设置页的「刷新签名」按钮：丢掉内存与磁盘缓存，下次检索重新从 nav 取密钥 */
export function clearWbiCache() {
  wbiMemory = null
  try {
    unlinkSync(WBI_FILE)
    return true
  } catch {
    return false
  }
}

/** 设置页的「检测登录」：拿现成的 cookie 打一次 nav，回昵称与等级（1 次调用，走预算与冷却） */
export async function checkLogin() {
  try {
    const data = await callApi(NAV_API, { referer: REFERER_WWW })
    if (!data || !data.isLogin) {
      return { ok: false, message: '凭证没登录（nav 回的是未登录）。先跑一次 `bili login` 扫码。', name: '', mid: 0 }
    }
    const level = data.level_info && Number.isFinite(Number(data.level_info.current_level)) ? Number(data.level_info.current_level) : 0
    return { ok: true, name: data.uname || '', mid: data.mid || 0, level, message: '已登录：' + (data.uname || '(无名)') + (level ? '（LV' + level + '）' : '') }
  } catch (error) {
    return { ok: false, message: String(error && error.message ? error.message : error), name: '', mid: 0 }
  }
}

/** 把参数签成 query 串（键名升序，值里去掉 !'()* 再编码，末尾拼 w_rid） */
function signParams(params, mixinKey) {
  const wts = Math.floor(Date.now() / 1000)
  const all = { ...params, wts }
  const query = Object.keys(all)
    .sort()
    .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(String(all[key]).replace(/[!'()*]/g, '')))
    .join('&')
  const w_rid = createHash('md5').update(query + mixinKey).digest('hex')
  return query + '&w_rid=' + w_rid
}

let wbiMode = 'unknown' // 'wbi' | 'plain'

/** 当前检索通道用的是哪种（给自检路由和报错文案看） */
export function wbiState() {
  return wbiMode
}

/**
 * 检索用 URL。
 * 2026-11-04 实测：search/type 与 wbi/search/type 都不强制签名与登录。
 * 所以签名只是「优先尝试」——拿不到密钥就退回免签名通道，不让整轮失败。
 * 但风控（risk）照旧上抛：那种情况降级只会再挨一次。
 */
async function searchUrl(params) {
  if (wbiMode !== 'plain') {
    try {
      const keys = await ensureWbi()
      wbiMode = 'wbi'
      return WBI_SEARCH_API + '?' + signParams(params, mixinKeyOf(keys.imgKey, keys.subKey))
    } catch (error) {
      if (error && error.risk) throw error
      wbiMode = 'plain'
      log('wbi 签名拿不到（' + String(error.message || error) + '），改用免签名通道继续')
    }
  }
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) qs.set(key, String(value))
  return SEARCH_API + '?' + qs.toString()
}

let transport = 'unknown'

/** 当前实际用的传输层：curl / fetch（给自检和报错文案用） */
export function transportUsed() {
  return transport
}

async function fetchText(url, referer) {
  if (transport !== 'fetch' && process.env.BILI_FILTER_TRANSPORT !== 'fetch') {
    const viaCurl = curlGet(url, referer)
    if (viaCurl !== null) {
      transport = 'curl'
      return viaCurl
    }
    transport = 'fetch'
  }
  const cookie = loadCookie()
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer,
      Accept: 'application/json, text/plain, */*',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(20000),
  })
  if (res.status === 412 || res.status === 403 || res.status === 429) {
    throw riskError('被 B 站风控（HTTP ' + res.status + '），这一轮先停，隔几分钟再试。')
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' · ' + url)
  return await res.text()
}

const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl'

/**
 * 用 curl 取一段文本。cookie 走 --config 临时文件，不进命令行参数（避免出现在进程列表里）。
 * 走文件而不是管道：宿主沙箱下 node 的 piped stdio 可能被拦（EPERM）。
 * 返回 null 表示本机没有 curl，调用方退回 fetch。
 */
function curlGet(url, referer) {
  const tag = randomBytes(6).toString('hex')
  const cfgPath = path.join(tmpdir(), 'bili-filter-' + tag + '.cfg')
  const outPath = path.join(tmpdir(), 'bili-filter-' + tag + '.out')
  try {
    const cookie = loadCookie()
    const cfg = [
      'silent',
      'max-time = 25',
      'header = "User-Agent: ' + UA + '"',
      'header = "Referer: ' + referer + '"',
      'header = "Accept: */*"',
    ]
    if (cookie) cfg.push('header = "Cookie: ' + cookie + '"')
    cfg.push('')
    writeFileSync(cfgPath, cfg.join('\n'), 'utf8')
    const result = spawnSync(CURL_BIN, ['-K', cfgPath, '-o', outPath, url], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30000,
    })
    if (result.error) {
      if (result.error.code === 'ENOENT') return null
      throw result.error
    }
    if (!existsSync(outPath)) {
      throw new Error('curl 没有写出响应（退出码 ' + result.status + '）')
    }
    return readFileSync(outPath, 'utf8')
  } finally {
    for (const file of [cfgPath, outPath]) {
      try {
        unlinkSync(file)
      } catch {
        /* 临时文件清不掉不影响结果 */
      }
    }
  }
}

function riskError(message) {
  const error = new Error(message)
  error.risk = true
  return error
}

export function resetCallBudget() {
  callCount = 0
  MAX_CALLS = BASE_MAX_CALLS
}

/** deep 模式要多打详情/字幕/评论，临时抬高单轮上限；resetCallBudget 会还原 */
export function setCallBudget(n) {
  MAX_CALLS = Math.max(1, Math.min(70, Number(n) || BASE_MAX_CALLS))
}

export function callsUsed() {
  return callCount
}

/* ------------------------------------------------------------------ *
 * 字段规整
 * ------------------------------------------------------------------ */

export function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .trim()
}

/** "16:33" → 993；"1:7" → 67；"1:02:03" → 3723；脏值/超 6 小时 → null */
export function parseDuration(text) {
  const s = String(text || '').trim()
  if (!s) return null
  if (!/^\d{1,4}:\d{1,2}(:\d{1,2})?$/.test(s)) return null
  const parts = s.split(':').map((x) => Number(x))
  let sec
  if (parts.length === 2) sec = parts[0] * 60 + parts[1]
  else sec = parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (!Number.isFinite(sec) || sec <= 0) return null
  if (sec > 6 * 3600) return null // 实测 order=dm 会返回 4558:10 这类脏值
  return sec
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** 秒级时间戳 → 本地日期 YYYY-MM-DD（缺失就给占位，别编） */
export function fmtDate(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function normalizeRow(row, order) {
  const title = stripHtml(row.title)
  const tag = String(row.tag || '')
  const description = String(row.description || row.desc || '')
  return {
    bvid: row.bvid,
    aid: row.aid,
    title,
    author: String(row.author || ''),
    mid: Number(row.mid || 0),
    typename: String(row.typename || ''),
    typeid: Number(row.typeid || 0),
    pubdate: Number(row.pubdate || 0),
    play: Number(row.play || 0),
    like: Number(row.like || 0),
    favorites: Number(row.favorites || 0),
    danmaku: Number(row.video_review || row.danmaku || 0),
    review: Number(row.review || 0),
    durationText: String(row.duration || ''),
    durationSec: parseDuration(row.duration),
    tag,
    tags: tag ? tag.split(',').map((x) => x.trim()).filter(Boolean) : [],
    description,
    hasBadgePay: Number(row.badgepay || 0) === 1 || Number(row.is_pay || 0) === 1,
    isUnion: Number(row.is_union_video || 0) === 1,
    orders: new Set([order]),
    rankTotal: null,
    // B站自己标出的命中字段（["title","tag"] 之类），比我们猜的命中位置准
    hitColumns: Array.isArray(row.hit_columns) ? row.hit_columns.map((x) => String(x)) : [],
    url: 'https://www.bilibili.com/video/' + row.bvid,
  }
}

/* ------------------------------------------------------------------ *
 * Stage 1 · 取样
 * ------------------------------------------------------------------ */

/**
 * 检索词变体：一次调用可以带多条关键词（换行 / | ｜ ; ； 分隔，最多 4 条）。
 * 2026-11-02 用户定：**不许把检索词拆碎**（拆开会改变意图）。多条可以给，但每条必须是
 * 能独立表达同一意图的同义整句/同义词（「AI视频 价格」/「AI视频 生成 多少钱」/「AI视频 费用」），
 * 而不是把原词切成片段。碎片由 checkVariants() 拒绝。
 */
export function queryVariants(keyword) {
  const seen = new Set()
  const out = []
  for (const one of String(keyword || '').split(/[\n\r|｜;；]+/)) {
    const text = one.trim().replace(/\s+/g, ' ')
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= 4) break
  }
  return out
}

/**
 * 变体自检：某一条只是另一条的片段 → 判为「拆词」，直接报错。
 * 2026-11-02 用户定：不要拆检索词（拆开会改变意图），只允许同义替换。
 * 例：「AI视频 价格 | AI视频」第二条只是第一条的片段 → 拒绝。
 */
export function checkVariants(variants) {
  const list = (variants || []).map((x) => String(x || '').toLowerCase().replace(/\s+/g, ''))
  for (let i = 0; i < list.length; i += 1) {
    for (let j = 0; j < list.length; j += 1) {
      if (i === j) continue
      if (list[i] && list[j] && list[i] !== list[j] && list[j].includes(list[i])) {
        return (
          '第 ' +
          (i + 1) +
          ' 条「' +
          variants[i] +
          '」只是第 ' +
          (j + 1) +
          ' 条「' +
          variants[j] +
          '」的片段 —— 这是把检索词拆碎了，拆开会改变意图。' +
          '多条检索词必须每条都能独立表达同一意图，用同义句子或同义词替换（如「AI视频 价格」→「AI视频 生成 多少钱」→「AI视频 模型 费用」）。'
        )
      }
    }
  }
  return null
}

export async function samplePool(options = {}) {
  const keyword = String(options.keyword || '').trim()
  if (!keyword) throw new Error('关键词不能为空')
  const days = Number(options.days || 0)
  const bandKey = String(options.duration || 'any')
  const band = DURATION_BANDS[bandKey] || null
  // 2026-11-02 用户定：只用 B 站综合排序（order 是单值参数，跑五个排序等于五次请求）。
  // 想要更大召回可在设置页把额外排序勾回来，代码路径仍然支持多排序。
  const orders = orderList(Array.isArray(options.orders) && options.orders.length ? options.orders : readSettings().orders)
  const pagesPerOrder = Math.max(1, Math.min(6, Number(options.pagesPerOrder) || 4))
  // 关键词变体：按换行 / | ｜ ; ； 切成多条检索词（2026-11-01 用户定：先问意图，再按意图改写成更准的关键词去搜）
  const variants = queryVariants(keyword)
  // 变体多了要摊薄页数，保持单轮总调用量不爆
  const pagesPerVariant = Math.max(1, Math.floor(pagesPerOrder / Math.max(1, variants.length)))

  // 参数没变的池子直接复用：list 阶段取回来的东西，final 阶段不再重搜一遍
  const cacheKey = poolKeyOf({ ...options, keyword })
  if (!options.noCache) {
    const hit = poolCache.get(cacheKey)
    if (hit && Date.now() - hit.at < POOL_TTL_MS) {
      return {
        keyword,
        days,
        band: bandKey,
        items: hit.items,
        stats: { ...hit.stats, calls: 0, cached: true },
        fromCache: true,
      }
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const begin = days > 0 ? now - days * 86400 : 0

  const pool = new Map()
  const stats = { calls: 0, perOrder: {}, begin, end: now, requests: 0 }

  for (const variant of variants) {
  for (const order of orders) {
    let got = 0
    for (let page = 1; page <= pagesPerVariant; page += 1) {
      const query = {
        search_type: 'video',
        keyword: variant,
        page: String(page),
        page_size: '50',
        order,
      }
      if (begin) {
        query.pubtime_begin_s = String(begin)
        query.pubtime_end_s = String(now)
      }
      if (band) query.duration = String(band.code)

      let data
      try {
        data = await callApi(await searchUrl(query))
      } catch (error) {
        // 风控直接上抛（连续命中就整轮作废，别拿空池子冒充「没结果」）；
        // 其他错误保留已取到的部分，并记下原因供上层说明。
        if (error.risk) throw error
        stats.errors = stats.errors || []
        stats.errors.push(variant + ' / ' + order + ' p' + page + ': ' + String(error && error.message ? error.message : error))
        stats.perOrder[order] = (stats.perOrder[order] || 0) + got
        break
      }
      stats.requests += 1
      const rows = Array.isArray(data && data.result) ? data.result : []
      rows.forEach((row, idx) => {
        if (!row || !row.bvid) return
        // 记下在 B 站「综合排序」（totalrank）里的位次，后面当相关性主信号
        const rank = order === 'totalrank' ? (page - 1) * 50 + idx + 1 : null
        const hit = pool.get(row.bvid)
        if (hit) {
          hit.orders.add(order)
          if (rank && !hit.rankTotal) hit.rankTotal = rank
          return
        }
        const item = normalizeRow(row, order)
        item.rankTotal = rank
        pool.set(row.bvid, item)
      })
      got += rows.length
      if (rows.length < 50) break
    }
    stats.perOrder[order] = (stats.perOrder[order] || 0) + got
  }
  }

  stats.calls = callCount
  stats.variants = variants
  stats.pagesPerVariant = pagesPerVariant
  const result = { keyword, days, band: bandKey, items: [...pool.values()], stats, fromCache: false }
  if (!options.noCache) poolCache.set(cacheKey, { items: result.items, stats: { ...stats }, at: Date.now() })
  return result
}

/* ------------------------------------------------------------------ *
 * Stage 1b · 聚合搜索（找 UP 主 / 找番剧）
 * 2026-11-04 新增：走 /x/web-interface/search/all/v2，一次回全部分组、免签名。
 * 这一层只「列清单」——不走硬闸、不排序、不收口，也不参与两段式。
 * ------------------------------------------------------------------ */

function allSearchUrl(keyword, page) {
  const qs = new URLSearchParams({ keyword, page: String(page) })
  return ALL_SEARCH_API + '?' + qs.toString()
}

function normUserRow(row) {
  const mid = Number(row.mid || 0)
  const name = stripHtml(row.uname || '')
  const sign = stripHtml(row.usign || '')
  return {
    kind: 'user',
    mid,
    bvid: 'mid' + mid,
    title: name,
    author: name,
    fans: Number(row.fans || 0),
    videos: Number(row.videos || 0),
    level: Number(row.level || 0),
    sign,
    badge: row.official_verify && row.official_verify.desc ? String(row.official_verify.desc) : '',
    url: 'https://space.bilibili.com/' + mid,
    play: Number(row.videos || 0),
    description: sign,
    orders: new Set(),
    hitColumns: Array.isArray(row.hit_columns) ? row.hit_columns.map(String) : [],
    rank: 0,
  }
}

function normBangumiRow(row, kind) {
  const seasonId = String(row.season_id || '')
  const indexShow = stripHtml(row.index_show || '')
  const styles = Array.isArray(row.styles) ? row.styles.join(',') : String(row.styles || '')
  return {
    kind,
    seasonId,
    bvid: 'ss' + seasonId,
    title: stripHtml(row.title || ''),
    author: kind === 'film' ? '影视' : '番剧',
    fans: 0,
    videos: Number(row.total_count || 0),
    level: 0,
    sign: indexShow,
    badge: stripHtml(row.badge || ''),
    typename: kind === 'film' ? '影视' : '番剧',
    url: seasonId ? 'https://www.bilibili.com/bangumi/play/ss' + seasonId : String(row.arcurl || ''),
    play: 0,
    description: indexShow,
    styles,
    orders: new Set(),
    hitColumns: Array.isArray(row.hit_columns) ? row.hit_columns.map(String) : [],
    rank: 0,
  }
}

/** 找 UP 主 / 找番剧：只读聚合搜索的分组结果，每页 20 条 */
export async function runScope(options = {}) {
  const scope = options.scope === 'bangumi' ? 'bangumi' : 'user'
  const keyword = String(options.keyword || '').trim()
  if (!keyword) throw new Error('找 UP 主 / 找番剧也要给 keyword。')
  const variants = queryVariants(keyword)
  const problem = checkVariants(variants)
  if (problem) throw new Error(problem)
  const pages = Math.max(1, Math.min(5, Number(options.pages) || 1))
  const limit = Math.max(1, Math.min(200, Number(options.candidateLimit) || 50))
  const seen = new Map()
  const stats = { calls: 0, perVariant: {}, groups: [] }
  for (const variant of variants) {
    let got = 0
    for (let page = 1; page <= pages; page += 1) {
      const data = await callApi(allSearchUrl(variant, page), {
        referer: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(variant),
      })
      const groups = Array.isArray(data && data.result) ? data.result : []
      let pageGot = 0
      for (const group of groups) {
        const type = String(group.result_type || '')
        if (type && !stats.groups.includes(type)) stats.groups.push(type)
        if (scope === 'user' && type !== 'bili_user') continue
        if (scope === 'bangumi' && type !== 'media_bangumi' && type !== 'media_ft') continue
        for (const row of group.data || []) {
          const item = scope === 'user' ? normUserRow(row) : normBangumiRow(row, type === 'media_ft' ? 'film' : 'bangumi')
          const key = scope === 'user' ? 'm' + item.mid : 's' + item.seasonId
          if (!key || key === 'm0' || key === 's') continue
          pageGot += 1
          if (seen.has(key)) continue
          seen.set(key, item)
        }
      }
      got += pageGot
      if (pageGot < 20) break // 这一页没满，后面没得翻了
    }
    stats.perVariant[variant] = got
  }
  const rows = [...seen.values()].slice(0, limit).map((row, i) => ({ ...row, rank: i + 1 }))
  stats.calls = callCount
  stats.requests = stats.calls
  return { scope, keyword, rows, stats }
}

/** markdown 表格单元格：竖线换全角、按字数截断、undefined 变空串 */
function cell(text, max = 60) {
  const s = String(text === undefined || text === null ? '' : text).replace(/\|/g, '丨').trim()
  return max > 0 ? s.slice(0, max) : s
}

/** scope 结果的 markdown */
export function renderScope(result) {
  const isUser = result.scope === 'user'
  const out = []
  out.push('# B站 ' + (isUser ? 'UP 主' : '番剧 / 影视') + ' · ' + result.keyword)
  out.push('')
  out.push(
    '- 生成时间：' +
      new Date().toLocaleString('zh-CN') +
      '　分组：' +
      (isUser ? 'bili_user' : 'media_bangumi + media_ft') +
      '　调用：' +
      result.stats.calls +
      ' 次　条数：' +
      result.rows.length,
  )
  out.push('- 检索词：' + result.keyword + '（同义多条用 | 分隔，最多 4 条）')
  out.push('')
  if (isUser) {
    out.push('| # | UP主 | 粉丝 | 投稿数 | 等级 | 签名 | 空间 |')
    out.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const row of result.rows) {
      out.push(
        '| ' +
          [
            row.rank,
            cell(row.title || row.uname),
            fmtPlay(row.fans),
            row.videos,
            'LV' + row.level,
            cell(row.sign || row.usign, 40) || '—',
            '[站内空间](' + row.url + ')',
          ].join(' | ') +
          ' |',
      )
    }
  } else {
    out.push('| # | 标题 | 类型 | 集数 | 更新 | 标记 | 链接 |')
    out.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const row of result.rows) {
      out.push(
        '| ' +
          [
            row.rank,
            cell(row.title),
            row.typename || row.typeName || '—',
            row.videos || row.total || '—',
            cell(row.sign || row.indexShow, 30) || '—',
            row.badge || '—',
            '[播放页](' + row.url + ')',
          ].join(' | ') +
          ' |',
      )
    }
  }
  out.push('')
  out.push('口径：这层是 B 站聚合搜索的分组结果，每页固定 20 条、没有综合排序位次可比；不走硬闸、不排序、不收口。')
  return out.join('\n')
}

/** scope 结果落盘（md/csv/json，跟随设置页的 formats 开关） */
export function persistScope(result, outDir) {
  const dir = outDir || defaultOutDir()
  mkdirSync(dir, { recursive: true })
  const formats = readSettings().formats || { md: true, csv: true, json: true }
  const isUser = result.scope === 'user'
  const base = 'scope-' + (isUser ? 'up' : 'bangumi') + '-' + slugify(result.keyword) + '_' + stamp()
  const mdPath = formats.md ? path.join(dir, base + '.md') : null
  const csvPath = formats.csv ? path.join(dir, base + '.csv') : null
  const jsonPath = formats.json ? path.join(dir, base + '.json') : null
  if (mdPath) writeFileSync(mdPath, renderScope(result), 'utf8')
  const head = isUser
    ? ['rank', 'mid', 'uname', 'fans', 'videos', 'level', 'sign', 'url']
    : ['rank', 'seasonId', 'title', 'kind', 'episodes', 'indexShow', 'badge', 'url']
  const lines = [head.join(',')]
  for (const row of result.rows) {
    const cells = isUser
      ? [row.rank, row.mid, row.title, row.fans, row.videos, row.level, row.sign, row.url]
      : [row.rank, row.seasonId, row.title, row.typename, row.videos, row.sign, row.badge, row.url]
    lines.push(cells.map(csvCell).join(','))
  }
  if (csvPath) writeFileSync(csvPath, '\ufeff' + lines.join('\n'), 'utf8')
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          version: VERSION,
          generatedAt: new Date().toISOString(),
          scope: result.scope,
          keyword: result.keyword,
          stats: result.stats,
          items: result.rows.map((row) => ({
            rank: row.rank,
            mid: row.mid || null,
            season_id: row.seasonId || null,
            title: row.title,
            fans: row.fans,
            videos: row.videos,
            level: row.level,
            sign: row.sign,
            badge: row.badge,
            url: row.url,
          })),
        },
        null,
        2,
      ),
      'utf8',
    )
  }
  return { dir, mdPath, csvPath, jsonPath }
}

/* ------------------------------------------------------------------ *
 * Stage 2 · 六条硬闸
 * ------------------------------------------------------------------ */

function normTitle(title) {
  return String(title || '')
    .replace(/[【】\[\]（）()《》「」『』<>·,，。!！?？:：;；|/\\"'"'\-—_~～\s]+/g, '')
    .toLowerCase()
}

export function coreTokens(keyword) {
  return String(keyword || '')
    .toLowerCase()
    .split(/[\s,，、|/]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 1)
}

/**
 * 关键词切片：只用于「命中率」统计与理由展示，不当硬闸（关键词不做硬筛）。
 * 2026-11-02 用户定：**不要拆检索词**（拆开会改变意图），所以这里只按空白/标点与中英边界断开，
 * 中文段整体保留，不再切成双字块。「ai视频价格」→ ai / 视频价格。
 */
export function keywordParts(keyword) {
  const out = []
  const segs = String(keyword || '').toLowerCase().split(/[\s,，、|｜/;；]+/).filter(Boolean)
  for (const seg of segs) {
    for (const run of seg.match(/[a-z0-9]+|[^\sa-z0-9]+/g) || []) {
      if (run.length >= 2) out.push(run)
    }
  }
  return [...new Set(out.filter(Boolean))]
}

function hayOf(item) {
  return ((item.title || '') + ' ' + (item.tag || '') + ' ' + (item.description || '')).toLowerCase()
}

/**
 * 关键词切片命中率 0–1（只看提到没提到，不判语义）。
 * 2026-11-04：B 站回的 `hit_columns` 是它自己的分词结果（比我们猜的准），
 * 命在标题记 1、只命在标签/简介记 0.8，与本地切片取较大者。
 */
export function keywordCoverage(item, parts) {
  let local = 0
  if (parts.length) {
    const hay = hayOf(item)
    let hit = 0
    for (const t of parts) if (hay.includes(t)) hit += 1
    local = hit / parts.length
  }
  const cols = Array.isArray(item.hitColumns) ? item.hitColumns : []
  let platform = 0
  if (cols.includes('title')) platform = 1
  else if (cols.includes('tag') || cols.includes('description')) platform = 0.8
  return Math.max(local, platform)
}

export function gates(items, options = {}) {
  const keyword = String(options.keyword || '')
  const parts = keywordParts(keyword)
  const exclude = String(options.exclude || '')
    .toLowerCase()
    .split(/[\s,，、|/]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  const days = Number(options.days || 0)
  const minPlay = Math.max(0, Number(options.minPlay || 0))
  const bandKey = String(options.duration || 'any')
  const band = DURATION_BANDS[bandKey] || null
  // 2026-11-03 用户定：临时条件 —— 自定义时长区间（分钟）。给了区间就以区间为准，档位忽略。
  const dMinRaw = Number(options.durationMin)
  const dMaxRaw = Number(options.durationMax)
  const customMinSec = Number.isFinite(dMinRaw) && dMinRaw > 0 ? dMinRaw * 60 : null
  const customMaxSec = Number.isFinite(dMaxRaw) && dMaxRaw > 0 ? dMaxRaw * 60 : null
  const customRange = customMinSec != null || customMaxSec != null
  const now = Math.floor(Date.now() / 1000)

  // 2026-11-02 用户定：删掉 G6（字段缺失）这道硬闸 —— 不再因为字段缺失淘汰条目
  const kills = { G1: [], G2: [], G3: [], G4: [], G5: [], G7: [] }
  const kept = []

  for (const item of items) {
    const hay = (item.title + ' ' + item.tag + ' ' + item.description).toLowerCase()

    // 2026-11-02 用户定：不再因为字段缺失硬淘汰（原 G6 已删）。
    // 缺的字段就地补成空值/0，结果表里显示「—」，由模型看标题自己判要不要留。
    if (!item.title) item.title = ''
    if (!Number.isFinite(item.play)) item.play = 0
    if (!item.bvid) continue // 没有 bvid 就点不进视频，这一条无法呈现（不计入任何淘汰桶）
    // G1 已不放行判断（2026-11-01 用户定：跟 B 站自己的综合排序走，不强制筛关键词）——
    // 这里只把「关键词切片命中率」记到条目上，供打分与理由展示用。
    item._kwCoverage = keywordCoverage(item, parts)
    const hitEx = exclude.find((w) => hay.includes(w))
    if (hitEx) {
      kills.G2.push({ item, why: '命中排除词「' + hitEx + '」' })
      continue
    }
    if (item.durationSec == null) {
      kills.G3.push({ item, why: '时长脏值 ' + item.durationText })
      continue
    }
    if (!customRange && band) {
      if (band.minSec && item.durationSec < band.minSec) {
        kills.G3.push({ item, why: '时长 ' + fmtDuration(item.durationSec) + ' 低于 ' + band.label })
        continue
      }
      if (band.maxSec && item.durationSec > band.maxSec) {
        kills.G3.push({ item, why: '时长 ' + fmtDuration(item.durationSec) + ' 超过 ' + band.label })
        continue
      }
    }
    // 自定义区间（用户临时给的条件，优先级高于档位）
    if (customMinSec != null && item.durationSec < customMinSec) {
      kills.G3.push({
        item,
        why: '时长 ' + fmtDuration(item.durationSec) + ' 短于自定义下限 ' + (customMinSec / 60) + ' 分钟',
      })
      continue
    }
    if (customMaxSec != null && item.durationSec > customMaxSec) {
      kills.G3.push({
        item,
        why: '时长 ' + fmtDuration(item.durationSec) + ' 超过自定义上限 ' + (customMaxSec / 60) + ' 分钟',
      })
      continue
    }
    // G7 播放量下限（2026-11-01 用户加：硬闸里要能卡播放量，默认值在设置页里调）
    if (minPlay > 0 && item.play < minPlay) {
      kills.G7.push({ item, why: '播放 ' + item.play + ' 低于下限 ' + minPlay })
      continue
    }
    if (days > 0) {
      const ageDays = (now - item.pubdate) / 86400
      if (!item.pubdate || ageDays > days + 0.02) {
        kills.G5.push({ item, why: '发布时间不在 ' + days + ' 天窗内' })
        continue
      }
    }
    kept.push(item)
  }

  // G4 去重/搬运：同规范化标题只留播放最高；跨 UP 且播放 < 20% 判搬运
  const byTitle = new Map()
  const survivors = []
  for (const item of kept) {
    const key = normTitle(item.title)
    const prev = byTitle.get(key)
    if (!prev) {
      byTitle.set(key, item)
      survivors.push(item)
      continue
    }
    const winner = item.play > prev.play ? item : prev
    const loser = item === winner ? prev : item
    if (winner !== prev) {
      const idx = survivors.indexOf(prev)
      if (idx >= 0) survivors[idx] = winner
      byTitle.set(key, winner)
    }
    const crossUp = winner.mid !== loser.mid
    const why = crossUp ? '同标题跨 UP，播放 ' + loser.play + ' < 保留者 20%' : '标题完全重复'
    if (!crossUp || loser.play < winner.play * 0.2) kills.G4.push({ item: loser, why })
    else survivors.push(item) // 同标题但两条都够热，保留
  }

  return { kept: survivors, kills }
}

/* ------------------------------------------------------------------ *
 * Stage 3 · 排序（不评分）
 * 2026-11-01 用户定：移除 100 分制评分与 S/A/B/C 分档。
 * 硬闸之后只做两件事：谁相关（由对话模型看标题判）、谁播放高（插件排）。
 *   - list 阶段：给候选清单，默认按 B 站综合排序位次（贴近站内顺序，供模型剔无关）
 *   - final 阶段：只按播放量降序（同 UP 上限仍生效）
 * ------------------------------------------------------------------ */

export function ageDaysOf(row) {
  if (!row.pubdate) return null
  return (Math.floor(Date.now() / 1000) - row.pubdate) / 86400
}

export function sortRows(rows, sort = 'play') {
  const out = [...rows]
  if (sort === 'totalrank') {
    // 位次越小越前；只在其他排序里出现、没进综合排序的排最后
    out.sort(
      (a, b) =>
        (a.rankTotal || Number.MAX_SAFE_INTEGER) - (b.rankTotal || Number.MAX_SAFE_INTEGER) || b.play - a.play,
    )
  } else {
    out.sort((a, b) => b.play - a.play)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Stage 4 · 取用（同 UP 配额 + 排序）
 * ------------------------------------------------------------------ */

function bvidList(value) {
  return (Array.isArray(value) ? value : String(value || '').split(/[\s,，、|/]+/))
    .map((x) => String(x).trim())
    .filter(Boolean)
}

export function pickRows(rows, options = {}) {
  const targetN = Math.max(1, Math.min(500, Number(options.targetN) || 12))
  const upCap = Math.max(1, Number(options.upCap) || 3)
  const sort = options.sort === 'totalrank' ? 'totalrank' : 'play'

  // keep：模型看过标题、剔掉明显无关之后留下的 bvid 列表。
  // 给了就只在这些里面取，并且不再回填（相关性由模型负责）；没给就整池按排序取。
  const keepList = bvidList(options.keep)
  const keepSet = keepList.length ? new Set(keepList) : null
  const base = keepSet ? rows.filter((row) => keepSet.has(row.bvid)) : rows
  const ordered = sortRows(base, sort)

  // 强相关（2026-11-02 用户定）：模型标出「几乎和意图一致」的那几条。
  // final 时这些排最前，无视播放量（组内仍按播放量降序），其余照旧。
  const strongList = bvidList(options.strong)
  const strongSet = strongList.length ? new Set(strongList) : null
  let arranged = ordered
  let strongRows = []
  if (strongSet) {
    strongRows = ordered
      .filter((row) => strongSet.has(row.bvid))
      .sort((a, b) => b.play - a.play)
      .map((row) => ({ ...row, _strong: true }))
    arranged = [...strongRows, ...ordered.filter((row) => !strongSet.has(row.bvid))]
  }

  const out = []
  const suppressed = []
  const perUp = new Map()
  let strongOut = 0
  for (const row of arranged) {
    const n = perUp.get(row.mid) || 0
    if (n >= upCap) {
      suppressed.push(row)
      continue
    }
    perUp.set(row.mid, n + 1)
    if (row._strong) strongOut += 1
    out.push({ ...row, _dupIndex: n })
    if (out.length >= targetN) break
  }

  return {
    rows: out,
    suppressed,
    selectable: base.length,
    keepMissing: keepSet ? keepList.filter((b) => !rows.some((r) => r.bvid === b)) : [],
    // 强相关里没进结果的：池子里没有的（强相关 bvid 写漏了/被硬闸淘汰）单独回报
    strongMissing: strongSet ? strongList.filter((b) => !rows.some((r) => r.bvid === b)) : [],
    strongTotal: strongRows.length,
    strongOut,
    strongTruncated: strongSet ? Math.max(0, strongRows.length - strongOut) : 0,
  }
}

/* ------------------------------------------------------------------ *
 * Stage 5 · 敏感性探测（默认开）
 * ------------------------------------------------------------------ */

export async function sensitivityProbe(options = {}) {
  const keyword = String(options.keyword || '').trim()
  const days = Number(options.days || 0)
  const bandKey = String(options.duration || 'any')
  const exclude = options.exclude || ''
  const pages = Math.max(1, Math.min(3, Number(options.pages) || 2))

  // 一次「放宽时间窗 + 放宽时长」的采样，用来估算单项放宽能解锁多少条
  let sample
  try {
    sample = await samplePool({
      keyword,
      days: 0,
      duration: 'any',
      orders: ['totalrank'],
      pagesPerOrder: pages,
    })
  } catch (error) {
    return { ok: false, error: String(error.message || error), notes: [] }
  }

  const loose = gates(sample.items, { keyword, exclude, days: 0, duration: 'any' }).kept
  const passTime = gates(sample.items, { keyword, exclude, days, duration: 'any' }).kept
  const passDur = gates(sample.items, { keyword, exclude, days: 0, duration: bandKey }).kept
  const passBoth = gates(sample.items, { keyword, exclude, days, duration: bandKey }).kept

  return {
    ok: true,
    sampled: sample.items.length,
    notes: [
      { relax: '时间窗', unlocked: Math.max(0, passTime.length - passBoth.length) },
      { relax: '时长档', unlocked: Math.max(0, passDur.length - passBoth.length) },
      { relax: '两者同时放宽', unlocked: Math.max(0, loose.length - passBoth.length) },
    ],
    baseline: passBoth.length,
    sampleScope: '仅采样放宽后前 ' + pages * 50 + ' 条（综合排序），是上限估计不是精确解',
  }
}

/* ------------------------------------------------------------------ *
 * Stage 5 · deep 证据层（只读，不参与淘汰）
 *   对评分最高的前 N 条取三样东西：视频详情、字幕、50 条评论。
 *   摘要与结论由上层（对话里的模型）依据这里的原始证据写，插件只负责取证与呈现。
 * ------------------------------------------------------------------ */

const VIEW_API = 'https://api.bilibili.com/x/web-interface/view'
const PLAYER_API = 'https://api.bilibili.com/x/player/v2'
const REPLY_API = 'https://api.bilibili.com/x/v2/reply'
const SUB_CFG = { minCoverage: 0.6, minCharsPerMin: 80, maxCharsPerMin: 600, minSegments: 20 }
export const COMMENT_PAGE_SIZE = 20
// 抓多少条评论：设置页可改（20 / 50 / 100），syncRuntimeSettings() 在每次检索开始时同步
export let COMMENT_TARGET = 50

function toAbsUrl(url) {
  if (!url) return ''
  return url.startsWith('//') ? 'https:' + url : url
}

/** 非 JSON 接口（字幕文件）也要计入预算与冷却 */
async function grabText(url, referer) {
  if (callCount >= MAX_CALLS) throw riskError('本轮接口调用已达上限 ' + MAX_CALLS + ' 次，中止以免触发风控。')
  assertNotCooling()
  await sleep(GAP_MS)
  callCount += 1
  return fetchText(url, referer)
}

async function fetchDetail(bvid) {
  const referer = 'https://www.bilibili.com/video/' + bvid
  const data = await callApi(VIEW_API + '?bvid=' + encodeURIComponent(bvid), { referer })
  if (!data || !data.bvid) throw new Error('详情接口没回视频信息')
  return {
    aid: data.aid,
    cid: data.cid,
    desc: String(data.desc || ''),
    durationSec: Number(data.duration) || 0,
    pubdate: Number(data.pubdate) || 0,
    stat: data.stat || null,
    tags: Array.isArray(data.tags) ? data.tags.map((t) => t.tag_name) : [],
  }
}

/**
 * 字幕摘录：开头给上下文，再按「价格/套餐/积分」这类词抓几段窗口。
 * 起因（2026-11-01 实测）：36 分钟的价格横评，前 1200 字全是平台功能唠嗑，
 * 真正的单价与套餐全在中后段 —— 只截开头等于没摘。
 */
const EXCERPT_HINT = /(价格|多少钱|几块|元|积分|套餐|月付|年付|订阅|折扣|折|成本|码率|秒)/g

export function buildExcerpt(text, { head = 1200, window = 400, maxHits = 5, cap = 3600 } = {}) {
  if (!text) return ''
  if (text.length <= head) return text
  const parts = [text.slice(0, head)]
  let used = head
  let taken = 0
  EXCERPT_HINT.lastIndex = 0
  let hit
  while (taken < maxHits && used < cap && (hit = EXCERPT_HINT.exec(text))) {
    const start = Math.max(head, hit.index - Math.floor(window / 2))
    const end = Math.min(text.length, start + window)
    if (start < used) continue
    parts.push('…' + text.slice(start, end) + '…')
    used = end
    taken += 1
  }
  return parts.join('\n')
}

/** 字幕可用性判据：覆盖率 ≥60%、字数密度 ≥80 字/分钟、段数 ≥20 —— 三条都过才算可用。
 *  这是「单次尝试」：拉 player/v2 → 下载字幕 → 判定。B 站侧有两类偶发故障——
 *  (1) 字幕条目在但 subtitle_url 为空；(2) 同一 bvid 每次给的字幕文件可能不是同一条视频的。
 *  所以外面套 fetchSubtitle 做重试（2026-11-02 用户定）。 */
async function fetchSubtitleOnce(bvid, cid, durationSec) {
  const referer = 'https://www.bilibili.com/video/' + bvid
  let data
  try {
    data = await callApi(PLAYER_API + '?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid), { referer })
  } catch (error) {
    if (error.risk) throw error
    return { ok: false, why: '字幕接口没取到：' + (error.message || error) }
  }
  const list = (data && data.subtitle && data.subtitle.subtitles) || []
  if (!list.length) return { ok: false, why: '这条没有字幕（含 AI 字幕）' }

  const withUrl = list.filter((s) => s && s.subtitle_url)
  if (!withUrl.length) {
    // 实测：偶尔 subtitle 列表在，但每条的 subtitle_url 都是空的（B 站这次没给），只能算取不到
    return { ok: false, why: '有 ' + list.length + ' 条字幕记录，但这次都没给下载地址（B 站偶发），取不到字幕' }
  }
  const pick = withUrl.find((s) => /ai-zh|zh/i.test(String(s.lan || ''))) || withUrl[0]
  const url = toAbsUrl(pick.subtitle_url)

  let raw
  try {
    raw = await grabText(url, referer)
  } catch (error) {
    if (error.risk) throw error
    return { ok: false, why: '字幕文件下载失败：' + (error.message || error) }
  }
  let body = []
  try {
    body = JSON.parse(raw).body || []
  } catch {
    return { ok: false, why: '字幕文件不是预期的 JSON' }
  }
  if (!body.length) return { ok: false, why: '字幕文件是空的' }

  const segs = body
    .map((b) => ({
      from: Number(b.from) || 0,
      to: Number(b.to) || 0,
      text: String(b.content || '').trim(),
    }))
    .filter((b) => b.text)
  const chars = segs.reduce((sum, b) => sum + b.text.length, 0)
  const lastTo = segs.length ? segs[segs.length - 1].to : 0
  const rawCoverage = durationSec > 0 ? lastTo / durationSec : 0
  const coverage = Math.min(1, rawCoverage)
  const charsPerMin = lastTo > 0 ? (chars / lastTo) * 60 : 0
  // 字幕时间轴比视频本身还长（>1.2 倍）通常意味着这条字幕是别的视频串过来的 —— 实测见过
  const overflow = durationSec > 0 && lastTo > durationSec * 1.2
  const usable =
    !overflow &&
    coverage >= SUB_CFG.minCoverage &&
    charsPerMin >= SUB_CFG.minCharsPerMin &&
    charsPerMin <= SUB_CFG.maxCharsPerMin &&
    segs.length >= SUB_CFG.minSegments

  // 摘录：可用才摘（不可用的字幕可能是别的视频的内容，摘出来会误导总结）
  const joined = segs.map((b) => b.text).join('')
  const excerpt = usable ? buildExcerpt(joined) : ''

  let why = ''
  if (!usable) {
    if (overflow) {
      why =
        '字幕时间轴 ' +
        Math.round(lastTo) +
        ' 秒，比视频本身（' +
        Math.round(durationSec) +
        ' 秒）还长，疑似串台，不可用'
    } else {
      const bad = []
      if (coverage < SUB_CFG.minCoverage) bad.push('只覆盖 ' + Math.round(coverage * 100) + '% 时长')
      if (charsPerMin < SUB_CFG.minCharsPerMin) bad.push('密度只有 ' + Math.round(charsPerMin) + ' 字/分钟')
      if (charsPerMin > SUB_CFG.maxCharsPerMin) bad.push('密度高达 ' + Math.round(charsPerMin) + ' 字/分钟（超出正常口播）')
      if (segs.length < SUB_CFG.minSegments) bad.push('仅 ' + segs.length + ' 段')
      why = '字幕不可用（' + bad.join('，') + '），别据此推断内容'
    }
  }

  return {
    ok: usable,
    lang: pick.lan || '',
    ai: /^ai/.test(String(pick.lan || '')),
    segments: segs.length,
    chars,
    coverage: Math.round(coverage * 1000) / 1000,
    charsPerMin: Math.round(charsPerMin),
    lastTo: Math.round(lastTo),
    overflow,
    excerpt,
    why,
  }
}

/** 字幕重试：最多试 SUB_ATTEMPTS 次（第 1 次 + 2 次重试），任一次判定可用就返回；
 *  全都不行时返回「最像样」的那次（优先非串台、其次覆盖率最高），并说明试了几次。 */
const SUB_ATTEMPTS = 3
const SUB_RETRY_GAP_MS = 1200

async function fetchSubtitle(bvid, cid, durationSec) {
  const tries = []
  for (let i = 0; i < SUB_ATTEMPTS; i += 1) {
    if (i > 0) await sleep(SUB_RETRY_GAP_MS)
    const got = await fetchSubtitleOnce(bvid, cid, durationSec)
    tries.push(got)
    if (got.ok) return { ...got, attempts: tries.length }
  }
  const ranked = [...tries].sort((a, b) => {
    const ao = a.overflow ? 1 : 0
    const bo = b.overflow ? 1 : 0
    if (ao !== bo) return ao - bo
    return (b.coverage || 0) - (a.coverage || 0)
  })
  const best = ranked[0] || { ok: false, why: '没取到字幕' }
  const why =
    '试了 ' +
    tries.length +
    ' 次都没拿到可用字幕，最好的一次：' +
    (best.why || '未知原因') +
    (tries.length > 1 ? '（B 站每次给的字幕文件可能不同）' : '')
  return { ...best, ok: false, excerpt: '', why, attempts: tries.length }
}

/** 评论：接口单页上限实测是 ps=20（ps=50 回 -400 ps out of bounds），要凑 50 条就翻 3 页 */
async function fetchComments(aid, target = COMMENT_TARGET) {
  const referer = 'https://www.bilibili.com/video/av' + aid
  const want = Math.max(1, target)
  const pages = Math.ceil(want / COMMENT_PAGE_SIZE)
  const items = []
  let total = 0
  let why = ''
  for (let pn = 1; pn <= pages; pn += 1) {
    const url =
      REPLY_API +
      '?type=1&oid=' +
      encodeURIComponent(aid) +
      '&sort=2&ps=' +
      COMMENT_PAGE_SIZE +
      '&pn=' +
      pn +
      '&nohot=0'
    let data
    try {
      data = await callApi(url, { referer })
    } catch (error) {
      if (error.risk) throw error
      why = '第 ' + pn + ' 页没取到：' + (error.message || error)
      break
    }
    const replies = Array.isArray(data && data.replies) ? data.replies : []
    if (data && data.page && Number(data.page.acount)) total = Number(data.page.acount)
    for (const r of replies) {
      if (!r || !r.content || !r.content.message) continue
      items.push({
        user: (r.member && r.member.uname) || '匿名',
        like: Number(r.like) || 0,
        replies: Number(r.rcount) || 0,
        text: String(r.content.message).replace(/\s+/g, ' ').trim().slice(0, 200),
      })
    }
    if (replies.length < COMMENT_PAGE_SIZE) break
    if (items.length >= want) break
  }
  items.sort((a, b) => b.like - a.like)
  const kept = items.slice(0, want)
  return { count: kept.length, total: total || kept.length, pages: pages, items: kept, why }
}

/**
 * 对 rows 的前 topN 条取证据。单条失败只记错误、不中断整轮；
 * 命中风控直接上抛（继续打只会让冷却更长）。
 */
export async function collectEvidence(rows, options = {}) {
  const topN = Math.max(1, Math.min(10, Number(options.topN) || 5))
  const targets = rows.slice(0, topN)
  for (const row of targets) {
    const ev = { bvid: row.bvid, errors: [] }
    try {
      const detail = await fetchDetail(row.bvid)
      ev.detail = detail
      if (detail.durationSec) row.durationSec = detail.durationSec
      if (detail.stat) {
        row.play = detail.stat.view ?? row.play
        row.like = detail.stat.like ?? row.like
        row.favorites = detail.stat.favorite ?? row.favorites
        row.coin = detail.stat.coin ?? null
        row.share = detail.stat.share ?? null
      }
      try {
        ev.subtitle = await fetchSubtitle(row.bvid, detail.cid, detail.durationSec || row.durationSec)
      } catch (error) {
        if (error.risk) throw error
        ev.errors.push('字幕：' + (error.message || error))
      }
      try {
        ev.comments = await fetchComments(detail.aid)
      } catch (error) {
        if (error.risk) throw error
        ev.errors.push('评论：' + (error.message || error))
      }
    } catch (error) {
      if (error.risk) throw error
      ev.errors.push('详情：' + (error.message || error))
    }
    row.evidence = ev
  }
  return targets.length
}

/** deep 证据渲染成 markdown 段落（总结位置留给上层模型写） */
export function renderEvidence(rows) {
  const out = []
  const withEv = rows.filter((r) => r.evidence)
  if (!withEv.length) return ''
  out.push('## 深度取证（前 ' + withEv.length + ' 条）')
  out.push('')
  out.push('> 这一节只放原始证据（简介 / 字幕 / 评论区），结论由对话里的模型依据它来写，插件不编造总结。')
  out.push('')
  for (const row of withEv) {
    const ev = row.evidence
    const d = ev.detail || {}
    const st = d.stat || {}
    out.push('### ' + row.rank + '. [' + row.title + '](' + row.url + ')')
    out.push('')
    const meta = []
    if (d.pubdate) meta.push('发布：' + new Date(d.pubdate * 1000).toLocaleString('zh-CN'))
    meta.push('时长：' + fmtDuration(row.durationSec))
    if (st.view !== undefined) meta.push('播放：' + st.view)
    if (st.like !== undefined) meta.push('点赞：' + st.like)
    if (st.favorite !== undefined) meta.push('收藏：' + st.favorite)
    if (st.coin !== undefined) meta.push('投币：' + st.coin)
    if (st.danmaku !== undefined) meta.push('弹幕：' + st.danmaku)
    if (st.reply !== undefined) meta.push('评论：' + st.reply)
    meta.push('UP主：' + row.author)
    out.push(meta.join(' · '))
    out.push('')
    if (d.desc) {
      const desc = d.desc.replace(/\s+/g, ' ').trim()
      out.push('**简介**：' + (desc.length > 400 ? desc.slice(0, 400) + '…' : desc))
      out.push('')
    }
    const sub = ev.subtitle
    if (sub && sub.ok) {
      out.push(
        '**字幕**：' +
          (sub.ai ? 'AI 字幕' : '字幕') +
          ' · ' +
          sub.segments +
          ' 段 · 覆盖 ' +
          Math.round(sub.coverage * 100) +
          '% · ' +
          sub.charsPerMin +
          ' 字/分钟 · 共 ' +
          sub.chars +
          ' 字',
      )
      out.push('')
      out.push('```')
      out.push(sub.excerpt)
      out.push('```')
    } else if (sub) {
      out.push('**字幕**：' + (sub.why || '不可用'))
    } else {
      out.push('**字幕**：没取到')
    }
    out.push('')
    const cm = ev.comments
    if (cm && cm.items.length) {
      out.push('**评论区**（抓到 ' + cm.count + ' 条' + (cm.total ? '，共 ' + cm.total + ' 条' : '') + '，按点赞排序取前 10）：')
      out.push('')
      for (const c of cm.items.slice(0, 10)) {
        out.push('- ' + (c.like ? '[' + c.like + ' 赞] ' : '') + c.text)
      }
    } else if (cm) {
      out.push('**评论区**：' + (cm.why || '没有评论'))
    }
    if (ev.errors.length) out.push('', '⚠ 取证告警：' + ev.errors.join('；'))
    out.push('')
  }
  return out.join('\n')
}


export function defaultOutDir() {
  if (process.env.BILI_FILTER_OUT) return process.env.BILI_FILTER_OUT
  const s = readSettings()
  if (s.outDir) return s.outDir
  return path.join(homedir(), 'Documents', 'bili-filter')
}

function slugify(text) {
  return String(text || 'query')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'query'
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    date.getFullYear() +
    p(date.getMonth() + 1) +
    p(date.getDate()) +
    '-' +
    p(date.getHours()) +
    p(date.getMinutes()) +
    p(date.getSeconds())
  )
}

function csvCell(value) {
  const s = String(value == null ? '' : value)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function persist(result, outDir) {
  const dir = outDir || defaultOutDir()
  mkdirSync(dir, { recursive: true })
  const formats = readSettings().formats || { md: true, csv: true, json: true }
  const base = slugify(result.params.keyword) + '_' + stamp()
  const mdPath = formats.md ? path.join(dir, base + '.md') : null
  const csvPath = formats.csv ? path.join(dir, base + '.csv') : null
  const jsonPath = formats.json ? path.join(dir, base + '.json') : null

  if (mdPath) writeFileSync(mdPath, renderMarkdown(result), 'utf8')

  const head = [
    'rank',
    'bvid',
    'title',
    'up',
    'mid',
    'duration',
    'play',
    'like',
    'favorites',
    'review',
    'ageDays',
    'rankTotal',
    'typename',
    'flags',
    'strong',
    'orders',
    'reason',
    'url',
    'pubdate',
    'subtitleUsable',
    'subtitleCoverage',
    'commentsCaught',
  ]
  const lines = [head.join(',')]
  for (const row of result.rows) {
    const age = ageDaysOf(row)
    lines.push(
      [
        row.rank,
        row.bvid,
        row.title,
        row.author,
        row.mid,
        fmtDuration(row.durationSec),
        row.play,
        row.like,
        row.favorites,
        row.review,
        age == null ? '' : Math.round(age),
        row.rankTotal || '',
        row.typename,
        flagsOf(row).join(' '),
        row._strong ? 'yes' : '',
        [...row.orders].join(' '),
        row.reason,
        row.url,
        fmtDate(row.pubdate),
        row.evidence && row.evidence.subtitle ? (row.evidence.subtitle.ok ? 'yes' : 'no') : '',
        row.evidence && row.evidence.subtitle ? row.evidence.subtitle.coverage : '',
        row.evidence && row.evidence.comments ? row.evidence.comments.count : '',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  if (csvPath) writeFileSync(csvPath, '\ufeff' + lines.join('\n'), 'utf8')
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(serialize(result), null, 2), 'utf8')
  return { dir, mdPath, csvPath, jsonPath }
}

export function flagsOf(row) {
  const out = []
  if (row._strong) out.push('强相关')
  if (row.hasBadgePay) out.push('付费')
  if (row.isUnion) out.push('推广')
  if (row.orders && row.orders.size >= 2) out.push('多排序命中')
  if (row._dupIndex > 0) out.push('同UP第' + (row._dupIndex + 1) + '条')
  return out
}

export function serialize(result) {
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    stage: result.stage || 'final',
    params: result.params,
    stats: result.stats,
    funnel: result.funnel,
    probe: result.probe,
    deep: result.deep || null,
    rows: result.rows.map((row) => {
      const age = ageDaysOf(row)
      return {
        rank: row.rank,
        bvid: row.bvid,
        title: row.title,
        author: row.author,
        mid: row.mid,
        durationSec: row.durationSec,
        play: row.play,
        like: row.like,
        favorites: row.favorites,
        review: row.review,
        ageDays: age == null ? null : Math.round(age),
        rankTotal: row.rankTotal || null,
        typename: row.typename,
        flags: flagsOf(row),
        strong: Boolean(row._strong),
        orders: [...row.orders],
        reason: row.reason,
        url: row.url,
        pubdate: row.pubdate,
        pubdateText: fmtDate(row.pubdate),
        hitColumns: row.hitColumns || [],
        evidence: row.evidence || null,
      }
    }),
    // 稳定输出契约（2026-11-04 借 bilibili-mcp-js 的做法）：外部消费只认这 10 个字段，
    // 字段名带下划线是刻意的——B 站自己改字段时这一层不跟着变。
    items: result.rows.map((row) => ({
      title: row.title,
      author: row.author,
      play_count: row.play,
      duration: fmtDuration(row.durationSec),
      publish_date: row.pubdate ? fmtDate(row.pubdate) : null,
      url: row.url,
      bvid: row.bvid,
      tag: row.tag,
      description: row.description,
      typename: row.typename,
    })),
    suppressed: (result.suppressed || []).map((row) => ({
      bvid: row.bvid,
      title: row.title,
      up: row.author,
      play: row.play,
    })),
  }
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

export function fmtPlay(n) {
  const v = Number(n) || 0
  if (v >= 100000000) return (v / 100000000).toFixed(1) + ' 亿'
  if (v >= 10000) return (v / 10000).toFixed(1) + ' 万'
  return String(v)
}

/** 发布时间的统一写法（2026-11-03 用户定：发布时间不许漏，缺失就明说） */
export function pubText(row) {
  if (!row.pubdate) return '发布时间未知'
  const age = ageDaysOf(row)
  return fmtDate(row.pubdate) + (age == null ? '' : '（' + Math.round(age) + ' 天前）')
}

/** 一行式摘要：字段顺序写死，发布日期跟着每条走，模型转述时不容易裁掉 */
export function renderRows(rows) {
  const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']
  return rows
    .map((row, i) => {
      const title = row.title.length > 40 ? row.title.slice(0, 39) + '…' : row.title
      const flag = flagsOf(row).join('/')
      return (
        (marks[i] || '(' + (i + 1) + ')') +
        ' [' + title + '](' + row.url + ') · UP:' + (row.author || '—') +
        ' · 发布 ' + pubText(row) +
        ' · 时长 ' + fmtDuration(row.durationSec) +
        ' · 播放 ' + fmtPlay(row.play) +
        (flag ? ' · ' + flag : '')
      )
    })
    .join('\n')
}

export function renderTable(rows) {
  const lines = []
  lines.push(['#', '标题（带链接）', 'UP主', '发布', '时长', '播放', '点赞', '收藏', '分区', '标记'].join(' | '))
  for (const row of rows) {
    const title = row.title.length > 32 ? row.title.slice(0, 31) + '…' : row.title
    lines.push(
      [
        row.rank,
        '[' + title + '](' + row.url + ')',
        row.author,
        row.pubdate ? fmtDate(row.pubdate) : '未知',
        fmtDuration(row.durationSec),
        row.play,
        row.like,
        row.favorites,
        row.typename,
        flagsOf(row).join('/') || '—',
      ].join(' | '),
    )
  }
  return lines.join('\n')
}

export function renderMarkdown(result) {
  const p = result.params
  const isList = result.stage === 'list'
  const out = []
  out.push('# B站 ' + (isList ? '候选清单' : '检索结果') + ' · ' + p.keyword)
  out.push('')
  out.push(
    '- 生成时间：' +
      new Date().toLocaleString('zh-CN') +
      '　阶段：' +
      (isList ? 'list（候选，待按标题剔掉明显无关）' : 'final（已收口）') +
      '　模式：' +
      p.mode,
  )
  out.push(
    '- 时间筛选：' +
      (p.days ? '最近 ' + p.days + ' 天' : '不限') +
      '　时长筛选：' +
      (p.durationMin > 0 || p.durationMax > 0
        ? (p.durationMin > 0 ? '≥ ' + p.durationMin + ' 分' : '') +
          (p.durationMin > 0 && p.durationMax > 0 ? ' 且 ' : '') +
          (p.durationMax > 0 ? '≤ ' + p.durationMax + ' 分' : '') +
          '（自定义区间）'
        : DURATION_BANDS[p.duration]
          ? DURATION_BANDS[p.duration].label
          : '不限') +
      '　播放量筛选 ≥ ' +
      (p.minPlay ? p.minPlay + ' 次' : '不限') +
      '　目标条数：' +
      p.targetN +
      '　排序：' +
      (p.sort === 'totalrank' ? 'B站综合排序位次' : '播放量降序'),
  )
  if (isList) {
    out.push('- 候选清单数量：' + p.candidateLimit + '　（筛完把留下的 bvid 传回 keep，再以 stage=final 收口）')
  }
  if (p.intent) out.push('- 用户意图：' + p.intent)
  if (p.exclude) out.push('- 排除词：' + p.exclude)
  out.push('')
  out.push('## 漏斗')
  out.push('')
  const f = result.funnel
  out.push('| 阶段 | 条数 |')
  out.push('| --- | --- |')
  out.push('| 取样去重后 | ' + f.pool + ' |')
  out.push('| 硬闸淘汰 | ' + f.killed + ' |')
  out.push('| 通过硬闸 | ' + f.kept + ' |')
  out.push('| ' + (isList ? '候选输出' : '输出') + ' | ' + result.rows.length + ' |')
  out.push('')
  out.push('淘汰原因分布：')
  for (const [k, v] of Object.entries(f.killBreakdown)) {
    if (v) out.push('- ' + k + '：' + v)
  }
  out.push('')
  out.push(isList ? '## 候选清单（按 B 站综合排序位次）' : '## 结果（按播放量降序）')
  out.push('')
  out.push('| # | 标题 | UP主 | 发布 | 时长 | 播放 | 点赞 | 收藏 | 分区 | 位次 | 标记 |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of result.rows) {
    out.push(
      '| ' +
        [
          row.rank,
          '[' + row.title.replace(/\|/g, '丨') + '](' + row.url + ')',
          row.author,
          pubText(row),
          fmtDuration(row.durationSec),
          row.play,
          row.like,
          row.favorites,
          row.typename,
          row.rankTotal || '—',
          flagsOf(row).join('/') || '—',
        ].join(' | ') +
        ' |',
    )
  }
  out.push('')
  out.push('## 筛选依据')
  out.push('')
  for (const row of result.rows) out.push('- **' + row.rank + '. ' + row.title + '** — ' + row.reason)
  out.push('')
  if (result.deep && result.deep.covered) {
    const ev = renderEvidence(result.rows)
    if (ev) {
      out.push(ev)
      out.push('')
    }
  }
  if (result.summary && result.summary.text) {
    out.push(result.summary.text)
    out.push('')
  }
  if (result.probe && result.probe.ok && result.probe.notes.length) {
    out.push('## 敏感性探测（供给不足时怎么放宽）')
    out.push('')
    out.push('基准（当前条件）通过数：' + result.probe.baseline + ' / 采样 ' + result.probe.sampled + ' 条')
    for (const n of result.probe.notes) out.push('- 放宽「' + n.relax + '」→ 可解锁 ' + n.unlocked + ' 条')
    out.push('')
    out.push('> ' + result.probe.sampleScope)
    out.push('')
  }
  if (result.suppressed && result.suppressed.length) {
    out.push('## 被同 UP 配额压下的条目')
    out.push('')
    for (const row of result.suppressed) out.push('- ' + row.author + ' · ' + row.title + '（播放 ' + row.play + '）')
    out.push('')
  }
  out.push('---')
  out.push('口径提醒：numResults 恒为 1000 是服务端封顶，不代表真实命中总数；本页所有比例为实际取样口径。')
  return out.join('\n')
}

/* ------------------------------------------------------------------ *
 * 一次完整跑
 * ------------------------------------------------------------------ */

export function buildReason(row, options = {}) {
  const pieces = keywordParts(options.keyword || '')
  const title = row.title.toLowerCase()
  const tag = row.tag.toLowerCase()
  const desc = row.description.toLowerCase()
  const out = []

  const hit = pieces.filter((t) => title.includes(t) || tag.includes(t) || desc.includes(t))
  const inTitle = pieces.filter((t) => title.includes(t))
  if (inTitle.length) out.push('标题含「' + inTitle.join('/') + '」')
  out.push('关键词切片命中 ' + hit.length + '/' + pieces.length)
  if (row.rankTotal) out.push('B站综合排序第 ' + row.rankTotal + ' 位')
  const age = ageDaysOf(row)
  out.push('播放 ' + row.play + '，点赞 ' + row.like + '，收藏 ' + row.favorites)
  if (age != null) out.push(Math.round(age) + ' 天前发布')
  if (row.orders.size >= 2) out.push('被 ' + [...row.orders].map((o) => ORDER_LABEL[o]).join('/') + ' 多个排序同时召回')
  return out.join('；')
}

export async function runFilter(options = {}) {
  resetCallBudget()
  // 设置页存的运行时参数（间隔/冷却/评论条数/字幕闸/落盘偏好）在这里生效：
  // 任何入口（工具、原型 CLI、探针）跑检索都会先拉到最新设置，改设置不用重启。
  syncRuntimeSettings()
  const stage = String(options.stage || 'list') === 'final' ? 'final' : 'list'
  // keep 既接受数组也接受「空格/逗号分隔的字符串」（工具参数、命令行都会传字符串过来）
  const keepList = (Array.isArray(options.keep) ? options.keep : String(options.keep || '').split(/[\s,，、|/]+/))
    .map((x) => String(x).trim())
    .filter(Boolean)
  // 强相关：模型标出「几乎与意图一致」的 bvid（2026-11-02 用户定，final 排最前、无视播放量）
  const strongList = bvidList(options.strong)
  const params = {
    keyword: String(options.keyword || '').trim(),
    days: Number(options.days || 0),
    duration: String(options.duration || 'any'),
    // 2026-11-03 用户定：临时条件 —— 自定义时长区间（分钟，0=不限）。给了区间就以区间为准
    durationMin: Math.max(0, Math.min(600, Number(options.durationMin) || 0)),
    durationMax: Math.max(0, Math.min(600, Number(options.durationMax) || 0)),
    // 没显式给就吃设置页里的播放量下限（工具侧已经由 effectiveParams 填好，这里是给 CLI/探针兜底）
    minPlay: Math.max(
      0,
      Math.min(
        1000000,
        options.minPlay === undefined || options.minPlay === null || options.minPlay === ''
          ? Number(readSettings().minPlay) || 0
          : Number(options.minPlay) || 0,
      ),
    ),
    typename: String(options.typename || ''),
    exclude: String(options.exclude || ''),
    targetN: Math.max(1, Math.min(50, Number(options.targetN) || 12)),
    upCap: Math.max(1, Number(options.upCap) || 3),
    mode: String(options.mode || 'overview') === 'deep' ? 'deep' : 'overview',
    deepTop: Math.max(1, Math.min(10, Number(options.deepTop) || 5)),
    pagesPerOrder: Math.max(1, Math.min(6, Number(options.pagesPerOrder) || 4)),
    // 默认只跑 B 站综合排序（2026-11-02 用户定）；要加回其它排序得在设置页勾
    orders: orderList(options.orders && options.orders.length ? options.orders : readSettings().orders),
    stage,
    keep: keepList,
    strong: strongList,
    // list 阶段默认跟 B 站综合排序位次（贴近站内顺序，方便模型判相关）；final 阶段默认播放量降序
    sort: options.sort === 'totalrank' || options.sort === 'play' ? options.sort : stage === 'list' ? 'totalrank' : 'play',
    candidateLimit: Math.max(
      5,
      Math.min(500, Number(options.candidateLimit) || Number(readSettings().candidateLimit) || 40),
    ),
    intent: String(options.intent || '').trim(),
  }
  if (!params.keyword) throw new Error('关键词不能为空')
  if (!(params.duration in DURATION_BANDS)) throw new Error('时长档只能是 any/1/2/3/4')
  // 2026-11-03：自定义时长区间的校验与归一 —— 区间在本地过闸，取样时不下发档位参数
  const hasCustomRange = params.durationMin > 0 || params.durationMax > 0
  if (params.durationMin > 0 && params.durationMax > 0 && params.durationMin >= params.durationMax) {
    throw new Error('自定义时长区间要满足「下限 < 上限」（单位分钟）')
  }
  if (hasCustomRange) params.duration = 'any'
  // 2026-11-02 用户定：不要拆检索词（拆开会改变意图）—— 多条必须是同义整句，碎片直接拒绝
  const variantProblem = checkVariants(queryVariants(params.keyword))
  if (variantProblem) throw new Error(variantProblem)
  // 检索词变体会多跑几轮取样，调用上限跟着放大（每条变体每排序 pagesPerVariant 页）
  const variantCount = Math.max(1, queryVariants(params.keyword).length)
  const pagesPerVariant = Math.max(1, Math.floor(params.pagesPerOrder / variantCount))
  const orderCount = orderList(params.orders).length
  const sampleBudget = pagesPerVariant * orderCount * variantCount + 8
  // deep 每条要打 详情 + player/v2 + 字幕 + 3 页评论（约 6 次），把这一轮的上限抬够，不然跑到一半被预算喊停
  if (params.mode === 'deep' && stage === 'final') {
    // 每条约 10 次：view 1 + player/v2 最多 3（字幕重试）+ 字幕下载最多 3 + 评论 3 页
    setCallBudget(sampleBudget + params.deepTop * 10)
  } else {
    setCallBudget(sampleBudget)
  }

  const pool = await samplePool(params)
  if (pool.items.length === 0) {
    // 空池子必须说清原因，不能当成「这词没人发视频」返回一个漂亮的空结果
    const why = (pool.stats.errors && pool.stats.errors[0]) || ''
    throw new Error('一条都没取到：B 站搜索接口没有返回结果' + (why ? '（' + why + '）' : '') + '。多半是被风控，隔几分钟再试；也可能是关键词太生僻。')
  }
  const g = gates(pool.items, params)

  // list：只出候选清单（不排序不评分，按位次或播放排），交给对话模型看标题剔无关；
  // final：模型给 keep 就只在 keep 里按播放量降序取，没给就整池按排序取。
  const picked =
    stage === 'list'
      ? pickRows(g.kept, { targetN: params.candidateLimit, upCap: params.upCap, sort: params.sort })
      : pickRows(g.kept, {
          targetN: params.targetN,
          upCap: params.upCap,
          sort: params.sort,
          keep: params.keep,
          strong: params.strong,
        })
  const rows = picked.rows
  const suppressed = picked.suppressed

  rows.forEach((row, i) => {
    row.rank = i + 1
    row.reason = buildReason(row, params)
  })

  const killBreakdown = {}
  let killed = 0
  for (const [key, list] of Object.entries(g.kills)) {
    killBreakdown[key] = list.length
    killed += list.length
  }

  let probe = null
  if (options.probe !== false && stage === 'final') {
    // 只看 final 收口的条数：候选清单本身不需要探测
    if (rows.length < Math.max(1, Math.ceil(params.targetN * 0.4))) {
      probe = await sensitivityProbe({ ...params, pages: 2 })
    }
  }

  const result = {
    stage,
    params,
    stats: pool.stats,
    rows,
    suppressed,
    probe,
    deep: null,
    keepMissing: picked.keepMissing,
    // 强相关（2026-11-02 用户定）：模型标出「几乎与意图一致」的条目，final 时排最前、无视播放量
    strongMissing: picked.strongMissing || [],
    strongTotal: picked.strongTotal || 0,
    strongTruncated: picked.strongTruncated || 0,
    poolFromCache: Boolean(pool.fromCache),
    funnel: {
      pool: pool.items.length,
      killed,
      kept: g.kept.length,
      killBreakdown,
      perOrder: pool.stats.perOrder,
      orders: params.orders,
      strong: rows.filter((row) => row._strong).length,
      poolFromCache: Boolean(pool.fromCache),
      errors: pool.stats.errors || [],
    },
  }

  // deep：只对收口后的前 deepTop 条取证，取证结果不回头改排序
  if (params.mode === 'deep' && stage === 'final' && rows.length) {
    const covered = await collectEvidence(rows, { topN: params.deepTop })
    result.deep = {
      topN: params.deepTop,
      covered,
      subtitleOk: rows.slice(0, covered).filter((r) => r.evidence && r.evidence.subtitle && r.evidence.subtitle.ok).length,
    }
  }

  // 总结骨架（2026-11-02 用户定）：deep 收口后按主题给一份可照着写的九节骨架
  const sCfg = readSettings()
  if (params.mode === 'deep' && stage === 'final' && rows.length && sCfg.summary !== false) {
    result.summary = buildSummarySkeleton(rows, {
      profile: sCfg.summaryProfile || 'auto',
      keyword: params.keyword,
      intent: params.intent,
    })
  }

  return result
}
