#!/usr/bin/env node
/**
 * 一次性探针：查 deep 证据层的两个疑点
 *   1) 评论接口 `ps=50` 报 -400 ps out of bounds → 试 ps=20 与 /x/v2/reply/main
 *   2) 字幕内容与标题明显不符 → 打 player/v2 看字幕列表里到底有几条、分别什么语言
 * 用法：node tools/probe-deep.mjs BV11Ssf6gEfJ
 */
import { resetCallBudget, callsUsed } from '../lib/core.js'
import { callApi } from '../lib/core.js'

const bvid = process.argv[2] || 'BV11Ssf6gEfJ'
resetCallBudget()

const view = await callApi('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid)
console.log('view → aid=' + view.aid + ' cid=' + view.cid + ' 分P数=' + (view.pages || []).length + ' 时长=' + view.duration)
for (const p of view.pages || []) console.log('   page cid=' + p.cid + ' ' + p.part)

const player = await callApi('https://api.bilibili.com/x/player/v2?bvid=' + bvid + '&cid=' + view.cid)
const subs = (player.subtitle && player.subtitle.subtitles) || []
console.log('player/v2 → 字幕条目 ' + subs.length + ' 条')
for (const s of subs) console.log('   lan=' + s.lan + ' lan_doc=' + s.lan_doc + ' ai_type=' + s.ai_type + ' url=' + String(s.subtitle_url).slice(0, 90))

for (const [label, url] of [
  ['/x/v2/reply ps=20', 'https://api.bilibili.com/x/v2/reply?type=1&oid=' + view.aid + '&sort=2&ps=20&pn=1'],
  ['/x/v2/reply/main ps=20 mode=3', 'https://api.bilibili.com/x/v2/reply/main?type=1&oid=' + view.aid + '&mode=3&next=0&ps=20'],
]) {
  try {
    const data = await callApi(url, { referer: 'https://www.bilibili.com/video/' + bvid })
    const list = data.replies || (data.replies === null ? [] : data.replies) || (data.cursor ? [] : [])
    const arr = Array.isArray(list) ? list : []
    console.log(label + ' → ok，条数=' + arr.length + ' 首条=' + (arr[0] && arr[0].content ? String(arr[0].content.message).slice(0, 40) : '无') + ' total=' + ((data.page && data.page.acount) || (data.cursor && data.cursor.all_count) || '?'))
  } catch (error) {
    console.log(label + ' → 失败：' + (error.message || error))
  }
}
console.log('本轮调用 ' + callsUsed() + ' 次')
