/**
 * 插件层冒烟（假 ctx，不联网）：
 *   1) index.js 能被 import，name/inject 对得上；
 *   2) apply(ctx) 把 bili_filter 工具注册上，参数被编译成 JSON Schema；
 *   3) 路由 /state、/settings 能应答（宿主起来后 curl 打的就是这两条）；
 *   4) 参数校验分支（空关键词 / 非法时长档 / 非法模式）返回 ok:false；
 *   5) 设置读写往返 + 非法值被拒 + 优先级（调用参数盖过设置默认）；
 *   6) client.js 是自注册脚本，注册到 settings.section。
 *   node tools/smoke-plugin.mjs
 *
 * ⚠ 会临时动一下真实的 settings.json：跑之前先快照原文，跑完原样还回去。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { apply, name, inject } from '../lib/index.js'
import { SETTINGS_FILE, effectiveParams, readSettings, writeSettings, DEFAULT_SETTINGS } from '../lib/settings.js'
import { PROFILES, PROFILE_ORDER, pickProfile, buildSummarySkeleton } from '../lib/summary.js'
import { renderMarkdown } from '../lib/core.js'

const snapshot = existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, 'utf8') : null
const restore = () => {
  try {
    if (snapshot === null) {
      if (existsSync(SETTINGS_FILE)) unlinkSync(SETTINGS_FILE)
    } else {
      writeFileSync(SETTINGS_FILE, snapshot, 'utf8')
    }
  } catch (error) {
    console.error('⚠ 没能还原设置文件：' + String(error.message || error))
  }
}

// 冒烟会真的写设置文件，跑完必须还原；万一被管道截断（SIGPIPE）或中途抛错也要还原
process.on('exit', restore)
process.on('SIGINT', () => {
  restore()
  process.exit(130)
})

let failed = false
function ok(m) {
  console.log('✅ ' + m)
}
function bad(m) {
  console.error('❌ ' + m)
  failed = true
}

if (name !== 'bili_filter') bad('name 不对：' + name)
else ok('name = ' + name + '，inject = [' + inject.join(', ') + ']')

const tools = []
const routes = []
const ctx = {
  tools: { register: (tool) => tools.push(tool) },
  webServer: { register: (route, desc) => (routes.push({ route, desc }), () => {}) },
  effect: (fn) => fn(),
  inject: (_deps, fn) => fn(),
  get: () => null,
}

apply(ctx)

if (tools.length !== 1) bad('应该注册 1 个工具，实际 ' + tools.length)
else {
  const tool = tools[0]
  const props = (tool.parameters && tool.parameters.properties) || {}
  const keys = Object.keys(props)
  if (tool.name !== 'bili_filter') bad('工具名不对：' + tool.name)
  else ok('工具 bili_filter 已注册，参数 ' + keys.length + ' 个：' + keys.join(', '))
  const missing = [
    'keyword',
    'stage',
    'keep',
    'sort',
    'days',
    'duration',
    'minPlay',
    'targetN',
    'candidateLimit',
    'upCap',
    'exclude',
    'typename',
    'intent',
    'strong',
    'probe',
    'outDir',
    'mode',
    'deepTop',
  ].filter((k) => !keys.includes(k))
  if (missing.length) bad('缺参数：' + missing.join(', '))
  else ok('参数齐全')
}

function fakeRes() {
  const box = { payload: '', status: 0 }
  box.res = {
    // 注意 Node 的签名是 writeHead(statusCode[, statusMessage][, headers])：状态码在前
    writeHead: (status) => {
      box.status = status || 200
    },
    end: (body) => {
      box.payload = body
    },
  }
  return box
}

async function call(method, url, body) {
  const box = fakeRes()
  const req = {
    method,
    url,
    on: (event, fn) => {
      if (event === 'data' && body !== undefined) fn(JSON.stringify(body))
      if (event === 'end') fn()
      if (event === 'error') { /* 不触发 */ }
    },
  }
  await routes[0].route.handler(req, box.res)
  return { status: box.status, json: JSON.parse(box.payload || '{}') }
}

