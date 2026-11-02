# dsh-bili-search

> DeepSeek Harness（DSH）插件：按关键词检索 B 站视频 → 过硬闸出候选清单 → 由对话模型看标题剔掉无关 → 问清意图后按播放量收口；`deep` 模式读详情、字幕与热评，并附一份「总结骨架」让你写出来的总结有固定结构与硬约束。

包名 `dsh-bili-search`（原名 `dsh-bili-filter`）。为了不打断已有调用与历史数据，**工具名仍是 `bili_filter`**，自检路由仍是 `/bili-filter-api`，数据目录仍是 `~/.bili-filter`，默认落盘目录仍是 `~/Documents/bili-filter`。

## 为什么不是一个「搜一下」的封装

B 站搜索接口直接调用有三个坑，这个插件把三个都踩过了：

1. **search 端点要 wbi 签名**（`wts` + `w_rid`，密钥取 `nav` 的 `wbi_img`，缓存 1 小时），不签名一律被拒。
2. **node 的 fetch / http2 会被 TLS 指纹拦**（412 拦截页），实际传输走 `curl` 子进程（cookie 写进 `--config` 临时文件，不进 argv）。
3. **字幕接口有两类偶发故障**：字幕条目在但 `subtitle_url` 为空；同一 bvid 每次给的字幕文件可能不是同一条（串台）。所以字幕要重试 + 质量闸，且**覆盖率达标也挡不住语义串台**（实测遇到过 100% 覆盖但内容是另一条视频的）。

## 能力

- **两段式**：`stage=list` 出候选（默认 200 条，不落盘）→ 模型按标题剔无关 → `stage=final` 带 `keep` + `intent` 收口落盘。final 排序 = 强相关组（`strong`，无视播放量、组内按播放量降序）→ 其余按播放量降序，同 UP 上限默认 3。
- **硬闸**：G2 排除词 / G3 时长档 / G4 标题重复与搬运 / G5 时间筛选 / G7 播放量下限（`minPlay`，默认 1000，0=不限）。字段缺失不再淘汰（显示「—」）。
- **多检索词**：最多 4 条，用换行 / `|` / `｜` / `；` 分隔。**每条必须是能独立表达同一意图的同义整句**——把原词拆成碎片会被 `checkVariants` 直接拒绝。
- **候选池复用**：同参数 5 分钟内 final 不再重搜（0 次取样调用，仅同进程有效）。
- **deep 取证**：只对收口后的前 `deepTop` 条取 `view` 详情 + AI 字幕（最多试 3 次）+ 热评（20/50/100 条，内部翻页凑数）。
- **总结骨架**：deep 收口后自动附一份可照着写的结构——L0 九条硬约束（证据成色先交代 / 正文与评论来源隔离 / 必须落名 / 数字带单位与成立条件 / 标准化换算 / 标证据强度 / 去重 / 术语归一 / 缺口必须声明）+ L1 固定九节 + L2 八类主题模板（price / howto / review / event / idea / product / ranking / generic，按关键词与标题自动判定）+ 评论区规则 + 自动填好的证据成色表。
- **落盘**：md / csv / json 三份（可分别关掉）。
- **图形设置页**：DSH「设置」→「B站筛选」，改哪一项就自动保存，下一次检索即生效。

## 安装

插件是本地 `link:` 型，装在 DSH desktop profile 里。

```bash
# 1) 把仓库放到任意目录，例如 D:/plugins/dsh-bili-search
# 2) 在 profile 的 package.json 里加依赖与 bundle（先备份！）
#    DSH_PROFILE_DIR = %APPDATA%/dsh-desktop/harness/profiles/desktop
```

`profiles/desktop/package.json` 需要两处改动：

```json
{
  "dependencies": {
    "dsh-bili-search": "link:D:/plugins/dsh-bili-search"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-bili-search"]
    }
  }
}
```

再在 `profiles/desktop/node_modules` 里做一条 Junction（Windows）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:APPDATA\dsh-desktop\harness\profiles\desktop\node_modules\dsh-bili-search" `
  -Target "D:\plugins\dsh-bili-search"
