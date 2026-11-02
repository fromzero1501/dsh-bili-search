// 一次性：带时间戳导出完整 AI 字幕（按每 ~10 段合并成一行，便于阅读）
// 用法：node tools/dump-transcript-ts.mjs BV1yQha61Epd [每行段数]
import { callApi } from '../lib/core.js'

const bvid = process.argv[2]
const per = Number(process.argv[3] || 10)
if (!bvid) {
  console.error('用法：node tools/dump-transcript-ts.mjs <BV号> [每行段数]')
  process.exit(1)
}

const view = await callApi('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
  referer: 'https://www.bilibili.com/video/' + bvid,
})
const player = await callApi(
  'https://api.bilibili.com/x/player/v2?bvid=' + bvid + '&cid=' + view.cid,
  { referer: 'https://www.bilibili.com/video/' + bvid },
)
const list = (player.subtitle && player.subtitle.subtitles) || []
const pick =
  list.find((s) => s.subtitle_url && /ai-zh|zh/i.test(s.lang || s.lan)) ||
  list.find((s) => s.subtitle_url)
if (!pick) {
  console.error('没有可用字幕')
  process.exit(2)
}
let url = pick.subtitle_url
if (url.startsWith('//')) url = 'https:' + url
const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
const body = (await res.json()).body || []

const mmss = (sec) => {
  const s = Math.floor(Number(sec) || 0)
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}

const lines = []
for (let i = 0; i < body.length; i += per) {
  const chunk = body.slice(i, i + per)
  const text = chunk.map((x) => x.content).join('')
  lines.push('[' + mmss(chunk[0].from) + '] ' + text)
}
console.log('BVID=' + bvid + ' 段数=' + body.length + ' 行数=' + lines.length)
console.log(lines.join('\n'))
