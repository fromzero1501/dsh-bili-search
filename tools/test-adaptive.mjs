/**
 * 风控韧性回归（不联网、不打真接口）：
 *   1) 静默期文件：写入 / 读取 / 清除，且静默期内调用会先等而不是报错；
 *   2) 自适应间隔（AIMD）：撞一次风控翻倍、连续成功 3 次回落，状态落盘；
 *   3) 变体页数：4 条变体保底 2 页（不再「各取 1 页」），单变体仍然尊重显式 pagesPerOrder；
 *   4) 部分失败保留：第 2 页 412 且手上已有候选时，带 partial 收工，不整轮作废。
 *   node tools/test-adaptive.mjs
 *
 * ⚠ 会临时写 ~/.bili-filter 下的 silent.json / adaptive.json，跑完自己清掉。
 */
process.env.BILI_FILTER_TRANSPORT = 'fetch' // 强制走 fetch，才能给 globalThis.fetch 打桩
process.env.BILI_FILTER_BACKOFF_MS = '0,0' // 不等真实退避

const core = await import('../lib/core.js')
const {
  samplePool,
  clearCooldown,
  cooldownRemainMs,
  markSilence,
  silenceRemainMs,
  clearSilence,
  adaptiveState,
  resetAdaptive,
  effectiveGapMs,
} = core

let failed = 0
function ok(message) {
  console.log('✅ ' + message)
}
function bad(message) {
  console.error('❌ ' + message)
  failed = true
}

const realFetch = globalThis.fetch
const rowsFor = (n) =>
  Array.from({ length: n }, (_, i) => ({
    bvid: 'BVtest' + String(i).padStart(4, '0'),
    aid: 1000 + i,
    title: '测试视频 ' + i,
    author: 'up' + (i % 5),
    mid: 100 + (i % 5),
    typename: '日常',
    typeid: 21,
    pubdate: Math.floor(Date.now() / 1000) - 86400,
    play: 5000 + i,
    like: 100,
    favorites: 50,
    video_review: 10,
    review: 3,
    duration: '05:00',
    tag: '测试',
    description: '说明',
  }))

