/**
 * 验证「search 接口 412 是不是因为缺 wbi 签名」。
 * 实测前提：同一时刻 nav 通（code=0）、search/type 回拦截页 → 不是 IP 被封，是这个端点拒。
 * 做法：取 nav 的 wbi_img → 算 mixinKey → 对参数加 wts + w_rid → 打 /x/web-interface/wbi/search/type。
 *   node tools/probe-wbi.mjs
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cred = JSON.parse(readFileSync(path.join(homedir(), '.bilibili-cli', 'credential.json'), 'utf8'))
const cookie =
  'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.bili_jct + '; buvid3=' + cred.buvid3 + '; DedeUserID=' + cred.dedeuserid

function fetchText(url, referer) {
  const tag = Math.random().toString(36).slice(2, 8)
  const cfg = path.join(tmpdir(), 'wbi-' + tag + '.cfg')
  const out = path.join(tmpdir(), 'wbi-' + tag + '.out')
  writeFileSync(
    cfg,
    [
      'silent',
      'max-time = 25',
      'header = "User-Agent: ' + UA + '"',
      'header = "Referer: ' + referer + '"',
      'header = "Accept: */*"',
      'header = "Cookie: ' + cookie + '"',
      '',
    ].join('\n'),
    'utf8',
  )
  spawnSync('curl.exe', ['-K', cfg, '-o', out, url], { stdio: 'ignore', windowsHide: true, timeout: 30000 })
  const text = existsSync(out) ? readFileSync(out, 'utf8') : ''
  unlinkSync(cfg)
  if (existsSync(out)) unlinkSync(out)
  return text
}

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
]

function keyFromUrl(url) {
  const file = String(url || '').split('/').pop() || ''
  return file.split('.')[0]
}

function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey
  return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
}

function sign(params, mixin) {
  const wts = Math.floor(Date.now() / 1000)
  const all = { ...params, wts }
  const query = Object.keys(all)
    .sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(all[k]).replace(/[!'()*]/g, '')))
    .join('&')
  const w_rid = createHash('md5').update(query + mixin).digest('hex')
  return query + '&w_rid=' + w_rid
}

const nav = JSON.parse(fetchText('https://api.bilibili.com/x/web-interface/nav', 'https://www.bilibili.com/'))
const imgKey = keyFromUrl(nav.data.wbi_img.img_url)
const subKey = keyFromUrl(nav.data.wbi_img.sub_url)
console.log('nav ok，imgKey=' + imgKey + ' subKey=' + subKey)
const mixin = mixinKey(imgKey, subKey)
console.log('mixinKey=' + mixin)

const params = { search_type: 'video', keyword: 'DeepSeek Harness', page: 1, page_size: 20, order: 'totalrank' }
const signed = sign(params, mixin)
const url = 'https://api.bilibili.com/x/web-interface/wbi/search/type?' + signed
const text = fetchText(url, 'https://search.bilibili.com/')
try {
  const json = JSON.parse(text)
  const n = json.data && json.data.result ? json.data.result.length : 0
  console.log('wbi/search/type → code=' + json.code + ' 条数=' + n + (json.code === 0 ? ' ✅ 签名有效' : ' ❌ ' + json.message))
  if (n > 0) {
    console.log('首条：' + json.data.result[0].bvid + ' ' + String(json.data.result[0].title).slice(0, 40))
  }
} catch {
  const title = (/<title>([^<]*)<\/title>/.exec(text) || [, ''])[1]
  console.log('wbi/search/type → 回了 HTML（' + text.length + ' 字节）：' + title + ' ❌ 签名不是关键问题')
}
