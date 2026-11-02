/**
 * Host half of dsh-bili-search（B站搜索筛选）.
 *
 * 只做一件事：给模型一个 bili_filter 工具——按关键词在 B 站做多排序取样、过硬闸，
 * 出候选清单，再由对话模型看标题剔无关、问清意图后按播放量收口，并把 md/csv/json 落到本机。
 * 2026-11-01 用户定：不再打分分档（原来的 100 分制与 S/A/B/C 已移除）。
 *
 * 分工：与既有 dsh-bili-scroll（「刷B站」：按兴趣定时刷、写报告）不是一回事，
 * 这里是「按用户给定关键词做一次可审计的检索与筛选」。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  LOG,
  VERSION,
  callsUsed,
  checkLogin,
  clearCooldown,
  clearWbiCache,
  cooldownRemainMs,
  persist,
  renderEvidence,
  renderTable,
  renderRows,
  runFilter,
  syncRuntimeSettings,
  DURATION_BANDS,
  transportUsed,
  COMMENT_PAGE_SIZE,
} from './core.js'
import {
  DEFAULT_SETTINGS,
  LIMITS,
  SETTINGS_FILE,
  effectiveParams,
  readLastRun,
  readSettings,
  recordRun,
  writeSettings,
} from './settings.js'

export const name = 'bili_filter'
export const inject = ['tools', 'webServer']

function bandLabel(key) {
  const band = DURATION_BANDS[key]
  return band && band.label ? band.label : '不限'
}

/** 时长筛选的统一说法：自定义区间优先于档位（2026-11-03 用户定） */
function durLabel(p) {
  const lo = Number(p.durationMin) || 0
  const hi = Number(p.durationMax) || 0
  if (lo > 0 || hi > 0) {
    const parts = []
    if (lo > 0) parts.push('≥ ' + lo + ' 分')
    if (hi > 0) parts.push('≤ ' + hi + ' 分')
    return parts.join(' 且 ') + '（自定义区间）'
  }
  return bandLabel(p.duration)
}

