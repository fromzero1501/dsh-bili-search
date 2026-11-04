/**
 * 离线断言「一次检索到底打了几次请求」。
 *
 * 为什么要有这个：单测里只看条数、不看请求数，等于允许「多打十次请求换同样的结果」。
 * 这里把 fetch 打桩，数 URL，把两件最容易失控的事钉死：
 *   1) list 阶段固定 1 排序 1 页 = 1 次搜索请求（多出来的就是白打）；
 *   2) 同参数的 final 阶段必须 0 次搜索请求（复用 list 的池子）。
 *
 * 用法：node tools/test-requests.mjs
 * 不发真请求：BILI_FILTER_TRANSPORT=fetch + 打桩 globalThis.fetch。
 */
import { runFilter, clearPoolCache } from '../lib/core.js'

process.env.BILI_FILTER_TRANSPORT = 'fetch'

const hits = { search: 0, wbiSearch: 0, nav: 0, img: 0, other: 0 }
const urls = []

function fakeItem(n) {
  return {
    bvid: 'BV1test' + String(n).padStart(4, '0'),
    title: '测试条目 ' + n + ' AI视频 价格',
    author: 'UP' + n,
    mid: 1000 + n,
    play: 10000 * n,
    like: 100 * n,
    favorites: 50 * n,
    video_review: 10,
    review: 5,
    duration: '10:00',
    pubdate: Math.floor(Date.now() / 1000) - 86400 * 2,
    tag: 'AI,测试',
    typename: '科技',
    typeid: 188,
    description: '这是第 ' + n + ' 条测试描述',
  }
}

globalThis.fetch = async (url) => {
  const u = String(url)
  urls.push(u)
  if (u.includes('/x/web-interface/wbi/search/type')) {
    hits.wbiSearch += 1
    return jsonRes({ code: 0, data: { result: [fakeItem(1), fakeItem(2), fakeItem(3)], numResults: 1000, page: 1 } })
  }
  if (u.includes('/x/web-interface/search/type')) {
    hits.search += 1
    return jsonRes({ code: 0, data: { result: [fakeItem(4), fakeItem(5), fakeItem(6)], numResults: 1000, page: 1 } })
  }
  if (u.includes('/x/web-interface/nav')) {
    hits.nav += 1
    return jsonRes({
      code: 0,
      data: {
        wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
        },
      },
    })
  }
  if (/\.(png|jpg)$/.test(u)) {
    hits.img += 1
    return textRes('png')
  }
  hits.other += 1
  return jsonRes({ code: 0, data: {} })
}

function jsonRes(body) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body)
    },
    async json() {
      return body
    },
  }
}
function textRes(text) {
  return {
    ok: true,
    status: 200,
    async text() {
      return text
    },
    async json() {
      return {}
    },
  }
}

const results = []
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail })
  console.log((cond ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
}

const base = {
  keyword: 'AI视频 价格 横评',
  days: 30,
  duration: 'any',
  minPlay: 0,
  orders: ['totalrank'],
  pagesPerOrder: 1,
  mode: 'overview',
  // 敏感性探测会额外取样（final 且供给不足时），测「取样请求数」时必须关掉，
  // 否则数出来的 1 次是探测、不是重搜。
  probe: false,
}

clearPoolCache()
hits.search = hits.wbiSearch = hits.nav = hits.img = hits.other = 0

// 1) list：1 排序 1 页
const list = await runFilter({ ...base, stage: 'list', candidateLimit: 20 })
const searchCalls = hits.search + hits.wbiSearch
check('list 阶段只打 1 次搜索请求', searchCalls === 1, '实际 ' + searchCalls + '（wbi ' + hits.wbiSearch + ' / 免签名 ' + hits.search + '）')
check('list 阶段有候选', list.rows.length > 0, '候选 ' + list.rows.length + ' 条')

// 2) 立刻重跑同参数：池子命中，0 次
const before = hits.search + hits.wbiSearch
const again = await runFilter({ ...base, stage: 'list', candidateLimit: 20 })
const cachedCalls = hits.search + hits.wbiSearch - before
check('同参数立刻重跑 = 0 次搜索请求（池子复用）', cachedCalls === 0, '实际 ' + cachedCalls + ' 次；fromCache=' + Boolean(again.fromCache))

// 3) final 阶段复用 list 的池子：0 次
const keep = list.rows.slice(0, 3).map((r) => r.bvid).join(',')
const beforeFinal = hits.search + hits.wbiSearch
const final = await runFilter({ ...base, stage: 'final', keep, targetN: 10, intent: '测试' })
const finalCalls = hits.search + hits.wbiSearch - beforeFinal
check('final 阶段 = 0 次搜索请求（复用候选池）', finalCalls === 0, '实际 ' + finalCalls + ' 次')
check('final 阶段命中的是缓存', Boolean(final.stats && final.stats.cached), 'cached=' + Boolean(final.stats && final.stats.cached))
check('final 阶段只出 keep 里的条目', final.rows.length <= 3 && final.rows.every((r) => keep.includes(r.bvid)), '输出 ' + final.rows.length + ' 条')

// 3b) 敏感性探测：开着时最多补 2 页取样（这是它唯一允许的额外请求）
const beforeProbe = hits.search + hits.wbiSearch
await runFilter({ ...base, probe: true, stage: 'final', keep, targetN: 40, intent: '测试' })
const probeCalls = hits.search + hits.wbiSearch - beforeProbe
check('敏感性探测额外取样 ≤ 2 次', probeCalls <= 2, '实际 ' + probeCalls + ' 次')

// 4) 换了检索词就必须重新取样（缓存键要跟关键词走）
const beforeOther = hits.search + hits.wbiSearch
await runFilter({ ...base, keyword: '完全不同的词 ' + Date.now(), stage: 'list', candidateLimit: 5 })
const otherCalls = hits.search + hits.wbiSearch - beforeOther
check('换关键词后重新取样 1 次', otherCalls === 1, '实际 ' + otherCalls + ' 次')

// 5) 全程不该打无关端点
check('没有打无关端点', hits.other === 0, '无关 ' + hits.other + ' 次')

const bad = results.filter((r) => !r.ok)
console.log('')
console.log('请求计数断言：' + (results.length - bad.length) + '/' + results.length + ' 通过')
if (bad.length) {
  for (const b of bad) console.log('  未通过：' + b.name + ' — ' + (b.detail || ''))
  process.exit(1)
}
console.log('✓ 请求计数断言全部通过')
