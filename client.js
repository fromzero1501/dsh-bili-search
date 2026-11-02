/**
 * dsh-bili-search · 设置页（浏览器半边）
 * ============================================================================
 * ⚠ client bundle 不是 ESM，是自注册脚本（抄 dsh-bili-scroll / dsh-meme 的写法）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                    // 必须等于 package.json 的 name
 *       factory: (require) => { ...; return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * 进「设置」的方式：往 settings.section 槽位注册一节，label 就是左侧导航那一项。
 *
 * 这一页只做四件事：读设置（GET /bili-filter-api/settings）、改设置（POST 同路径）、
 * 执行三个一次性动作（检测登录 / 刷新签名 / 清除冷却），以及显示只读状态。
 * 保存逻辑全在宿主半边（lib/settings.js）校验，页面上只负责把话说清楚。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-search',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/bili-filter-api'

    const asJson = async (res) => {
      const body = await res.json().catch(() => ({}))
      if (!res.ok && !body.errors) throw new Error(body.error || 'HTTP ' + res.status)
      return body
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-bf-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:680px;}
[data-bf-sec]{display:flex;flex-direction:column;gap:8px;}
[data-bf-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bf-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-bf-label]{font-size:13px;min-width:132px;}
[data-bf-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bf-input]{padding:6px 8px;border-radius:8px;font-size:12px;font-family:inherit;box-sizing:border-box;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;}
[data-bf-input]:focus{outline:none;border-color:#3b82f6;}
[data-bf-num]{width:96px;text-align:center;}
[data-bf-range]{display:flex;align-items:center;gap:8px;}
[data-bf-range] [data-bf-num]{width:78px;}
[data-bf-dash]{opacity:.45;font-size:12px;}
[data-bf-wide]{flex:1;min-width:180px;}
[data-bf-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-bf-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-bf-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-bf-btn][disabled]{opacity:.5;cursor:default;}
[data-bf-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));}
[data-bf-msg][data-good]{background:rgba(34,197,94,.16);}
[data-bf-msg][data-bad]{background:rgba(239,68,68,.16);}
[data-bf-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary,#b6bcc4);word-break:break-all;}
[data-bf-chk]{display:flex;align-items:center;gap:6px;font-size:12px;}
[data-bf-adv]{font-size:12px;}
[data-bf-adv] summary{cursor:pointer;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px;}
`

    const DURATIONS = [
      ['any', '不限'],
      ['1', '10 分钟以内'],
      ['2', '10–30 分钟'],
      ['3', '30–60 分钟'],
      ['4', '1 小时以上'],
    ]

    // 2026-11-02 用户定：默认只用综合排序；其余排序勾了才跑（每多一个排序就多一轮请求）
    const ORDER_LABELS = [
      ['totalrank', '综合（固定开）'],
      ['click', '播放最多'],
      ['pubdate', '最新发布'],
      ['dm', '弹幕最多'],
      ['stow', '收藏最多'],
    ]

    const ordersOf = (draft) => {
      const raw = Array.isArray(draft.orders) ? draft.orders : ['totalrank']
      const picked = raw.filter((key) => ORDER_LABELS.some(([k]) => k === key))
      return picked.includes('totalrank') ? picked : ['totalrank', ...picked]
    }

    const toggleOrder = (current, key, on) => {
      if (key === 'totalrank') return ordersOf({ orders: current })
      const next = on ? [...current, key] : current.filter((k) => k !== key)
      return ordersOf({ orders: next })
    }

    function Row(props) {
      return h('div', { 'data-bf-row': '' }, props.children)
    }

    function Num(props) {
      return h('input', {
        'data-bf-input': '',
        'data-bf-num': '',
        type: 'number',
        value: props.value,
        min: props.min,
        max: props.max,
        onChange: (e) => props.onChange(e.target.value),
      })
    }

    function Text(props) {
      return h('input', {
        'data-bf-input': '',
        'data-bf-wide': '',
        type: 'text',
        value: props.value,
        placeholder: props.placeholder || '',
        onChange: (e) => props.onChange(e.target.value),
      })
    }

    function Select(props) {
      return h('select', {
        'data-bf-input': '',
        value: props.value,
        onChange: (e) => props.onChange(e.target.value),
      }, props.options.map(([value, label]) => h('option', { key: value, value }, label)))
    }

    function Panel() {
      const [draft, setDraft] = React.useState(null)
      const [limits, setLimits] = React.useState({})
      const [state, setState] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const [cfg, st] = await Promise.all([jget('/settings'), jget('/state')])
          setDraft(cfg.settings)
          setLimits(cfg.limits || {})
          setState(st)
        } catch (error) {
          setMsg({ bad: true, text: '读不到设置：' + String(error.message || error) })
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      // 自动保存（2026-11-02 用户定）：改任何一项就落盘，不用点按钮。
      // 做法：改动时把「要写的那份」放进 ref，由 draft 变化触发 debounce 写盘；
      // 不在 setDraft 的 updater 里直接发请求（那个函数要纯，StrictMode 会跑两遍）。
      const pending = React.useRef(null)
      const timer = React.useRef(null)
      const seq = React.useRef(0)

      const autosave = React.useCallback((next) => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(async () => {
          const mine = ++seq.current
          setBusy('save')
          try {
            const out = await jpost('/settings', next)
            if (mine !== seq.current) return
            if (out.ok) {
              const at = new Date().toLocaleTimeString('zh-CN', { hour12: false })
              setMsg({ good: true, text: '已自动保存 ' + at + '（下一次检索就用新值，不用重启）' })
              setState(await jget('/state'))
            } else {
              setMsg({ bad: true, text: '这一版没存进去：' + (out.errors || []).map((e) => e.field + ' ' + e.message).join('；') })
            }
          } catch (error) {
            setMsg({ bad: true, text: '没存进去：' + String(error.message || error) })
          } finally {
            if (mine === seq.current) setBusy('')
          }
        }, 600)
      }, [])

      React.useEffect(() => {
        const next = pending.current
        if (!next) return
        pending.current = null
        autosave(next)
      }, [draft, autosave])

      React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

      const stage = (patch) => {
        setDraft((prev) => {
          const next = { ...prev, ...patch }
          pending.current = next
          return next
        })
      }

      const set = (key, value) => stage({ [key]: value })
      const setSub = (key, value) => {
        setDraft((prev) => {
          const next = { ...prev, subtitle: { ...prev.subtitle, [key]: value } }
          pending.current = next
          return next
        })
      }
      const setFmt = (key, value) => {
        setDraft((prev) => {
          const next = { ...prev, formats: { ...prev.formats, [key]: value } }
          pending.current = next
          return next
        })
      }

      const act = async (name, path, label) => {
        setBusy(name)
        setMsg(null)
        try {
          const out = await jpost(path)
          if (out.ok) setMsg({ good: true, text: label + '：' + (out.message || '成功') })
          else setMsg({ bad: true, text: label + '没成：' + (out.message || out.error || '未知原因') })
          setState(await jget('/state'))
        } catch (error) {
          setMsg({ bad: true, text: label + '没成：' + String(error.message || error) })
        } finally {
          setBusy('')
        }
      }

      if (!draft) {
        return h('div', { 'data-bf-page': '' },
          h('div', { 'data-bf-h': '' }, 'B站搜索'),
          msg ? h('div', { 'data-bf-msg': '', 'data-bf-bad': msg.bad ? '' : undefined }, msg.text) : h('div', { 'data-bf-note': '' }, '读取中…'))
      }

      const lim = (key) => limits[key] || {}

      return h('div', { 'data-bf-page': '' },
        h('div', { 'data-bf-h': '' }, 'B站检索筛选 · 默认值'),
        h('div', { 'data-bf-note': '' },
          '这里存的是「你没在对话里指定时」用的默认值。对话里明确说了什么，就以对话为准（调用参数 > 本页设置 > 内置默认）。改完立即自动保存（不用点按钮），下一次检索就生效。'),

        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '搜索筛选'),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '时间筛选（最近多少天，0=不限）'),
            h(Num, { value: draft.days, min: lim('days').min, max: lim('days').max, onChange: (v) => set('days', v) })),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '时长筛选'),
            h(Select, { value: draft.duration, options: DURATIONS, onChange: (v) => set('duration', v) })),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '自定义时长区间（分钟，0=不限；填了就忽略上面的档位）'),
            h('div', { 'data-bf-range': '' },
              h(Num, { value: draft.durationMin === undefined ? 0 : draft.durationMin, min: lim('durationMin').min, max: lim('durationMin').max, onChange: (v) => set('durationMin', v) }),
              h('span', { 'data-bf-dash': '' }, '–'),
              h(Num, { value: draft.durationMax === undefined ? 0 : draft.durationMax, min: lim('durationMax').min, max: lim('durationMax').max, onChange: (v) => set('durationMax', v) }))),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '播放量筛选（硬闸 G7，0=不限）'),
            h(Num, { value: draft.minPlay, min: lim('minPlay').min, max: lim('minPlay').max, onChange: (v) => set('minPlay', v) })),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '候选清单数量（list 阶段给模型筛的条数）'),
            h(Num, { value: draft.candidateLimit === undefined ? 200 : draft.candidateLimit, min: lim('candidateLimit').min, max: lim('candidateLimit').max, onChange: (v) => set('candidateLimit', v) })),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '排序（默认只用综合，勾越多请求越多）'),
            h('div', { 'data-bf-orders': '' },
              ORDER_LABELS.map(([key, label]) =>
                h('label', { 'data-bf-chk': '', key },
                  h('input', {
                    type: 'checkbox',
                    checked: ordersOf(draft).includes(key),
                    disabled: key === 'totalrank',
                    onChange: (e) => set('orders', toggleOrder(ordersOf(draft), key, e.target.checked)),
                  }),
                  label)))),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '要几条结果'),
            h(Num, { value: draft.targetN, min: lim('targetN').min, max: lim('targetN').max, onChange: (v) => set('targetN', v) })),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '同一个 UP 最多几条'),
            h(Num, { value: draft.upCap, min: lim('upCap').min, max: lim('upCap').max, onChange: (v) => set('upCap', v) })),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '限定分区'),
            h(Text, { value: draft.typename, placeholder: '留空不限，例如：计算机技术', onChange: (v) => set('typename', v) })),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '排除词'),
            h(Text, { value: draft.exclude, placeholder: '空格分隔，命中标题/标签/简介就淘汰', onChange: (v) => set('exclude', v) }))),

        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '模式与总结'),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '默认模式'),
            h(Select, {
              value: draft.mode,
              options: [['overview', '普通（只给链接/发布时间/播放量/时长）'], ['deep', '总结（前 N 条读详情+字幕+评论）']],
              onChange: (v) => set('mode', v),
            })),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '视频总结条数'),
            h(Num, { value: draft.deepTop, min: lim('deepTop').min, max: lim('deepTop').max, onChange: (v) => set('deepTop', v) })),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '每条视频抓多少评论'),
            h(Select, {
              value: String(draft.commentTarget),
              options: [['20', '20 条'], ['50', '50 条'], ['100', '100 条（慢，且更费调用）']],
              onChange: (v) => set('commentTarget', v),
            })),
          h(Row, null,
            h('label', { 'data-bf-chk': '' },
              h('input', { type: 'checkbox', checked: draft.summary !== false, onChange: (e) => set('summary', e.target.checked) }),
              'deep 收口后附「总结骨架」（九节 + 硬规则 + 评论规则）')),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '总结骨架主题'),
            h(Select, {
              value: draft.summaryProfile || 'auto',
              options: [
                ['auto', '自动判断（按关键词与标题）'],
                ['price', '价格成本'],
                ['howto', '教程操作'],
                ['review', '评测对比'],
                ['event', '事件新闻'],
                ['idea', '观点方法论'],
                ['product', '产品工具介绍'],
                ['ranking', '榜单数据'],
                ['generic', '通用'],
              ],
              onChange: (v) => set('summaryProfile', v),
            })),
          h('details', { 'data-bf-adv': '' },
            h('summary', null, '字幕质量闸（高级，默认别动）'),
            h(Row, null,
              h('div', { 'data-bf-label': '' }, '覆盖率下限'),
              h(Num, { value: draft.subtitle.minCoverage, min: 0.2, max: 1, onChange: (v) => setSub('minCoverage', v) })),
            h(Row, null,
              h('div', { 'data-bf-label': '' }, '字数密度下限'),
              h(Num, { value: draft.subtitle.minCharsPerMin, min: 20, max: 300, onChange: (v) => setSub('minCharsPerMin', v) })),
            h(Row, null,
              h('div', { 'data-bf-label': '' }, '字数密度上限'),
              h(Num, { value: draft.subtitle.maxCharsPerMin, min: 200, max: 2000, onChange: (v) => setSub('maxCharsPerMin', v) })),
            h(Row, null,
              h('div', { 'data-bf-label': '' }, '最少段数'),
              h(Num, { value: draft.subtitle.minSegments, min: 5, max: 200, onChange: (v) => setSub('minSegments', v) })),
            h('div', { 'data-bf-note': '' }, '时间轴比视频还长（疑似串台）一律判不可用，这条硬闸不给开关。'))),

        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '风控与探测（谨慎修改）'),
          h(Row, null,
            h('label', { 'data-bf-chk': '' },
              h('input', { type: 'checkbox', checked: !!draft.probe, onChange: (e) => set('probe', e.target.checked) }),
              '结果偏少时做敏感性探测')),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '请求间隔（毫秒）'),
            h(Num, { value: draft.gapMs, min: lim('gapMs').min, max: lim('gapMs').max, onChange: (v) => set('gapMs', v) })),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '冷却时长（分钟）'),
            h(Num, { value: draft.cooldownMinutes, min: lim('cooldownMinutes').min, max: lim('cooldownMinutes').max, onChange: (v) => set('cooldownMinutes', v) })),
          h('div', { 'data-bf-note': '' },
            '间隔最低 200 毫秒（默认 340，2026-11-02 从 900 降下来——900 是没实测过的保守值）；冷却最短 5 分钟；单轮调用上限是写死的硬顶（普通按页数与排序数算 / 总结模式按条数抬到最多 70 次）。这几项不给「关掉」的开关 —— 硬刷只会把账号和 IP 送进黑名单。'),
          h(Row, null,
            h('button', {
              'data-bf-btn': '',
              disabled: busy === 'cooldown',
              onClick: () => act('cooldown', '/clear-cooldown', '清除冷却'),
            }, '立即清除冷却'),
            h('div', { 'data-bf-note': '' }, state ? '当前剩余冷却：' + state.cooldownMinutes + ' 分钟 · 本次已用调用：' + state.callsThisRun : ''))),

        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '账号与落盘'),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, 'cookie 文件'),
            h(Text, { value: draft.cookiePath, placeholder: '留空 = 用 bili CLI 的凭证（~/.bilibili-cli/credential.json）', onChange: (v) => set('cookiePath', v) })),
          h(Row, null,
            h('button', { 'data-bf-btn': '', disabled: busy === 'login', onClick: () => act('login', '/probe-login', '检测登录') }, '检测登录'),
            h('button', { 'data-bf-btn': '', disabled: busy === 'wbi', onClick: () => act('wbi', '/refresh-wbi', '刷新签名') }, '刷新签名'),
            h('div', { 'data-bf-note': '' }, '只读凭证，不写账号数据；这里也只存路径，不存 cookie 内容。')),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '结果目录'),
            h(Text, { value: draft.outDir, placeholder: '留空 = ~/Documents/bili-filter', onChange: (v) => set('outDir', v) })),
          h(Row, null,
            h('div', { 'data-bf-label': '' }, '落盘格式'),
            ['md', 'csv', 'json'].map((key) => h('label', { key, 'data-bf-chk': '' },
              h('input', { type: 'checkbox', checked: !!draft.formats[key], onChange: (e) => setFmt(key, e.target.checked) }),
              key)))) ,

        h(Row, null,
          h('span', { 'data-bf-note': '' }, busy === 'save' ? '自动保存中…' : '改哪一项就自动存哪一项，不用点保存'),
          h('button', { 'data-bf-btn': '', onClick: load }, '重新读取')),
        msg ? h('div', { 'data-bf-msg': '', 'data-bf-good': msg.good ? '' : undefined, 'data-bf-bad': msg.bad ? '' : undefined }, msg.text) : null,

        h('div', { 'data-bf-sec': '' },
          h('div', { 'data-bf-h': '' }, '状态（只读）'),
          state ? h('div', { 'data-bf-kv': '' },
            '插件版本：' + state.version,
            h('br'),
            '传输方式：' + (state.transport === 'unknown' ? '还没发过请求（首次检索时确定）' : state.transport),
            h('br'),
            '设置文件：' + state.settingsFile,
            state.lastRun ? h('span', null,
              h('br'),
              '最近一次：' + state.lastRun.keyword + ' · ' + (state.lastRun.mode === 'deep' ? '总结' : '普通') +
                ' · 取样 ' + state.lastRun.sampled + ' → 输出 ' + state.lastRun.output + ' 条 · ' + state.lastRun.calls + ' 次调用',
              state.lastRun.files && state.lastRun.files.dir ? h('span', null, h('br'), '落在：' + state.lastRun.files.dir) : null)
              : h('span', null, h('br'), '还没跑过检索'))
            : h('div', { 'data-bf-note': '' }, '读取中…')))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 外层兜底：设置页挂不上时只报错，别把宿主前端整体带崩
        try {
          mountPanel(ctx)
        } catch (error) {
          console.error('[bili-search] 设置页挂载失败（不影响宿主其它页面）：', error)
        }
      },
    }

    function mountPanel(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', 'dsh-bili-search')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'dsh-bili-search: 设置页样式')

      const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
      if (!slots) {
        console.warn('[bili-search] 没有 slots，设置页没挂上')
        return
      }
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'bili-search', order: 34, label: 'B站搜索' },
        () => h(Panel),
      ))
    }
  },
})