function summarize(result, saved) {
  const p = result.params
  const lines = []
  const isList = result.stage === 'list'
  lines.push('**B站' + (isList ? '候选清单' : '检索结果') + ' · ' + p.keyword + '**')
  lines.push(
    '条件：时间筛选 ' +
      (p.days ? '最近 ' + p.days + ' 天' : '不限') +
      ' · 时长筛选 ' +
      durLabel(p) +
      ' · 播放量筛选 ≥ ' +
      (p.minPlay ? p.minPlay + ' 次' : '不限') +
      ' · 目标 ' +
      p.targetN +
      ' 条 · 候选清单 ' +
      p.candidateLimit +
      ' 条 · 同 UP 上限 ' +
      p.upCap +
      ' 条 · 排序 ' +
      (p.sort === 'totalrank' ? 'B站综合排序位次' : '播放量降序') +
      ' · 取样排序 ' +
      (Array.isArray(p.orders) ? p.orders.join('/') : 'totalrank') +
      ' · 模式 ' +
      (p.mode === 'deep' ? 'deep（视频总结 ' + p.deepTop + ' 条）' : 'overview'),
  )
  if (result.poolFromCache) lines.push('候选池：复用上一次 list 取回的池子（同参数 5 分钟内不重搜，本轮 0 次取样调用）')
  lines.push(
    '漏斗：取样 ' +
      result.funnel.pool +
      ' → 硬闸淘汰 ' +
      result.funnel.killed +
      ' → 通过 ' +
      result.funnel.kept +
      ' → 输出 ' +
      result.rows.length,
  )
  const kills = Object.entries(result.funnel.killBreakdown || {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => k + ' ' + n + ' 条')
  if (kills.length) lines.push('淘汰分布：' + kills.join('、'))
  const errors = (result.funnel && result.funnel.errors) || []
  if (errors.length) lines.push('⚠ 有 ' + errors.length + ' 个分页没取到：' + errors[0] + '（结果可能不全）')
  lines.push('')
  lines.push(renderTable(result.rows))
  if (result.rows.length) {
    lines.push('')
    lines.push(renderRows(result.rows))
    const noPub = result.rows.filter((row) => !row.pubdate).length
    if (noPub) lines.push('⚠ 有 ' + noPub + ' 条没拿到发布时间（表里写「未知」），转述时如实说明是「发布时间未知」，别静默略掉')
    lines.push('※ 转述结果时每条都要带发布日期（YYYY-MM-DD），不许省略、不许只写「近期」')
  }
  if (isList) {
    lines.push('')
    lines.push(
      '下一步（两段式）：① 逐条看标题，剔掉明显无关的，剩下的 bvid 列成一个数组；再从里面挑出「几乎与意图一致」的强相关条目单独记一份；' +
        '② 向用户问清意图（要哪种口径、时间范围、视频长短、要不要看实操/评测），把意图写成一句话；' +
        '③ 如果这批候选明显不对路（关键词没抓住意图），按意图改写检索词再调一次 list —— 改写要用同义整句/同义词替换，' +
        '**不要把检索词拆成片段**（拆开会改变意图，插件会拒绝）；' +
        '④ 再调一次本工具：stage=final、keep=[留下的 bvid]、strong=[其中几乎与意图一致的 bvid]、intent=那句话' +
        '（检索引沿用这次的关键词，keep 才对得上池子），插件把强相关排最前（无视播放量），其余按播放量降序收口。' +
        '拿不准用户意图时先问，别自己拍。候选清单这一阶段不落盘，只有 final 收口的结果才写文件。',
    )
  }
  if (result.funnel && result.funnel.strong) {
    lines.push('强相关：' + result.funnel.strong + ' 条（已在最前面，无视播放量排序）')
  }
  if (result.strongTruncated) {
    lines.push('⚠ 强相关还有 ' + result.strongTruncated + ' 条被截断（超过「要几条结果」），要全看就把 targetN 放大')
  }
  if (result.strongMissing && result.strongMissing.length) {
    lines.push(
      '⚠ 标为强相关的 bvid 里有 ' + result.strongMissing.length + ' 个不在本次候选池：' + result.strongMissing.join('、') + '（可能被硬闸淘汰、写错号，或没放进 keep）',
    )
  }
  if (result.keepMissing && result.keepMissing.length) {
    lines.push('')
    lines.push('⚠ 有 ' + result.keepMissing.length + ' 个 bvid 不在本次候选池里（可能被硬闸淘汰或本次没取到）：' + result.keepMissing.join('、'))
  }
  if (result.deep && result.deep.covered) {
    lines.push('')
    lines.push(
      '深度取证：前 ' +
        result.deep.covered +
        ' 条（字幕可用 ' +
        result.deep.subtitleOk +
        ' 条）。下面是原始证据，总结请依据它写，不要越过它编造。',
    )
    const ev = renderEvidence(result.rows)
    if (ev) lines.push('', ev)
  }
  if (result.summary && result.summary.text) {
    lines.push('')
    lines.push(
      '总结骨架：' +
        result.summary.label +
        '（profile ' +
        result.summary.profile +
        '，归一单位 ' +
        result.summary.unit +
        '）—— 按这个骨架写，别自创结构。',
    )
    lines.push('')
    lines.push(result.summary.text)
  }
  if (result.probe && result.probe.ok) {
    lines.push('')
    lines.push(
      '敏感性探测（仅估算上限）：当前条件通过 ' +
        result.probe.baseline +
        ' 条；' +
        (result.probe.notes || []).map((n) => n.relax + ' 可多解锁 ' + n.unlocked + ' 条').join('；'),
    )
  }
  if (saved) {
    const files = [saved.mdPath, saved.csvPath, saved.jsonPath].filter(Boolean)
    if (files.length) {
      lines.push('')
      lines.push('已落盘：')
      for (const file of files) lines.push('- ' + file)
    }
  }
  return lines.join('\n')
}

export function apply(ctx) {
  // 外层兜底：插件自身任何一步抛错都不许把宿主启动带下水（2026-11-01 用户报过一次「重启后打不开」之后加的）
  try {
    applyImpl(ctx)
  } catch (error) {
    console.error('[bili-search] apply 失败，插件已跳过，不影响宿主启动：', error && error.stack ? error.stack : error)
  }
}

function applyImpl(ctx) {
  // 设置页 + 自检接口。设置页（client.js）就打这几个路由。
  // 宿主重启后 `curl http://127.0.0.1:<端口>/bili-filter-api/state` 应返回 version。
  const webServer = ctx.webServer ?? (ctx.get ? ctx.get('webServer') : null)
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() =>
      webServer.register(
        {
          kind: 'prefix',
          path: '/bili-filter-api',
          async handler(req, res) {
            const send = (body, status = 200) => {
              res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
              res.end(JSON.stringify(body))
            }
            const readBody = () =>
              new Promise((resolve) => {
                let raw = ''
                req.on('data', (chunk) => {
                  raw += chunk
                  if (raw.length > 64 * 1024) req.destroy()
                })
                req.on('end', () => {
                  try {
                    resolve(raw ? JSON.parse(raw) : {})
                  } catch {
                    resolve({})
                  }
                })
                req.on('error', () => resolve({}))
              })
            const path = String(req.url || '/').split('?')[0].replace(/^\/bili-filter-api/, '') || '/'
            const settings = readSettings()

            if (req.method === 'GET' && (path === '/state' || path === '/')) {
              return send({
                ok: true,
                version: VERSION,
                transport: transportUsed(),
                callsThisRun: callsUsed(),
                cooldownMinutes: Math.ceil(cooldownRemainMs() / 60000),
                settingsFile: SETTINGS_FILE,
                lastRun: readLastRun(),
                settings: {
                  days: settings.days,
                  duration: settings.duration,
                  minPlay: settings.minPlay,
                  targetN: settings.targetN,
                  upCap: settings.upCap,
                  mode: settings.mode,
                  deepTop: settings.deepTop,
                  commentTarget: settings.commentTarget,
                  probe: settings.probe,
                  gapMs: settings.gapMs,
                  cooldownMinutes: settings.cooldownMinutes,
                  outDir: settings.outDir,
                  formats: settings.formats,
                  summary: settings.summary,
                  summaryProfile: settings.summaryProfile,
                },
              })
            }
            if (req.method === 'GET' && path === '/settings') {
              return send({ ok: true, settings, defaults: DEFAULT_SETTINGS, limits: LIMITS, file: SETTINGS_FILE })
            }
            if (req.method === 'POST' && path === '/settings') {
              const patch = await readBody()
              const result = writeSettings(patch)
              return send({ ok: result.ok, settings: result.settings, errors: result.errors }, result.ok ? 200 : 400)
            }
            if (req.method === 'POST' && path === '/clear-cooldown') {
              return send({ ok: true, cleared: clearCooldown() })
            }
            if (req.method === 'POST' && path === '/refresh-wbi') {
              return send({ ok: true, cleared: clearWbiCache() })
            }
            if (req.method === 'POST' && path === '/probe-login') {
              const who = await checkLogin()
              return send(who, who.ok ? 200 : 400)
            }
            return send({ ok: false, error: '没有这个接口：' + path }, 404)
          },
        },
        'dsh-bili-search: /bili-filter-api',
      ),
    )
  } else {
    console.warn(LOG, '没有 webServer，设置页与自检接口不可用，工具本身不受影响')
  }

  const register = (build) => {
    try {
      ctx.tools.register(build())
    } catch (error) {
      console.error(LOG, '工具注册失败', String(error))
    }
  }

  ctx.inject(['tools'], () => {
    register(() => defineTool({
      name: 'bili_filter',
      description:
        '按关键词检索并筛选 B 站视频。两段式：' +
        '① stage=list（默认）——按 B 站综合排序取样若干页（默认只跑综合排序；设置页可另加播放/最新/弹幕/收藏），bvid 去重后过硬闸：' +
        'G2 排除词、G3 时长筛选取档或脏值、G4 同标题重复与搬运、G5 时间筛选、G7 播放量筛选（字段缺失不再淘汰，缺的显示「—」）；' +
        '关键词不做硬筛（跟 B 站自己的综合排序走），出候选清单（标题/播放/点赞/时长/发布/链接，默认按站内位次）。' +
        '② stage=final——你把看过标题后留下的 bvid 用 keep 传回来，并另用 strong 标出其中「几乎与意图一致」的强相关条目' +
        '（可带 intent 记录用户意图）；强相关排最前、无视播放量（组内按播放量降序），其余按播放量降序取（同 UP 上限生效）。不打分、不分档。' +
        '同参数 5 分钟内 final 直接复用 list 那次的候选池，不重搜。' +
        '流程：用户给的关键词未必是他真实意图的最佳词——先问清意图，再按意图改写检索词（可给多条，用换行或 | 分隔，最多 4 条，' +
        '但每条必须是同义整句/同义词，**不要把一个检索词拆成片段**，碎片会被拒绝）' +
        '→ 调 list 出候选 → 你按标题剔掉明显无关的 → 调 final 带 keep + intent 收口；' +
        '模式 overview（默认，只给链接/发布/播放/时长等基础信息，不取视频详情）或 deep（只对收口后的前 deepTop 条取详情、读字幕、抓 ' +
        COMMENT_PAGE_SIZE +
        ' 条评论，返回原始证据，总结由你写）。final 收口的结果同时写入 md/csv/json；候选清单（list）不落盘。' +
        '需要读本机 bilibili-cli 的登录 cookie（只读，不写账号数据）。',
      parameters: {
        keyword: {
          type: 'string',
          description:
            '检索词。按用户意图改写后填（不必照抄用户原话）。要一次搜多条，用换行或 | ｜ ； 分隔，最多 4 条，' +
            '但每条必须是能独立表达同一意图的同义整句/同义词（如「AI视频 价格」→「AI视频 生成 多少钱」→「AI视频 模型 费用」）；' +
            '不许把一个检索词拆成片段（拆开会改变意图，碎片会被拒绝）。变体共用这一轮的调用额度',
        },
        stage: {
          type: 'string',
          description: 'list=出候选清单（默认，第一段）；final=收口（第二段，通常配 keep/intent）',
        },
        keep: {
          type: 'string',
          description: 'final 阶段用：你看标题筛过后留下的 bvid 列表（空格或逗号分隔）；只在它们里面取，不回填',
        },
        strong: {
          type: 'string',
          description:
            'final 阶段用：其中「几乎与用户意图一致」的强相关 bvid（空格或逗号分隔）。这些会排在最前面，无视播放量（组内按播放量降序）；必须同时出现在 keep 里',
        },
        sort: {
          type: 'string',
          description: '排序：play=播放量降序（final 默认）；totalrank=B站综合排序位次（list 默认）',
        },
        days: { type: 'number', description: '时间筛选：最近多少天内的视频，0 表示不限。默认取设置页的值（内置 30）' },
        duration: {
          type: 'string',
          description:
            '时长筛选（档位）：any=不限（默认）/ 1=10 分钟以内 / 2=10–30 分钟 / 3=30–60 分钟 / 4=1 小时以上。' +
            '要「大于 30 分钟」这类自由条件时改用 durationMin / durationMax，给了区间档位就自动忽略',
        },
        durationMin: {
          type: 'number',
          description:
            '时长下限（分钟，可小数）：例如用户说「时长大于 30 分钟 / 30 分钟以上」就传 30。' +
            '给了它就以自定义区间为准（档位参数忽略），0 或不传表示不限',
        },
        durationMax: {
          type: 'number',
          description: '时长上限（分钟，可小数）：例如「一小时内」传 60；与 durationMin 同时可用，要求下限 < 上限',
        },
        minPlay: {
          type: 'number',
          description: '播放量筛选（硬闸 G7）：低于这个数的直接淘汰，0=不限。默认取设置页里的值（内置 1000）',
        },
        targetN: { type: 'number', description: 'final 阶段要几条结果，默认 12，上限 50' },
        candidateLimit: {
          type: 'number',
          description: '候选清单数量：list 阶段出多少条候选给模型筛标题，默认取设置页的值（内置 200），上限 500',
        },
        upCap: { type: 'number', description: '同一个 UP 主最多几条，默认 3' },
        exclude: { type: 'string', description: '排除词，空格分隔；命中标题/标签/简介即淘汰' },
        typename: { type: 'string', description: '限定分区名，如「计算机技术」；留空不限' },
        intent: {
          type: 'string',
          description: 'final 阶段用：问清用户之后的意图，一句话写清（只记录进落盘表头，不参与筛选）',
        },
        probe: { type: 'boolean', description: 'final 结果偏少时是否做敏感性探测（估算放宽哪一项能多解锁多少条），默认开' },
        outDir: { type: 'string', description: '落盘目录，默认 ~/Documents/bili-filter' },
        mode: {
          type: 'string',
          description:
            'overview=普通模式（默认，只给链接/发布时间/播放量/时长等基础信息）；' +
            'deep=总结模式（仅 final 阶段生效，对收口后的前 deepTop 条看详情、读字幕和评论，返回原始证据供写总结）',
        },
        deepTop: {
          type: 'number',
          description: '视频总结条数：deep 模式对前几条看详情、读字幕、抓评论，默认取设置页的值（内置 5），上限 10',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args) {
        const keyword = String(args.keyword || '').trim()
        if (!keyword) return { ok: false, message: '要搜什么关键词？' }

        // 优先级：调用时给的参数 > 设置页里的默认值 > 内置默认
        syncRuntimeSettings()
        const p = effectiveParams(args)

        if (p.mode !== 'overview' && p.mode !== 'deep') {
          return { ok: false, message: '模式只有 overview（普通，默认）和 deep（总结）。' }
        }
        if (!(p.duration in DURATION_BANDS)) {
          return { ok: false, message: '时长档只能是 any / 1 / 2 / 3 / 4。' }
        }
        const stage = String(args.stage || 'list') === 'final' ? 'final' : 'list'
        // 2026-11-03 用户定：临时条件 —— 自定义时长区间（分钟），给了就以区间为准
        const dMin = Number(p.durationMin) || 0
        const dMax = Number(p.durationMax) || 0
        if (dMin < 0 || dMax < 0 || dMin > 600 || dMax > 600) {
          return { ok: false, message: '自定义时长区间要在 0–600 分钟之间。' }
        }
        if (dMin > 0 && dMax > 0 && dMin >= dMax) {
          return { ok: false, message: '自定义时长区间要满足「下限 < 上限」，比如 durationMin=30、durationMax=60。' }
        }
        if (args.stage && args.stage !== 'list' && args.stage !== 'final') {
          return { ok: false, message: 'stage 只有 list（出候选，默认）和 final（收口）。' }
        }

        try {
          const result = await runFilter({
            keyword,
            days: p.days,
            duration: p.duration,
            durationMin: dMin,
            durationMax: dMax,
            minPlay: p.minPlay,
            targetN: p.targetN,
            upCap: p.upCap,
            exclude: p.exclude,
            typename: p.typename,
            probe: p.probe,
            mode: p.mode,
            deepTop: p.deepTop,
            pagesPerOrder: 3,
            orders: p.orders,
            stage,
            keep: args.keep,
            strong: args.strong,
            sort: args.sort,
            candidateLimit: p.candidateLimit,
            intent: args.intent,
          })
          // 2026-11-01 用户定：候选清单（list）不落盘，只有确认意图后 final 收口的结果才落盘
          const saved = stage === 'final' ? persist(result, p.outDir || undefined) : null
          const message = summarize(result, saved)
          recordRun({
            keyword,
            stage,
            mode: p.mode,
            sampled: result.funnel.pool,
            output: result.rows.length,
            calls: callsUsed(),
            files: saved,
          })
          return {
            ok: true,
            message,
            version: VERSION,
            stage,
            rows: result.rows.length,
            funnel: result.funnel,
            deep: result.deep,
            summary: result.summary || null,
            calls: callsUsed(),
            files: saved,
            table: renderTable(result.rows),
          }
        } catch (error) {
          const text = String(error && error.message ? error.message : error)
          return { ok: false, message: '筛选没跑成：' + text }
        }
      },
    }))
  })
}
