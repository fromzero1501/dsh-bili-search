/**
 * dsh-bili-search · 总结骨架
 *
 * 2026-11-02 用户拍板的「总结内容规范 v2」：结构固定、字段按主题换、硬约束永不变。
 * 这个模块不调用任何模型，也不改检索逻辑——它只负责两件事：
 *   1) 判定这批证据属于哪一类主题（profile）；
 *   2) 生成一份可照着写的总结骨架（九节 + L0 硬规则 + 评论规则 + 交付前自检）。
 *
 * 三层：
 *   L0 通用不变量：证据成色先交代、正文与评论来源隔离、结论标 bvid、数字带单位与成立条件、
 *                  必须落名、标证据强度、缺口必须声明、术语归一、同一事实只出现一次。
 *   L1 固定九节：①证据成色 ②关键数字表 ③投入与代价 ④关键维度 ⑤参与方与形态
 *                ⑥局限与坑 ⑦评论区 ⑧按情况对号 ⑨缺口与剔除声明。
 *   L2 主题模板：price / howto / review / event / idea / product / ranking / generic。
 */

export const SUMMARY_VERSION = '2'

export const PROFILE_ORDER = ['price', 'howto', 'review', 'event', 'idea', 'product', 'ranking', 'generic']

export const PROFILES = {
  price: {
    label: '价格成本',
    unit: '元/秒',
    signals: ['价格', '多少钱', '费用', '成本', '套餐', '积分', '报价', '收费', '订阅', '贵', '便宜', '省钱', '折算', '单价'],
    fields: ['单价（元/秒）', '档位差异', '活动价与常态价', '套餐/积分折算（1 积分≈多少元）', '计费方式（按次/抽卡/失败是否计费）', '给定秒数金额', '给定预算可出秒数'],
    commentGroups: ['成本侧（生成/算力/租卡）', '平台与渠道侧'],
    sections: {
      numbers: '每个价格都给：元/秒 + 10 秒/30 秒金额 + 100 元可出多少秒；积分为两步换；档位分行不混算。',
      cost: '同一产出在云端 / 本地 / 租卡三条走法下的现金支出与时间，并列隐性成本（折旧、时间、损件）。',
      dimensions: '速度、质量梯队、分辨率阶梯、稳定性。',
      parties: '模型厂官方平台 / 聚合平台 / 软件内置 三类形态各自适合什么。',
    },
  },
  howto: {
    label: '教程操作',
    unit: '步骤数 / 耗时 / 前置条件',
    signals: ['怎么', '如何', '教程', '手把手', '保姆', '步骤', '安装', '配置', '部署', '流程', '入门'],
    fields: ['步骤序列', '前置环境或账号', '每步耗时', '关键参数与取值', '失败分支与回退', '成功率或限制'],
    commentGroups: ['流程卡点侧', '失败与替代做法侧'],
    sections: {
      numbers: '步骤数、总耗时、每步耗时、版本号与参数取值（带单位与适用版本）。',
      cost: '时间成本、要装的依赖、要付的订阅或额度、失败的返工代价。',
      dimensions: '按步骤顺序 + 每步的判据（做完怎么知道成了）。',
      parties: '可选的实现路线或工具组合，各自前置条件。',
    },
  },
  review: {
    label: '评测对比',
    unit: '评分项 / 测试条件 / 样本量',
    signals: ['横评', '测评', '对比', '谁更强', '实测', '评测', 'pk', '排名', '哪个好', 'vs'],
    fields: ['评分项与权重', '测试条件（机型/版本/参数）', '样本量', '对照基线', '分档结论', '未测的维度'],
    commentGroups: ['实测反驳侧', '长期使用反馈侧'],
    sections: {
      numbers: '每个评分项的结果、对照基线、样本量与测试条件（缺条件必须写明）。',
      cost: '各方案的价格与取得成本，含隐藏门槛。',
      dimensions: '按评分项逐条对比 + 明确未测维度。',
      parties: '参评对象与它们的定位差异。',
    },
  },
  event: {
    label: '事件新闻',
    unit: '时间线（日期）/ 信源数',
    signals: ['发布', '回应', '曝光', '争议', '官宣', '上线', '宣布', '辟谣', '事故', '被判', '融资'],
    fields: ['时间线（日期）', '当事人/机构', '双方说法', '已证实与未证实', '影响范围', '后续进展'],
    commentGroups: ['时间线补充侧', '后续与回应侧'],
    sections: {
      numbers: '关键日期、涉及金额或数量、信源数量（单源必须标）。',
      cost: '各方付出的代价或影响范围。',
      dimensions: '按时间顺序展开，逐条标「已证实 / 未证实」。',
      parties: '涉及的角色与其立场。',
    },
  },
  idea: {
    label: '观点方法论',
    unit: '论点 / 支撑证据数 / 反例',
    signals: ['为什么', '方法论', '经验', '复盘', '心得', '思路', '策略', '认知', '避坑', '建议'],
    fields: ['核心论点', '支撑案例与证据数', '适用边界/前提', '反例或失败案例', '可执行动作'],
    commentGroups: ['实践反例侧', '适用边界侧'],
    sections: {
      numbers: '论点背后可量化的支撑（次数、比例、金额、耗时）。',
      cost: '采纳这套做法的代价与投入。',
      dimensions: '每个论点给：结论 + 支撑 + 边界。',
      parties: '提出者与适用人群。',
    },
  },
  product: {
    label: '产品工具介绍',
    unit: '能力边界 / 门槛 / 替代品',
    signals: ['介绍', '功能', '开源', '工具', '插件', '软件', 'app', '上线', '更新', '新版本'],
    fields: ['能做什么', '不能做什么', '使用门槛（环境/账号/付费）', '授权与合规', '替代品对比', '实测表现'],
    commentGroups: ['实际限制侧', '售后与合规侧'],
    sections: {
      numbers: '版本号、价格、额度、性能数字（附条件）。',
      cost: '获取与使用成本（含隐性成本）。',
      dimensions: '按能力逐项给「能做/不能做/有条件能做」。',
      parties: '同类替代品与其差异。',
    },
  },
  ranking: {
    label: '榜单数据',
    unit: '口径（样本区间 / 时间窗 / 统计方式）',
    signals: ['排行', 'top', '榜', '统计', '数据', '榜单', '指数', '销量'],
    fields: ['口径说明', '样本区间', '时间窗', '排名依据', '异常值处理', '取数日期'],
    commentGroups: ['口径质疑侧', '数据修正与遗漏侧'],
    sections: {
      numbers: '每条数据都给数值 + 口径 + 取数日期。',
      cost: '获取数据的成本或门槛（如有）。',
      dimensions: '按排名展开，标明依据与异常值。',
      parties: '数据发布方与统计范围。',
    },
  },
  generic: {
    label: '通用',
    unit: '关键数字与关键事实',
    signals: [],
    fields: ['关键数字（带单位与条件）', '关键事实（可验证）', '参与方', '限制与代价', '未证实的说法'],
    commentGroups: ['事实补充侧', '反面经验侧'],
    sections: {
      numbers: '凡是数字都要带单位、条件与来源 bvid。',
      cost: '这件事的投入与代价。',
      dimensions: '按主题自身维度列，不硬套价格/教程口径。',
      parties: '涉及的主体与其角色。',
    },
  },
}