if (routes.length !== 1) bad('应该注册 1 条路由，实际 ' + routes.length)
else {
  const { route } = routes[0]
  if (route.path !== '/bili-filter-api') bad('路由路径不对：' + route.path)
  else {
    const state = await call('GET', '/bili-filter-api/state')
    if (state.json.ok !== true || !state.json.version) bad('/state 返回不对：' + JSON.stringify(state.json))
    else {
      ok('/state：version=' + state.json.version + ' transport=' + state.json.transport + ' cooldown=' + state.json.cooldownMinutes + ' 分钟')
      if (!state.json.settingsFile) bad('/state 没带 settingsFile')
      else ok('/state 带设置文件路径')
    }

    const cfg = await call('GET', '/bili-filter-api/settings')
    if (!cfg.json.ok || !cfg.json.settings || !cfg.json.limits) bad('/settings 返回不对')
    else ok('/settings 返回设置 + 上下限（' + Object.keys(cfg.json.limits).length + ' 项）')

    const goodPatch = await call('POST', '/bili-filter-api/settings', { days: 7, gapMs: 1200 })
    if (!goodPatch.json.ok) bad('合法设置没存上：' + JSON.stringify(goodPatch.json.errors))
    else {
      const back = readSettings()
      if (back.days !== 7 || back.gapMs !== 1200) bad('设置没生效：' + JSON.stringify(back))
      else ok('设置往返：days=' + back.days + ' gapMs=' + back.gapMs)
    }

    const tooFast = await call('POST', '/bili-filter-api/settings', { gapMs: 150 })
    if (tooFast.json.ok !== false || tooFast.status !== 400) bad('间隔 150ms 竟然被接受了')
    else ok('间隔低于 200ms 被拒：' + tooFast.json.errors.map((e) => e.field).join(','))

    const noFormat = await call('POST', '/bili-filter-api/settings', { formats: { md: false, csv: false, json: false } })
    if (noFormat.json.ok !== false) bad('三种格式全关竟然被接受了')
    else ok('三种落盘格式全关被拒')

    const badNumber = await call('POST', '/bili-filter-api/settings', { days: 'abc' })
    if (badNumber.json.ok !== false) bad('days=abc 竟然被接受了')
    else ok('非数字被拒')

    // 播放量下限（硬闸 G7）：能存、越界被拒
    const playOk = await call('POST', '/bili-filter-api/settings', { minPlay: 5000 })
    if (!playOk.json.ok) bad('播放量下限没存上：' + JSON.stringify(playOk.json.errors))
    else if (readSettings().minPlay !== 5000) bad('播放量下限没生效：' + readSettings().minPlay)
    else ok('播放量下限可设置（minPlay=' + readSettings().minPlay + '）')
    const playBad = await call('POST', '/bili-filter-api/settings', { minPlay: -1 })
    if (playBad.json.ok !== false) bad('播放量下限 -1 竟然被接受了')
    else ok('播放量下限 -1 被拒')

    // 取样排序（2026-11-02 用户定：默认只用综合排序）
    const ordOk = await call('POST', '/bili-filter-api/settings', { orders: ['totalrank', 'click'] })
    if (!ordOk.json.ok) bad('排序没存上：' + JSON.stringify(ordOk.json.errors))
    else if (readSettings().orders.join(',') !== 'totalrank,click') bad('排序没生效：' + JSON.stringify(readSettings().orders))
    else ok('排序可设置（' + readSettings().orders.join('+') + '）')
    const ordBad = await call('POST', '/bili-filter-api/settings', { orders: ['totalrank', 'nope'] })
    if (ordBad.json.ok !== false) bad('非法排序竟然被接受了')
    else ok('非法排序被拒')
    const ordBack = await call('POST', '/bili-filter-api/settings', { orders: ['totalrank'] })
    if (!ordBack.json.ok || readSettings().orders.join(',') !== 'totalrank') bad('排序复位失败')
    else ok('排序复位为只有综合排序')
    if (String(DEFAULT_SETTINGS.orders) !== 'totalrank') bad('内置默认排序不是只有综合：' + DEFAULT_SETTINGS.orders)
    else ok('内置默认排序 = totalrank')
    // 请求间隔（2026-11-02 用户定：先 340ms，出现 412 再加）
    const gapOk = await call('POST', '/bili-filter-api/settings', { gapMs: 340 })
    if (!gapOk.json.ok || readSettings().gapMs !== 340) bad('请求间隔 340 没存上：' + JSON.stringify(gapOk.json.errors))
    else ok('请求间隔 340ms 可存')
    const gapBad = await call('POST', '/bili-filter-api/settings', { gapMs: 50 })
    if (gapBad.json.ok !== false) bad('请求间隔 50ms 竟然被接受了')
    else ok('请求间隔 50ms 被拒（下限 200）')

    const merged = effectiveParams({ days: 3 }, readSettings())
    const fallback = effectiveParams({}, readSettings())
    if (merged.days !== 3) bad('调用参数没盖过设置默认：' + merged.days)
    else if (fallback.days !== 7) bad('设置默认没生效：' + fallback.days)
    else ok('优先级正确：调用参数 3 > 设置默认 7 > 内置 ' + DEFAULT_SETTINGS.days)
  }
}