const okJson = (data) =>
  new Response(JSON.stringify({ code: 0, message: '0', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
const blocked = () =>
  new Response('<html><head><title>出错啦! - bilibili.com</title></head></html>', {
    status: 412,
    headers: { 'content-type': 'text/html' },
  })

/* ---------------- 1) 静默期 ---------------- */
clearSilence()
if (silenceRemainMs() > 0) bad('清掉之后不该还在静默期')
else ok('静默期初始为 0')

const until = markSilence(60000, '测试用探针')
if (silenceRemainMs() <= 0) bad('markSilence 写进去之后应当还在静默期')
else ok('markSilence 生效（约 ' + Math.ceil(silenceRemainMs() / 1000) + ' 秒）')
if (!until) bad('markSilence 应返回截止时间戳')
clearSilence()
if (silenceRemainMs() > 0) bad('clearSilence 没清掉')
else ok('clearSilence 生效')

/* ---------------- 2) 自适应间隔（AIMD） ---------------- */
resetAdaptive()
const gap0 = effectiveGapMs()
globalThis.fetch = async () => blocked()
clearCooldown()
try {
  await core.callApi('https://api.bilibili.com/x/web-interface/search/type?keyword=x')
  bad('412 时 callApi 居然没抛')
} catch {
  /* 预期抛 risk */
}
const gapAfterRisk = adaptiveState().gapMs || 0
if (gapAfterRisk >= 600) ok('撞一次风控后学习间隔抬到 ' + gapAfterRisk + 'ms')
else bad('撞风控后学习间隔没抬起来：' + gapAfterRisk)
if (effectiveGapMs() >= gap0 && effectiveGapMs() === Math.max(gap0, gapAfterRisk))
  ok('实际生效间隔取「设置值」与「学习值」的较大者（' + effectiveGapMs() + 'ms）')
else bad('effectiveGapMs 计算不对：' + effectiveGapMs())

clearCooldown()
globalThis.fetch = async () => okJson({ result: [], numResults: 0 })
for (let i = 0; i < 3; i += 1) {
  await core.callApi('https://api.bilibili.com/x/web-interface/search/type?keyword=y')
}
const gapAfterRecover = adaptiveState().gapMs || 0
if (gapAfterRecover < gapAfterRisk) ok('连续成功 3 次后学习间隔回落到 ' + gapAfterRecover + 'ms')
else bad('连续成功后学习间隔没回落：' + gapAfterRecover)
resetAdaptive()
if (effectiveGapMs() !== gap0) bad('resetAdaptive 后应回到设置值')
else ok('resetAdaptive 生效')

/* ---------------- 3) 变体页数 ---------------- */
globalThis.fetch = async () => okJson({ result: [], numResults: 0 })
const multi = await samplePool({ keyword: '甲 测试|乙 测试|丙 测试|丁 测试', pagesPerOrder: 3, noCache: true })
if (multi.stats.pagesPerVariant === 2) ok('4 条变体 → 每个变体保底 2 页（原来只会给 1 页）')
else bad('4 条变体的页数不对：' + multi.stats.pagesPerVariant)

const single = await samplePool({ keyword: '单个 测试', pagesPerOrder: 1, noCache: true })
if (single.stats.pagesPerVariant === 1) ok('单变体仍然尊重显式 pagesPerOrder=1')
else bad('单变体页数被改坏了：' + single.stats.pagesPerVariant)

/* ---------------- 4) 部分失败保留 ---------------- */
clearCooldown()
let searchHits = 0
globalThis.fetch = async (url) => {
  const u = String(url)
  if (!u.includes('search/type')) return okJson({})
  searchHits += 1
  const page = new URL(u).searchParams.get('page') || '1'
  if (page === '1') return okJson({ result: rowsFor(50), numResults: 1000 })
  return blocked()
}
let partial = null
try {
  partial = await samplePool({ keyword: '部分失败 测试', pagesPerOrder: 2, noCache: true })
} catch (error) {
  bad('已有候选时命中风控仍然整轮作废了：' + error.message)
}
if (partial) {
  if (partial.stats.partial === true) ok('第 2 页 412 → 带 partial 标记收工，不整轮作废')
  else bad('没打上 partial 标记')
  if (partial.items.length === 50) ok('已取到的 50 条全部保留')
  else bad('保留条数不对：' + partial.items.length)
  if (silenceRemainMs() > 0) ok('顺手写了短静默期（' + Math.ceil(silenceRemainMs() / 1000) + ' 秒）')
  else bad('部分失败后没有写静默期')
}

/* 空池遇风控仍然要抛（不能拿空池子冒充「没结果」） */
clearSilence()
clearCooldown()
globalThis.fetch = async (url) => {
  const u = String(url)
  if (!u.includes('search/type')) return okJson({})
  return blocked()
}
try {
  await samplePool({ keyword: '空池风控 测试', pagesPerOrder: 1, noCache: true })
  bad('一条都没取到时居然没抛错')
} catch (error) {
  if (/风控/.test(String(error.message))) ok('一条都没取到时照旧抛风控错：' + error.message.slice(0, 40))
  else bad('错误文案不对：' + error.message)
}

/* ---------------- 收尾：清掉测试留下的状态 ---------------- */
globalThis.fetch = realFetch
clearCooldown()
clearSilence()
resetAdaptive()
if (cooldownRemainMs() > 0 || silenceRemainMs() > 0) bad('收尾没清干净')
else ok('测试状态已清理（冷却 / 静默期 / 自适应）')

if (failed) {
  console.error('风控韧性回归失败 ' + failed + ' 项')
  process.exit(1)
}
console.log('风控韧性回归通过')