/** 九节骨架的节名（L1，固定顺序，不许改名/跳节） */
export const SKELETON_SECTIONS = [
  { id: 'evidence', title: '证据成色', hint: '逐条列字幕段数/覆盖率/评论条数；串台、无字幕、主题偏离的写剔除理由与替代证据。' },
  { id: 'numbers', title: '关键数字与事实表', hint: '每个数字带单位、成立条件与来源 bvid。' },
  { id: 'cost', title: '投入与代价', hint: '现金、时间、门槛、隐性成本。' },
  { id: 'dimensions', title: '关键维度对比', hint: '按本主题的维度逐条对比，缺维度要写明没测。' },
  { id: 'parties', title: '参与方与形态', hint: '平台/工具/人群/路线的分类与各自定位，必须落名。' },
  { id: 'pitfalls', title: '局限与坑', hint: '只写视频正文（标题/简介/字幕）说到的，每条标来源 bvid；评论内容一律不进本节。' },
  { id: 'comments', title: '评论区', hint: '只收共识/高赞/长评的提炼陈述句，不引原话、不写争议、不写结论句；必须落名、标证据强度；段末一行统计。' },
  { id: 'fit', title: '按情况对号', hint: '按人群/预算/产量给建议，写清前置条件。' },
  { id: 'gaps', title: '缺口与剔除声明', hint: '缺换算率/缺测试条件/被剔除的条目逐条声明，不许留白。' },
]

