/**
 * 风控路径回归（不联网）：
 *   1) 412 HTML 拦截页 → 抛 risk 错误，且只在同一分页上退避重试（不会翻页/换排序继续刷）；
 *   2) 200 但回 HTML → 同样当拦截页；
 *   3) 命中后落盘冷却状态，同进程再调直接被冷却挡住（0 次请求）；
 *   4) clearCooldown() 能清掉。
 *   node tools/test-risk.mjs
 */
process.env.BILI_FILTER_TRANSPORT = 'fetch' // 强制走 fetch，这样下面的 stub 才生效
process.env.BILI_FILTER_BACKOFF_MS = '0,0' // 测试不等真实退避

const { runFilter, clearCooldown, cooldownRemainMs } = await import('../lib/core.js')

const realFetch = globalThis.fetch
let calls = 0
let failed = false
function ok(message) {
  console.log('✅ ' + message)
}
function bad(message) {
  console.error('❌ ' + message)
  failed = true
}

clearCooldown()

// 1) 412 拦截页
globalThis.fetch = async () => {
  calls += 1
  return new Response('<html><head><title>出错啦! - bilibili.com</title></head></html>', {
    status: 412,
    headers: { 'content-type': 'text/html' },
  })
}
try {
  await runFilter({ keyword: '风控自测', days: 7, targetN: 6 })
  bad('412 时居然返回了「成功」')
} catch (error) {
  const message = String(error && error.message ? error.message : error)
  if (!/风控/.test(message)) bad('报错文案没提风控：' + message)
  else ok('412 被识别为风控，且中止整轮：' + message)
  // 1 次原始 + 2 次退避重试，共 3 次；关键是**没有**继续翻页（2 页 × 5 排序会是 10+ 次）
  if (calls !== 3) bad('命中风控后应该只在本页退避重试（预期 3 次），实际 ' + calls + ' 次')
  else ok('命中风控后没有继续翻页（共 3 次 = 1 次原始 + 2 次退避）')
}
if (cooldownRemainMs() <= 0) bad('风控后没有落盘冷却状态')
else ok('风控后进入冷却 ' + Math.round(cooldownRemainMs() / 60000) + ' 分钟')

// 2) 冷却期内再调：0 次请求
calls = 0
try {
  await runFilter({ keyword: '风控自测-冷却', days: 7, targetN: 6 })
  bad('冷却期内居然还在打接口')
} catch (error) {
  if (calls !== 0) bad('冷却期内不该发请求，实际 ' + calls + ' 次')
  else ok('冷却期内直接拒绝，0 次请求：' + error.message)
}

// 3) 200 但回 HTML
clearCooldown()
calls = 0
globalThis.fetch = async () => {
  calls += 1
  return new Response('<html>blocked</html>', { status: 200, headers: { 'content-type': 'text/html' } })
}
try {
  await runFilter({ keyword: '风控自测2', days: 7, targetN: 6 })
  bad('200 但返回 HTML 时居然成功了')
} catch (error) {
  const message = String(error && error.message ? error.message : error)
  if (!/不是 JSON|风控/.test(message)) bad('200+HTML 的文案不对：' + message)
  else ok('200 但回 HTML 也被当拦截页：' + message)
}

// 4) 清冷却
clearCooldown()
if (cooldownRemainMs() > 0) bad('clearCooldown() 没清掉')
else ok('clearCooldown() 生效')

globalThis.fetch = realFetch
if (failed) process.exit(1)
console.log('风控路径回归通过')
