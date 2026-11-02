/**
 * 单请求探针：只打 1 次 search 接口，看当前 IP 是否还在 412 冷却里。
 *   node tools/probe-once.mjs
 * 用途：判定「插件坏了」还是「IP 还在被限流」——两者现象一样，但只有这条能区分。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const credPath = path.join(homedir(), '.bilibili-cli', 'credential.json')
const cred = JSON.parse(readFileSync(credPath, 'utf8'))
const cookie =
  'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.bili_jct + '; buvid3=' + cred.buvid3 + '; DedeUserID=' + cred.dedeuserid

const cfg = path.join(tmpdir(), 'bili-probe.cfg')
const out = path.join(tmpdir(), 'bili-probe.out')
writeFileSync(
  cfg,
  [
    'silent',
    'max-time = 25',
    'header = "User-Agent: ' + UA + '"',
    'header = "Referer: https://search.bilibili.com/"',
    'header = "Accept: */*"',
    'header = "Cookie: ' + cookie + '"',
    '',
  ].join('\n'),
  'utf8',
)

const url =
  'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=DeepSeek%20Harness&page=1&page_size=50&order=totalrank'
const started = Date.now()
const result = spawnSync('curl.exe', ['-K', cfg, '-o', out, url], { stdio: 'ignore', windowsHide: true, timeout: 30000 })
const text = existsSync(out) ? readFileSync(out, 'utf8') : ''
unlinkSync(cfg)
if (existsSync(out)) unlinkSync(out)

console.log('curlExit=' + result.status + ' ms=' + (Date.now() - started) + ' bytes=' + text.length)
try {
  const json = JSON.parse(text)
  const count = json.data && json.data.result ? json.data.result.length : 0
  console.log('code=' + json.code + ' 条数=' + count + (json.code === 0 ? ' → 已恢复可用' : ' → 仍在被拒'))
} catch {
  console.log('不是 JSON，前 80 字：' + text.slice(0, 80).replace(/\s+/g, ' '))
  console.log('→ 仍在风控拦截（HTTP 层就回 HTML）')
}