/** L0 硬规则（与主题无关，任何总结都必须满足） */
export const INVARIANTS = [
  '证据成色先交代：字幕段数、覆盖率、评论条数；串台或无字幕的写清剔除理由与改用证据。',
  '来源隔离：正文各节只写视频内容（标题/简介/字幕）并标 bvid；评论只能进⑦评论区。',
  '必须落名：平台、工具、人物、版本、地名都要点名；没点名就写「未点名」，禁止「部分/某些/有人」。',
  '数字带单位与成立条件：不给「很贵/很快」这类裸判断。',
  '标准化换算：每类主题按 profile 的单位归一（价格→元/秒，教程→步骤/耗时，评测→评分项+条件+样本量，事件→时间线/信源数，观点→论点/证据数/反例，产品→能力边界/门槛/替代品，榜单→口径）。',
  '标证据强度：共识 / 高赞 / 单点事实 / 传闻未证实。',
  '同一事实只出现一次，不换措辞重复。',
  '术语归一：口播与 ASR 变体统一成规范名并保留原形（如 RHTV/HTV→RunningHub）；确认不了标「名称待核」。',
  '缺口必须声明：宁可缺，不许编。',
]

/** 评论区规则（v2，用户 2026-11-02 两轮收口后的最终版） */
export const COMMENT_RULES = {
  admit: [
    { kind: '共识', rule: '≥3 条不同评论重复提到同一事实或判断' },
    { kind: '高赞', rule: '点赞在该视频评论前 10% 或 ≥100 赞' },
    { kind: '长评', rule: '正文 ≥200 字且讲完整逻辑' },
  ],
  drop: ['广告与邀请码', '求群号/求资源', '代下代跑报价', '单条提问', '纯情绪与人身攻击', '与主题无关的闲聊'],
  forbid: [
    '引原句、加引号、写「有网友说」「评论区有人」',
    '写正反争议（证据强弱不同时只留强的一方）',
    '写「评论区结论一句话」这类收尾句',
    '模糊指代（部分平台/某些工具）',
    '同一事实写两遍',
  ],
  must: [
    '写成陈述句：谁 + 做了什么 + 导致什么',
    '每条标证据强度（共识/高赞/单点事实/传闻未证实）',
    '标来源：跨多条视频写「来源视频数 N」，只出自一条的标 bvid',
  ],
  dedupe: [
    '同一事实不同说法合并成一条，强度取最高',
    '多条视频都出现的事实合并成一条，标「来源视频数 N」',
    '与正文口径冲突的，正文以视频为准，评论那条标「与正文口径不一致」',
  ],
  tail: '抓取 N 条，纳入 M 条。',
}

const ALL_SIGNAL_TEXT = (profile) => profile.signals

/** 从标题 + 关键词 + 意图里判主题；判不出来回 generic */
export function pickProfile(input = {}) {
  const explicit = String(input.profile || '').toLowerCase()
  if (explicit && explicit !== 'auto' && PROFILES[explicit]) return { id: explicit, matched: 0, reason: 'explicit' }
  const hay = [input.keyword, input.intent, ...(input.titles || [])].filter(Boolean).join(' ').toLowerCase()
  if (!hay.trim()) return { id: 'generic', matched: 0, reason: 'empty' }
  let best = { id: 'generic', matched: 0 }
  for (const id of PROFILE_ORDER) {
    if (id === 'generic') continue
    const hits = ALL_SIGNAL_TEXT(PROFILES[id]).filter((w) => hay.includes(String(w).toLowerCase()))
    if (hits.length > best.matched) best = { id, matched: hits.length, reason: 'signals: ' + hits.slice(0, 4).join('/') }
  }
  if (!best.matched) return { id: 'generic', matched: 0, reason: 'no-signal' }
  return best
}

function subtitleLine(row) {
  const ev = row.evidence
  const sub = ev && ev.subtitle
  if (!sub) return '未取证'
  if (sub.ok) {
    const bits = []
    if (sub.segments != null) bits.push(sub.segments + ' 段')
    if (sub.chars != null) bits.push(sub.chars + ' 字')
    if (sub.coverage != null) bits.push('覆盖 ' + Math.round(sub.coverage * 100) + '%')
    if (sub.charsPerMin != null) bits.push(Math.round(sub.charsPerMin) + ' 字每分')
    if (sub.attempts > 1) bits.push('第 ' + sub.attempts + ' 次才拿到')
    return '可用（' + bits.join(' / ') + '）'
  }
  return '不可用：' + (sub.why || '原因未记录')
}

function commentLine(row) {
  const ev = row.evidence
  const c = ev && ev.comments
  if (!c) return '未取证'
  if (!c.count) return '0 条' + (c.why ? '（' + c.why + '）' : '')
  return c.count + ' 条' + (c.total ? '（共 ' + c.total + ' 条）' : '')
}