// 参数校验分支
const tool = tools[0]
for (const [label, args, expect] of [
  ['空关键词', { keyword: '  ' }, '要搜什么'],
  ['非法时长档', { keyword: 'x', duration: '9' }, '时长档'],
  ['非法模式', { keyword: 'x', mode: 'summary' }, 'overview'],
]) {
  const result = await tool.execute(args)
  if (result.ok !== false || !String(result.message).includes(expect)) bad(label + ' 分支不对：' + JSON.stringify(result))
  else ok(label + ' 分支正确：' + String(result.message).slice(0, 40))
}

// 硬闸 G7（播放量下限）：不联网，直接喂假条目
{
  const { gates, checkVariants, queryVariants, pickRows } = await import('../lib/core.js')
  const now = Math.floor(Date.now() / 1000)
  const mk = (bvid, title, play) => ({
    bvid,
    title,
    tag: '',
    description: '',
    play,
    like: 1,
    favorites: 1,
    review: 1,
    pubdate: now - 86400,
    durationSec: 100,
    durationText: '1:40',
    mid: bvid,
    typename: '生活',
    orders: new Set(['totalrank']),
  })
  const g = gates([mk('BV1aaa', '播放一百的片子', 100), mk('BV2bbb', '播放九千的片子', 9000)], { minPlay: 1000 })
  if (g.kills.G7.length !== 1 || g.kept.length !== 1) {
    bad('G7 播放量下限没生效：kills.G7=' + g.kills.G7.length + ' kept=' + g.kept.length)
  } else ok('G7 播放量下限生效（<1000 淘汰 1 条，留 1 条）')
  const g0 = gates([mk('BV1aaa', '播放一百的片子', 100)], { minPlay: 0 })
  if (g0.kept.length !== 1) bad('minPlay=0 时不该淘汰')
  else ok('minPlay=0 视为不限')

  // 2026-11-02 用户定：G6（字段缺失）已删 —— 缺字段不再淘汰
  const g6 = gates([{ ...mk('BV3ccc', '', 0), title: '', play: null }], { minPlay: 0 })
  if (g6.kept.length !== 1 || g6.kills.G6) bad('字段缺失还被硬淘汰（G6 应已删除）')
  else ok('字段缺失不再淘汰（G6 已删，标题/播放补成空值与 0）')

  // 2026-11-02 用户定：拆检索词要拒绝，同义整句放行
  const bad1 = checkVariants(queryVariants('AI视频 价格 | AI视频'))
  if (!bad1) bad('拆词没被拒绝（「AI视频 价格 | AI视频」应报错）')
  else ok('拆词被拒绝（片段式检索词报错）')
  const bad2 = checkVariants(queryVariants('AI视频 价格 | AI视频 生成 多少钱 | AI视频 模型 费用'))
  if (bad2) bad('同义整句被误判成拆词：' + bad2)
  else ok('同义整句放行（多条互不为片段）')

  // 2026-11-02 用户定：强相关排最前，无视播放量（组内按播放量降序）
  const rows4 = [mk('BVa', '甲', 9000), mk('BVb', '乙', 800), mk('BVc', '丙', 300), mk('BVd', '丁', 200)]
  const picked = pickRows(rows4, { targetN: 4, upCap: 3, sort: 'play', keep: 'BVa,BVb,BVc,BVd', strong: 'BVc' })
  if (picked.rows[0].bvid !== 'BVc' || !picked.rows[0]._strong) {
    bad('强相关没排到最前：' + picked.rows.map((r) => r.bvid).join(','))
  } else ok('强相关排最前（无视播放量：300 播放压过 9000）')
  const picked2 = pickRows(rows4, { targetN: 2, upCap: 3, sort: 'play', keep: 'BVa,BVb,BVc,BVd', strong: 'BVa,BVb,BVc' })
  if (picked2.strongTruncated !== 1) bad('强相关截断数不对：' + picked2.strongTruncated)
  else ok('强相关超过条数时给出截断数（1 条）')
  const picked3 = pickRows(rows4, { targetN: 2, upCap: 3, sort: 'play', keep: 'BVa,BVb', strong: 'BVzz' })
  if (picked3.strongMissing.length !== 1 || picked3.strongMissing[0] !== 'BVzz') bad('强相关里池子没有的 bvid 没单独回报')
  else ok('强相关里对不上的 bvid 单独回报')
}

