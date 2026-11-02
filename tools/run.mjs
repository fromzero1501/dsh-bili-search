#!/usr/bin/env node
/**
 * 原型跑法：不经 DSH，直接在终端跑一遍，验证漏斗与落盘。
 *   node tools/run.mjs "DeepSeek Harness" --days 30 --n 12            # 第一段：出候选
 *   node tools/run.mjs "DeepSeek Harness" --stage final --keep BV1xx,BV2yy --intent "只要实测价格"
 */
import { parseArgs } from 'node:util'
import { runFilter, persist, renderTable, renderEvidence, callsUsed, DURATION_BANDS } from '../lib/core.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: 'string', default: '0' },
    duration: { type: 'string', default: 'any' },
    'duration-min': { type: 'string', default: '' },
    'duration-max': { type: 'string', default: '' },
    'min-play': { type: 'string', default: '' },
    n: { type: 'string', default: '12' },
    limit: { type: 'string' },
    'up-cap': { type: 'string', default: '3' },
    exclude: { type: 'string', default: '' },
    typename: { type: 'string', default: '' },
    pages: { type: 'string', default: '4' },
    out: { type: 'string', default: '' },
    stage: { type: 'string', default: 'list' },
    keep: { type: 'string', default: '' },
    strong: { type: 'string', default: '' },
    sort: { type: 'string', default: '' },
    intent: { type: 'string', default: '' },
    json: { type: 'boolean', default: false },
    deep: { type: 'boolean', default: false },
    'deep-top': { type: 'string', default: '5' },
  },
})

const keyword = positionals.join(' ').trim()
if (!keyword) {
  console.error('用法：node tools/run.mjs "关键词" [--stage list|final] [--keep BV1xx,BV2yy] [--days 30]')
  process.exit(2)
}

const t0 = Date.now()
try {
  const result = await runFilter({
    keyword,
    days: Number(values.days),
    duration: values.duration,
    durationMin: values['duration-min'] === '' ? undefined : Number(values['duration-min']),
    durationMax: values['duration-max'] === '' ? undefined : Number(values['duration-max']),
    // 不传就交给设置页里的默认值（core 里读 settings.minPlay）
    minPlay: values['min-play'] === '' ? undefined : Number(values['min-play']),
    targetN: Number(values.n),
    upCap: Number(values['up-cap']),
    exclude: values.exclude,
    typename: values.typename,
    pagesPerOrder: Number(values.pages),
    mode: values.deep ? 'deep' : 'overview',
    deepTop: Number(values['deep-top']),
    stage: values.stage,
    keep: values.keep,
    strong: values.strong,
    sort: values.sort || undefined,
    candidateLimit: Number(values.limit),
    intent: values.intent,
  })
  // 候选清单（list）不落盘，只有 final 收口结果才写文件（与插件行为一致）
  const saved = result.stage === 'final' ? persist(result, values.out || undefined) : null
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          stage: result.stage,
          params: result.params,
          funnel: result.funnel,
          rows: result.rows.length,
          candidates: result.rows.map((r) => ({ rank: r.rank, bvid: r.bvid, title: r.title, play: r.play })),
          saved,
        },
        null,
        2,
      ),
    )
  } else {
    console.log('关键词：' + keyword)
    console.log(
      '阶段：' +
        result.stage +
        '　条件：时间筛选 ' +
        (result.params.days ? '最近 ' + result.params.days + ' 天' : '不限') +
        ' · 时长筛选 ' +
        (result.params.durationMin > 0 || result.params.durationMax > 0
          ? (result.params.durationMin > 0 ? '≥ ' + result.params.durationMin + ' 分' : '') +
            (result.params.durationMax > 0 ? (result.params.durationMin > 0 ? ' 且 ' : '') + '≤ ' + result.params.durationMax + ' 分' : '') +
            '（自定义区间）'
          : DURATION_BANDS[values.duration]
            ? DURATION_BANDS[values.duration].label
            : '不限') +
        ' · 播放量筛选 ≥ ' +
        (result.params.minPlay || '不限') +
        ' · 目标 ' +
        result.params.targetN +
        ' 条 · 候选 ' +
        result.params.candidateLimit +
        ' 条 · 排序 ' +
        result.params.sort,
    )
    console.log(
      '漏斗：取样 ' +
        result.funnel.pool +
        ' → 淘汰 ' +
        result.funnel.killed +
        ' → 通过 ' +
        result.funnel.kept +
        ' → 输出 ' +
        result.rows.length,
    )
    console.log('淘汰分布：' + JSON.stringify(result.funnel.killBreakdown))
    console.log('各排序取样：' + JSON.stringify(result.funnel.perOrder))
    console.log('接口调用：' + callsUsed() + ' 次 · 用时 ' + elapsed + 's')
    if (result.funnel.strong) console.log('强相关：' + result.funnel.strong + ' 条（排最前，无视播放量）')
    if (result.strongTruncated) console.log('⚠ 强相关还有 ' + result.strongTruncated + ' 条被截断（targetN 放大才能全看）')
    if (result.strongMissing && result.strongMissing.length) console.log('⚠ strong 里不在池中的：' + result.strongMissing.join('、'))
    if (result.keepMissing && result.keepMissing.length) console.log('⚠ keep 里不在池中的：' + result.keepMissing.join('、'))
    if (result.probe && result.probe.ok) {
      console.log('敏感性探测：基准 ' + result.probe.baseline + '；' + result.probe.notes.map((n) => n.relax + ' +' + n.unlocked).join(' · '))
    }
    console.log('')
    console.log(renderTable(result.rows))
    if (result.deep && result.deep.covered) {
      console.log('')
      console.log(renderEvidence(result.rows))
    }
    console.log('')
    // 落盘格式可以在设置页关掉某几种，这里只打真的写了的那几个
    if (!saved) {
      console.log('落盘：候选清单不落盘（只有 stage=final 收口结果才写文件）')
    } else {
      const files = [saved.mdPath, saved.csvPath, saved.jsonPath].filter(Boolean)
      console.log('落盘：' + (files[0] || saved.dir))
      for (const file of files.slice(1)) console.log('      ' + file)
    }
  }
} catch (error) {
  console.error('跑失败：' + String(error && error.message ? error.message : error))
  process.exit(1)
}
