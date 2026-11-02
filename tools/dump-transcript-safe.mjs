// 一次性：带时间戳导出完整字幕，并做「串台校验」——B 站同一条视频每次返回的字幕文件可能不同/张冠李戴
// 用法：node tools/dump-transcript-safe.mjs BV1yQha61Epd [关键词用,分隔] [每行段数]
import { callApi } from '../lib/core.js'

const bvid = process.argv[2]
const hints = (process.argv[3] || '').split(/[,，]/).filter(Boolean)
const per = Number(process.argv[4] || 20)
if (!bvid) {
  console.error('用法：node tools/dump-transcript-safe.mjs <BV号> [关键词] [每行段数]')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mmss = (sec) => {
  const s = Math.floor(Number(sec) || 0)
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}

const view = await callApi('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
  referer: 'https://www.bilibili.com/video/' + bvid,
})
const duration = view.duration

let best = null
for (let attempt = 1; attempt <= 4; attempt += 1) {
  if (attempt > 1) await sleep(1200)
  const player = await callApi(
    'https://api.bilibili.com/x/player/v2?bvid=' + bvid + '&cid=' + view.cid,
    { referer: 'https://www.bilibili.com/video/' + bvid },
  )
  const list = ((player.subtitle && player.subtitle.subtitles) || []).filter((s) => s.subtitle_url)
  if (!list.length) {
    console.error('第 ' + attempt + ' 次：字幕列表里没有带地址的条目')
    continue
  }
  const pick = list.find((s) => /ai-zh|zh/i.test(s.lang || s.lan)) || list[0]
  let url = pick.subtitle_url
  if (url.startsWith('//')) url = 'https:' + url
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
  const body = (await res.json()).body || []
  const text = body.map((x) => x.content).join('')
  const lastTo = body.length ? Number(body[body.length - 1].to) : 0
  const cov = duration > 0 ? Math.min(1, lastTo / duration) : 0
  const overflow = duration > 0 && lastTo > duration * 1.2
  const score = hints.reduce((n, h) => n + (text.includes(h) ? 1 : 0), 0)
  console.error(
    '第 ' + attempt + ' 次：lang=' + (pick.lan || pick.lang) + ' 段数=' + body.length +
      ' 字数=' + text.length + ' 覆盖=' + Math.round(cov * 100) + '%' +
      (overflow ? ' 【时间轴超出视频时长，疑似串台】' : '') +
      ' 关键词命中=' + score + '/' + hints.length,
  )
  const cand = { body, text, score, overflow, cov }
  if (!best || (cand.score > best.score) || (best.overflow && !cand.overflow && cand.score >= best.score)) {
    best = cand
  }
  if (score === hints.length) break
}

if (!best) {
  console.error('四次都没拿到可用字幕')
  process.exit(2)
}

const lines = []
for (let i = 0; i < best.body.length; i += per) {
  const chunk = best.body.slice(i, i + per)
  lines.push('[' + mmss(chunk[0].from) + '] ' + chunk.map((x) => x.content).join(''))
}
console.log('BVID=' + bvid + ' 时长=' + duration + 's 采用：段数=' + best.body.length +
  ' 字数=' + best.text.length + ' 命中=' + best.score + '/' + hints.length +
  (best.overflow ? ' 注意：时间轴超长' : ''))
console.log(lines.join('\n'))
