// 一次性：把某条视频的完整 AI 字幕导出来看（deep 模式的摘录只有前 1200 字，价格表常在后面）
// 用法：node tools/dump-transcript.mjs BV1yQha61Epd
import { callApi } from '../lib/core.js'

const bvid = process.argv[2]
if (!bvid) {
  console.error('用法：node tools/dump-transcript.mjs <BV号>')
  process.exit(1)
}

const view = await callApi('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
  referer: 'https://www.bilibili.com/video/' + bvid,
})
const cid = view.cid
const player = await callApi(
  'https://api.bilibili.com/x/player/v2?bvid=' + bvid + '&cid=' + cid,
  { referer: 'https://www.bilibili.com/video/' + bvid },
)
const list = (player.subtitle && player.subtitle.subtitles) || []
const pick = list.find((s) => s.subtitle_url && /ai-zh|zh/i.test(s.lang || s.lan)) ||
  list.find((s) => s.subtitle_url)
if (!pick) {
  console.error('没有可用字幕，字幕条目：' + JSON.stringify(list.map((s) => s.lan || s.lang)))
  process.exit(2)
}
let url = pick.subtitle_url
if (url.startsWith('//')) url = 'https:' + url
const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
const data = await res.json()
const body = data.body || []
const text = body.map((x) => x.content).join('')
console.log('BVID=' + bvid + ' cid=' + cid + ' 段数=' + body.length + ' 字数=' + text.length)
console.log('---- 全文 ----')
console.log(text)