// 总结骨架（2026-11-02 用户定：九节 + L0 硬规则 + 评论规则 + 主题 profile）
{
  const ids = Object.keys(PROFILES)
  if (PROFILE_ORDER.length === 8 && ids.length === 8 && ids.includes('generic')) ok('总结 profile 共 8 类：' + ids.join('/'))
  else bad('总结 profile 数量不对：' + ids.join('/'))

  const pickedPrice = pickProfile({ keyword: 'AI视频 价格 套餐 多少钱' })
  if (pickedPrice.id === 'price') ok('主题判定：价格类 → price（' + pickedPrice.reason + '）')
  else bad('主题判定没选到 price，得到 ' + pickedPrice.id)

  const pickedEmpty = pickProfile({ keyword: '' })
  if (pickedEmpty.id === 'generic') ok('关键词为空 → generic')
  else bad('空关键词应回 generic，得到 ' + pickedEmpty.id)

  const fakeRow = {
    bvid: 'BV1xxxxxxx',
    title: '价格横评',
    play: 100,
    orders: new Set(['totalrank']),
    evidence: {
      subtitle: { ok: true, segments: 10, chars: 100, coverage: 0.9, charsPerMin: 120, attempts: 2 },
      comments: { count: 5, total: 9 },
    },
  }
  const built = buildSummarySkeleton([fakeRow], { keyword: '价格 套餐' })
  const need = [
    '证据成色',
    '关键数字与事实表',
    '投入与代价',
    '关键维度对比',
    '参与方与形态',
    '局限与坑',
    '评论区',
    '按情况对号',
    '缺口与剔除声明',
    '抓取 N 条，纳入 M 条。',
  ]
  const miss = need.filter((k) => !built.text.includes(k))
  if (!miss.length && built.profile === 'price' && String(built.unit).includes('元/秒')) {
    ok('骨架含九节 + 评论统计行（profile=' + built.profile + '，单位=' + built.unit + '）')
  } else bad('骨架缺内容：' + miss.join(','))

  const mdResult = {
    stage: 'final',
    params: {
      keyword: '价格',
      mode: 'deep',
      duration: 'any',
      targetN: 3,
      sort: 'play',
      orders: ['totalrank'],
      days: 30,
      minPlay: 0,
      candidateLimit: 10,
      upCap: 3,
      deepTop: 1,
    },
    rows: [
      {
        ...fakeRow,
        rank: 1,
        url: 'https://www.bilibili.com/video/BV1xxxxxxx',
        author: '某UP',
        durationSec: 60,
        like: 1,
        favorites: 1,
        pubdate: Math.floor(Date.now() / 1000) - 86400,
        typename: '科技',
        reason: '标题含「价格」',
      },
    ],
    funnel: { pool: 1, killed: 0, kept: 1, killBreakdown: {}, perOrder: {}, orders: ['totalrank'], errors: [] },
    probe: null,
    suppressed: [],
    summary: built,
  }
  const md = renderMarkdown(mdResult)
  if (md.includes('## 总结骨架')) ok('deep 落盘 md 含总结骨架')
  else bad('md 里没有总结骨架')

  const s1 = writeSettings({ summary: false, summaryProfile: 'price' })
  if (!s1.ok || readSettings().summary !== false || readSettings().summaryProfile !== 'price') {
    bad('summary 设置没存上：' + JSON.stringify(s1.errors || []))
  } else ok('总结骨架开关与主题可存（summary=false，profile=price）')

  const s2 = writeSettings({ summaryProfile: 'nope' })
  if (!s2.ok && (s2.errors || []).some((e) => e.field === 'summaryProfile')) ok('非法总结主题被拒')
  else bad('非法 summaryProfile 没被拒')

  writeSettings({ summary: true, summaryProfile: 'auto' })
}