```

改 JSON 请用 node 写、写完 `JSON.parse` 验一遍；**不要用 PowerShell `Set-Content -Encoding UTF8`**（5.1 会写 BOM，启动期读配置会直接挂）。

插件自己只有单元级依赖：`@deepseek-ai/dsh-tools`（peer，由宿主提供）。

## 使用

工具名 `bili_filter`，主要参数：

| 参数 | 说明 |
| --- | --- |
| `keyword` | 检索词，按意图改写成同义整句，可多条（≤4） |
| `stage` | `list`（默认，出候选）/ `final`（收口落盘） |
| `keep` | final 用：候选里留下的 bvid，空格或逗号分隔 |
| `strong` | final 用：几乎与意图一致的 bvid，排最前且无视播放量（须同时在 keep 里） |
| `sort` | `totalrank`（B 站综合排序位次）/ `play`（播放量降序）；list 默认前者、final 默认后者 |
| `days` / `duration` | 时间筛选（0=不限）/ 时长档（`any` `1` `2` `3` `4`） |
| `minPlay` | 播放量下限（硬闸 G7），0=不限 |
| `targetN` / `candidateLimit` | final 输出条数 / list 候选条数（5–500） |
| `upCap` / `exclude` / `typename` | 同 UP 上限 / 排除词 / 限定分区 |
| `intent` | 用户意图，写进落盘表头 |
| `mode` / `deepTop` | `overview`（默认，不取详情）/ `deep`（前 N 条取证） |
| `probe` / `outDir` | 供给不足时的敏感性探测 / 落盘目录 |

典型一轮：

```
bili_filter(keyword="AI视频 生成 多少钱|即梦 Seedance 可灵 价格", days=90, minPlay=300, stage="list")
→ 看标题剔无关，挑出 keep 与 strong
bili_filter(keyword="<同一条串>", stage="final", keep="BV1xxx,BV1yyy", strong="BV1xxx",
            intent="各平台单价与套餐性价比", mode="deep", deepTop=3)
```

## 状态与数据

| 位置 | 内容 |
| --- | --- |
| `~/.bili-filter/settings.json` | 设置页存的值 |
| `~/.bili-filter/state.json` | 风控冷却截止时间 |
| `~/.bili-filter/wbi.json` | wbi 签名密钥缓存（1 小时） |
| `~/.bili-filter/last-run.json` | 最近一次运行摘要 |
| `~/Documents/bili-filter/` | 落盘结果（md / csv / json） |
| `~/.bilibili-cli/credential.json` | B 站 cookie（由 bilibili-cli 维护，插件只读） |

自检路由（宿主 Web 端口上）：

```
GET  /bili-filter-api/state            版本 / 传输方式 / 本轮调用数 / 冷却剩余 / 设置摘要
GET  /bili-filter-api/settings         设置 + 默认值 + 上下限
POST /bili-filter-api/settings         改设置（逐项校验，越界 400）
POST /bili-filter-api/clear-cooldown   立即清除风控冷却
POST /bili-filter-api/refresh-wbi      刷新 wbi 签名
POST /bili-filter-api/probe-login      检测登录态
```

## 风控与节奏

- 请求间隔**默认 340ms（下限 200ms）**，单轮调用上限硬顶 70。
- 命中风控（`-412` / 拦截页）→ 退避重试 6s、18s → 仍失败则落冷却 10 分钟，冷却期内直接拒绝并告知剩余时间。
- 只读：不点赞、不评论、不投币、不改任何账号状态。
- 账号只走本机 cookie，插件不保存 cookie 内容，只保存路径。

## 已知限制

- **字幕语义串台无法靠覆盖率拦截**：会拿到时长/密度都达标但内容属于别的视频的字幕。`deep` 的证据成色表会如实标出字幕状态，写总结时请自行核对主题是否对得上。
- 候选池缓存只在同进程内有效（重启即失效）。
- B 站接口与风控策略随时会变；参数与端点是按 2026-11 的实测行为写的。
- 结果质量取决于检索词：**别把一个词拆成碎片**，也别指望一个词搜出所有侧面。

## 开发与验证

```bash
node tools/smoke-plugin.mjs      # 插件层冒烟（39 项，不联网，会临时改设置并自动还原）
node tools/test-risk.mjs         # 风控退避与冷却（假 fetch，不联网）
node tools/test-variants.mjs     # 多检索词变体与拆词拦截（不联网）
node tools/test-cache.mjs        # 候选池复用（假 fetch，不联网）
node tools/run.mjs "关键词" --days 30 --stage list --limit 20   # 真跑原型 CLI
```

`tools/` 下另有一次性探针（`probe-once` / `probe-endpoints` / `probe-wbi` / `probe-deep` / `dump-transcript*`），用于排查接口与字幕问题。

改了 `lib/*.js` 必须重启 DSH；`client.js` 走 HMR，刷新设置页即可。

## 免责

仅供个人检索与阅读使用。使用时请遵守 B 站的服务条款与 robots 约定，控制请求频率，不要用于批量抓取或再分发内容。本项目与 B 站官方无关。

## License

MIT
