/**
 * 分端点探针：判断 412 是「整个 IP 被限」还是「只有 search 接口拒」。
 * 打两条：/x/web-interface/nav（登录态回显）、search/type（列表）。
 * 各 1 次请求，间隔 1.5s。
 *   node tools/probe-endpoints.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cred = JSON.parse(readFileSync(path.join(homedir(), '.bilibili-cli', 'credential.json'), 'utf8'))
const cookie =
  'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.bili_jct + '; buvid3=' + cred.buvid3 + '; DedeUserID=' + cred.dedeuserid

function hit(url, referer) {
  const tag = Math.random().toString(36).slice(2, 8)
  const cfg = path.join(tmpdir(), 'ep-' + tag + '.cfg')
  const out = path.join(tmpdir(), 'ep-' + tag + '.out')
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

const cases = [
  ['nav（登录态）', 'https://api.bilibili.com/x/web-interface/nav', 'https://www.bilibili.com/'],
  [
    'search/type（列表）',
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=DeepSeek&page=1&page_size=20',
    'https://search.bilibili.com/',
  ],
]

for (const [label, url, referer] of cases) {
  const text = hit(url, referer)
  let verdict
  try {
    const json = JSON.parse(text)
    verdict = 'code=' + json.code + (json.code === 0 ? ' → 通' : ' → 拒：' + (json.message || ''))
  } catch {
    verdict = '回了 HTML（' + text.length + ' 字节）→ 拦截页: ' + (/<title>([^<]*)<\/title>/.exec(text) || [, ''])[1]
  }
  console.log(label + '：' + verdict)
  await new Promise((r) => setTimeout(r, 1500))
}