// 浏览器半边：必须是自注册脚本、必须注册到 settings.section
try {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const checks = [
    ['window.__ModuleLoader__.load', client.includes('window.__ModuleLoader__.load(')],
    ["id: 'dsh-bili-search'", client.includes("id: 'dsh-bili-search'")],
    ['settings.section 槽位', client.includes("'settings.section'")],
    ['label B站筛选', client.includes("label: 'B站筛选'")],
    ['打自己的接口', client.includes("'/bili-filter-api'")],
  // 2026-11-02 用户定：设置页改成自动保存（改动即落盘），保存按钮应当已经删掉
  ['自动保存文案', client.includes('已自动保存')],
  ['没有保存按钮', !client.includes("onClick: save")],
  ]
  const fails = checks.filter(([, hit]) => !hit).map(([what]) => what)
  if (fails.length) bad('client.js 缺：' + fails.join('、'))
  else ok('client.js 是自注册脚本，注册到 settings.section（label「B站筛选」）')

  // 不装 React 也能验「注册路径通不通」：给一个最小的 createElement / hooks 替身，
  // 把 factory 跑起来，看它有没有往 settings.section 注册一节、以及 Panel 首次渲染会不会抛。
  let registered = null
  let mod = null
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? undefined : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    // 设置页的自动保存用到了 useRef（2026-11-02），给个稳定对象即可
    useRef: (init) => ({ current: init === undefined ? null : init }),
  }
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        mod = { id, api: factory((name) => (name === 'react' ? fakeReact : {})) }
      },
    },
  }
  globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }), head: { appendChild() {} } }
  const { pathToFileURL } = await import('node:url')
  await import(new URL('../client.js', import.meta.url).href)
  if (!mod || mod.id !== 'dsh-bili-search') bad('client.js 没按 dsh-bili-search 注册')
  else if (!mod.api || typeof mod.api.apply !== 'function' || !Array.isArray(mod.api.inject)) bad('client.js 的 factory 没返回 {inject, apply}')
  else {
    const slots = { inject: (_slot, fn) => fn(), register: (spec, comp) => (registered = { spec, comp }) }
    mod.api.apply({ get: () => slots, effect: (fn) => fn() })
    if (!registered || registered.spec.name !== 'settings.section' || registered.spec.label !== 'B站筛选') {
      bad('没往 settings.section 注册：' + JSON.stringify(registered && registered.spec))
    } else {
      // 槽位里存的是一个组件（() => h(Panel)）。拿它的类型跑一遍首渲染：
      // 假 hooks 下 useState 拿到的是初值 null，走的是「读取中」那一支，够验有没有炸。
      const holder = registered.comp()
      const Panel = holder && holder.type
      if (typeof Panel !== 'function') bad('注册进槽位的不是组件：' + typeof Panel)
      else {
        const tree = Panel()
        if (!tree || tree.type !== 'div') bad('Panel 首次渲染没产出节点')
        else ok('client.js 注册进设置页（id=' + registered.spec.id + '，order=' + registered.spec.order + '），Panel 首渲染不抛')
      }
    }
  }
} catch (error) {
  bad('client.js 装载失败：' + String(error.message || error))
}

restore()

if (failed) process.exit(1)
console.log('插件层冒烟通过')