/** ① 证据成色表：插件能自动填的部分 */
export function evidenceTable(rows = []) {
  const lines = ['| # | bvid | 标题 | 播放 | 字幕 | 评论 |', '| --- | --- | --- | --- | --- | --- |']
  rows.forEach((row, i) => {
    lines.push(
      '| ' +
        (i + 1) +
        ' | ' +
        row.bvid +
        ' | ' +
        String(row.title || '').replace(/\|/g, '丨') +
        ' | ' +
        (row.play == null ? '—' : row.play) +
        ' | ' +
        subtitleLine(row) +
        ' | ' +
        commentLine(row) +
        ' |',
    )
  })
  return lines.join('\n')
}

/**
 * 生成总结骨架（Markdown）。rows 传的是 result.rows（deep 时带 evidence）。
 * options: { profile, keyword, intent, deepTop }
 */
export function buildSummarySkeleton(rows = [], options = {}) {
  const picked = pickProfile({ profile: options.profile, keyword: options.keyword, intent: options.intent, titles: rows.map((r) => r.title) })
  const p = PROFILES[picked.id] || PROFILES.generic
  const out = []
  out.push('## 总结骨架（按此写，交付时删掉本行说明）')
  out.push('')
  out.push('- 主题类型：**' + p.label + '**（profile `' + picked.id + '`，判定依据：' + (picked.reason || 'n/a') + '）')
  out.push('- 归一单位：' + p.unit)
  out.push('- 必抽字段：' + p.fields.join('、'))
  out.push('- 评论分组：' + p.commentGroups.join(' ／ '))
  if (options.intent) out.push('- 用户意图：' + options.intent)
  out.push('')
  out.push('### 九节（顺序固定，缺数据写「本节无数据」，不许改名或跳节）')
  out.push('')
  SKELETON_SECTIONS.forEach((sec, i) => {
    const n = '①②③④⑤⑥⑦⑧⑨'[i]
    out.push('**' + n + ' ' + sec.title + '** — ' + sec.hint)
    if (sec.id === 'numbers' && p.sections && p.sections.numbers) out.push('　· 本主题要求：' + p.sections.numbers)
    if (sec.id === 'cost' && p.sections && p.sections.cost) out.push('　· 本主题要求：' + p.sections.cost)
    if (sec.id === 'dimensions' && p.sections && p.sections.dimensions) out.push('　· 本主题要求：' + p.sections.dimensions)
    if (sec.id === 'parties' && p.sections && p.sections.parties) out.push('　· 本主题要求：' + p.sections.parties)
    out.push('')
  })
  if (rows.length) {
    out.push('**① 证据成色（插件已自动填，缺的补上剔除理由）**')
    out.push('')
    out.push(evidenceTable(rows))
    out.push('')
  }
  out.push('### L0 硬规则（任何主题都必须满足）')
  out.push('')
  INVARIANTS.forEach((r, i) => out.push(i + 1 + '. ' + r))
  out.push('')
  out.push('### 评论区规则')
  out.push('')
  out.push('- 只收：' + COMMENT_RULES.admit.map((a) => a.kind + '（' + a.rule + '）').join('；'))
  out.push('- 一律剔除：' + COMMENT_RULES.drop.join('、'))
  out.push('- 禁止：' + COMMENT_RULES.forbid.join('；'))
  out.push('- 必须：' + COMMENT_RULES.must.join('；'))
  out.push('- 合并：' + COMMENT_RULES.dedupe.join('；'))
  out.push('- 段末统计（只此一行）：' + COMMENT_RULES.tail)
  out.push('')
  out.push('### 交付前自检')
  out.push('')
  out.push('- [ ] 九节齐？')
  out.push('- [ ] 每条正文结论标了 bvid？')
  if (picked.id === 'price') out.push('- [ ] 每个价格有元/秒 + 秒数金额 + 预算秒数？积分有「每秒多少积分 + 1 积分多少钱」？')
  else out.push('- [ ] 每个数字带单位与成立条件（' + p.unit + '）？')
  out.push('- [ ] 缺点节没有评论来源？')
  out.push('- [ ] 评论无原句、无争议、无结论句，全部落名带强度，有统计行？')
  out.push('- [ ] 剔除项与缺口都写了？')
  out.push('- [ ] 术语已归一，待核的标了待核？')
  return { profile: picked.id, label: p.label, unit: p.unit, text: out.join('\n') }
}

/** 给工具回包用的一行摘要 */
export function summaryHeadline(built) {
  if (!built) return ''
  return '总结骨架：' + built.label + '（profile ' + built.profile + '，单位 ' + built.unit + '）'
}
