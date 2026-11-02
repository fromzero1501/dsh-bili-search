// 候选池复用回归：不联网，用假的 fetch 顶住传输层，验证「同参数第二次取样 0 次请求」。
// 2026-11-02 用户定：加缓存复用（list 取回来的池子，final 不再重搜一遍）。
process.env.BILI_FILTER_TRANSPORT = 'fetch'

let calls = 0
let searchCalls = 0
const fakeRows = [
  {
    bvid: 'BV1cache001',
    title: '缓存测试条目一',
    author: 'UP甲',
    mid: 1,
    play: 12000,
    like: 300,
    favorites: 40,
    video_review: 10,
    review: 5,
    pubdate: Math.floor(Date.now() / 1000) - 3600,
    duration: '03:20',
    tag: '测试',
    typename: '生活',
    description: '描述',
  },
  {
    bvid: 'BV1cache002',
    title: '缓存测试条目二',
    author: 'UP乙',
    mid: 2,
    play: 8000,
    like: 120,
    favorites: 20,
    video_review: 4,
    review: 2,
    pubdate: Math.floor(Date.now() / 1000) - 7200,
    duration: '05:10',
    tag: '测试',
    typename: '生活',
    description: '描述',
  },
]

globalThis.fetch = async (url) => {
  calls += 1
  const text = String(url)
  let body
  if (text.includes('/x/web-interface/nav')) {
    body = {
      code: 0,
      data: {
        wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
        },
      },
    }
  } else {
    searchCalls += 1
    body = { code: 0, data: { result: fakeRows, numResults: 1000 } }
  }
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => JSON.stringify(body),
  }
}

const core = await import('../lib/core.js')

let failed = 0
const ok = (msg) => console.log('  ✓ ' + msg)
const bad = (msg) => {
  failed += 1
  console.log('  ✗ ' + msg)
}

core.clearPoolCache()

const first = await core.samplePool({ keyword: '缓存测试词', days: 30, pagesPerOrder: 1 })
if (first.fromCache !== false) bad('第一次取样不该命中缓存')
else if (first.items.length !== 2) bad('第一次取样条目数不对：' + first.items.length)
else ok('第一次取样真打了接口（' + first.items.length + ' 条）')

const beforeSecond = searchCalls
const second = await core.samplePool({ keyword: '缓存测试词', days: 30, pagesPerOrder: 1 })
if (second.fromCache !== true) bad('同参数第二次取样本该命中缓存')
else if (searchCalls !== beforeSecond) bad('命中缓存却还打了 ' + (searchCalls - beforeSecond) + ' 次搜索接口')
else if (second.items.length !== 2) bad('缓存里的条目数不对：' + second.items.length)
else ok('同参数第二次取样：命中缓存、0 次搜索请求')

const beforeThird = searchCalls
const third = await core.samplePool({ keyword: '缓存测试词', days: 7, pagesPerOrder: 1 })
if (third.fromCache !== false) bad('参数变了（days）却仍命中缓存')
else if (searchCalls <= beforeThird) bad('参数变了却没重新请求')
else ok('参数变了（days 30→7）就重新取样')

// 排序不同也该换 key
const beforeFourth = searchCalls
await core.samplePool({ keyword: '缓存测试词', days: 30, pagesPerOrder: 1, orders: ['totalrank', 'click'] })
if (searchCalls <= beforeFourth) bad('排序变了却命中缓存')

// 默认只跑综合排序
const solo = await core.samplePool({ keyword: '缓存测试词默认排序', days: 30, pagesPerOrder: 1 })
const orders = (solo.items[0] && solo.items[0].orders) ? [...solo.items[0].orders] : []
if (orders.length !== 1 || orders[0] !== 'totalrank') bad('默认排序不是只有 totalrank：' + JSON.stringify(orders))
else ok('默认只用综合排序（orders=' + orders.join(',') + '）')

core.clearPoolCache()
console.log(failed === 0 ? '缓存复用回归通过' : '缓存复用回归失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
