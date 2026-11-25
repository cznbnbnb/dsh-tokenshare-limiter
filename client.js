/**
 * dsh-tokenshare-limiter 的 Client 半边：设置 →「TokenShare 限流」页。
 *
 * 两条滑块对应 Host 的两个参数（每分钟上限、异常等待分钟），拖动即保存；
 * 下方的状态区读 /dsh-tokenshare-limiter/api/state，能看到当前窗口用量、
 * 正在排队的等待，以及最近的限流/重放记录。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tokenshare-limiter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 子路径部署（反代挂在 /app/<id>/ 下）时，接口也要带同一前缀。
    const appBase = (() => {
      const fromPath = (p) => {
        const m = /^(.*?)\/plugins\//.exec(String(p || ''))
        return m ? m[1].replace(/\/+$/, '') : null
      }
      try {
        const src = document.currentScript && document.currentScript.src
        if (src) {
          const base = fromPath(new URL(src, document.baseURI).pathname)
          if (base !== null) return base
        }
      } catch (e) { /* 非脚本加载 */ }
      try {
        for (const el of document.querySelectorAll('script[src]')) {
          const base = fromPath(new URL(el.src, document.baseURI).pathname)
          if (base !== null) return base
        }
      } catch (e) { /* 极简 DOM */ }
      return ''
    })()

    const apiBase = (suffix) => {
      const path = '/dsh-tokenshare-limiter/api' + suffix
      return appBase ? appBase + path : path
    }

    const CSS = `
      .tl-panel {
        --ink: var(--dsw-alias-label-primary, #252421);
        --muted: var(--dsw-alias-label-secondary, #665f59);
        --line: var(--dsw-alias-border-l1, #dedbd6);
        --paper: var(--dsw-alias-bg-base, #fff);
        --accent: var(--dsw-alias-brand-primary, #b96345);
        --wash: color-mix(in srgb, var(--ink) 3%, var(--paper));
        --warn: var(--dsw-alias-state-warning-primary, #a46a17);
        --danger: var(--dsw-alias-state-error-primary, #b84a48);
        box-sizing: border-box; width: 100%; min-width: 0; container-type: inline-size;
        font-family: inherit; font-size: 13px; line-height: 1.5; color: var(--ink);
        padding: 3px 0 12px; font-variant-numeric: tabular-nums;
      }
      .tl-panel *, .tl-panel *::after { box-sizing: border-box; }
      .tl-panel :is(h2,h3,p,dl,dd,ul) { margin: 0; }
      .tl-panel :is(button,input,select) { font: inherit; color: inherit; }
      .tl-panel :is(button,select,summary,input):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
      .tl-panel button:disabled, .tl-panel input:disabled { opacity: .55; cursor: default; }
      .tl-head,.tl-line,.tl-setting-heading,.tl-section-head,.tl-scope,.tl-log-row { display: flex; align-items: center; }
      .tl-head,.tl-line,.tl-setting-heading,.tl-section-head { justify-content: space-between; gap: 12px; }
      .tl-head { margin-bottom: 19px; }
      .tl-panel h2 { font-family: inherit; font-size: 22px; font-weight: 650; line-height: 1.25; letter-spacing: -.035em; }
      .tl-scope { color: var(--muted); gap: 7px; font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
      .tl-toggle { display: inline-flex; align-items: center; gap: 8px; flex: none; background: none; border: 0; padding: 5px 0 5px 5px; cursor: pointer; }
      .tl-toggle span:first-child { font-size: 12px; color: var(--muted); }
      .tl-track { width: 32px; height: 19px; border-radius: 12px; background: color-mix(in srgb,var(--ink) 30%,var(--paper)); padding: 3px; }
      .tl-track::after { content: ''; display: block; width: 13px; height: 13px; background: var(--paper); border-radius: 50%; }
      .tl-toggle[aria-checked=true] .tl-track { background: var(--ink); }
      .tl-toggle[aria-checked=true] .tl-track::after { transform: translateX(13px); }
      .tl-window { padding: 16px 18px 14px; border: 1px solid var(--line); background: var(--wash); border-radius: 13px; }
      .tl-panel h3 { font-family: inherit; font-size: 15px; font-weight: 620; line-height: 1.45; letter-spacing: -.02em; }
      .tl-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
      .tl-state::before,.tl-log-dot { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
      .tl-state[data-mode=ok]::before { background: var(--dsw-alias-state-success-primary, #367c68); }
      .tl-state[data-mode=wait]::before,.tl-log-dot.warn { background: var(--warn); }
      .tl-state[data-mode=error]::before,.tl-log-dot.error { background: var(--danger); }
      .tl-meter { display: grid; grid-template-columns: auto minmax(0,1fr); gap: 22px; align-items: center; margin: 10px 0 13px; }
      .tl-reading { white-space: nowrap; font-size: 12px; color: var(--muted); }
      .tl-reading strong { font-size: 29px; line-height: 1.1; font-weight: 590; letter-spacing: -.04em; color: var(--ink); margin-right: 4px; }
      .tl-gauge { display: flex; height: 14px; gap: clamp(1px,.6cqi,4px); }
      .tl-gauge i { flex: 1; min-width: 0; border-radius: 2px; background: color-mix(in srgb,var(--ink) 13%,var(--paper)); }
      .tl-gauge i[data-on=true] { background: var(--accent); }
      .tl-metrics { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); }
      .tl-metrics dt,.tl-secondary,.tl-hint,.tl-empty,.tl-range-bounds { color: var(--muted); font-size: 12px; }
      .tl-metrics dd { font-size: 18px; font-weight: 560; line-height: 1.35; margin-top: 2px; }
      .tl-notice { margin-top: 12px; padding: 9px 12px; border-inline-start: 3px solid var(--warn); background: color-mix(in srgb,var(--warn) 8%,var(--paper)); border-radius: 0 6px 6px 0; }
      .tl-notice b { font-weight: 600; } .tl-notice p { color: var(--muted); font-size: 12px; margin-top: 2px; }
      .tl-notice.error { border-color: var(--danger); overflow-wrap: anywhere; }
      .tl-section { margin-top: 22px; }
      .tl-section-head { margin-bottom: 12px; }
      .tl-rule-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 36px; }
      .tl-rule { min-width: 0; position: relative; }
      .tl-rule+.tl-rule::before { content: ''; position: absolute; inset-block: 0; inset-inline-start: -18px; border-inline-start: 1px solid var(--line); }
      .tl-resume { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; }
      .tl-deadline { font-weight: 600; font-size: 18px; white-space: nowrap; }
      .tl-setting-heading { align-items: baseline; gap: 5px; }
      .tl-setting-heading label { font-weight: 550; }
      .tl-number { display: flex; align-items: baseline; gap: 3px; white-space: nowrap; font-size: 12px; color: var(--muted); }
      .tl-number input { width: 3.2ch; padding: 1px 1px 0; text-align: right; font-size: 18px; font-weight: 580; line-height: 1.2; border: 0; border-bottom: 1px dotted var(--line); border-radius: 0; background: transparent; color: var(--ink); appearance: textfield; }
      .tl-number input::-webkit-inner-spin-button { appearance: none; }
      .tl-range { appearance: none; display:block; width:100%; height:22px; margin: 6px 0 0; padding: 0; border: 0; cursor:pointer; background:transparent; }
      .tl-range::-webkit-slider-runnable-track { height: 4px; border-radius: 6px; background: linear-gradient(to right,var(--accent) var(--fill),var(--line) var(--fill)); }
      .tl-range::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%; background: var(--paper); border: 2px solid var(--accent); }
      .tl-range::-moz-range-track { height: 4px; border-radius: 6px; background: var(--line); }
      .tl-range::-moz-range-progress { height: 4px; background: var(--accent); }
      .tl-range::-moz-range-thumb { width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--accent); background: var(--paper); }
      .tl-range-bounds { display: flex; justify-content: space-between; font-size: 10px; }
      .tl-rule .tl-hint { margin-top: 7px; }
      .tl-select,.tl-action { border: 1px solid var(--line); border-radius: 6px; background: var(--paper); padding: 3px 6px; font-size: 12px!important; cursor: pointer; }
      .tl-action { margin-left: 8px; }
      .tl-log { list-style:none; padding:0; max-height: 164px; overflow:auto; border-top:1px solid var(--line); }
      .tl-log-row { align-items: baseline; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
      .tl-log-row time { font-size: 11px; color: var(--muted); flex: none; }
      .tl-log-dot { width: 5px; height: 5px; align-self: flex-start; margin-top: 7px; background: color-mix(in srgb,var(--muted) 55%,var(--paper)); }
      .tl-log-copy { min-width: 0; margin: 0; font-size: 12px; overflow-wrap: anywhere; }
      .tl-log-copy summary { cursor:pointer; } .tl-log-copy p { color: var(--muted); padding: 5px 0 2px; white-space: pre-wrap; }
      .tl-empty { padding: 10px 0; border-top:1px solid var(--line); }
      @container (max-width: 405px) {
        .tl-rule-grid { grid-template-columns: minmax(0,1fr); gap: 12px; }
        .tl-rule+.tl-rule { border-top: 1px solid var(--line); padding-top: 12px; }
        .tl-rule+.tl-rule::before { display: none; }
        .tl-gauge { gap: 2px; } .tl-window { padding: 14px; }
        .tl-head h2 { font-size: 20px; }
      }
      @container (max-width: 285px) {
        .tl-head,.tl-section-head { flex-wrap: wrap; }
        .tl-metrics { grid-template-columns: repeat(2,minmax(0,1fr)); }
        .tl-meter { grid-template-columns: 1fr; gap: 8px; }
      }
    `

    const clampInt = (n, min, max) => Math.min(max, Math.max(min, Math.round(Number(n) || min)))

    const fmtClock = (ms) => {
      const total = Math.max(0, Math.ceil(ms / 1000))
      const m = Math.floor(total / 60)
      const s = total % 60
      return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
    }

    const fmtTime = (at) => {
      const d = new Date(at)
      return [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((n) => String(n).padStart(2, '0'))
        .join(':')
    }

    function Slider({ id, label, value, unit, hint, disabled, onChange }) {
      const [draft, setDraft] = React.useState(null)
      const commit = event => {
        const raw = event.currentTarget.value
        if (raw.trim() && Number.isFinite(Number(raw))) {
          const next = clampInt(raw, 1, 60)
          if (next !== value) onChange(next)
        }
        setDraft(null)
      }
      return h('div', { className: 'tl-rule' },
        h('div', { className: 'tl-setting-heading' },
          h('label', { htmlFor: id }, label),
          h('span', { className: 'tl-number' },
            h('input', {
              type: 'number', min: 1, max: 60, step: 1, value: draft ?? value, disabled,
              'aria-label': label + '数值', 'aria-describedby': id + '-hint',
              onChange: event => setDraft(event.target.value), onBlur: commit,
              onKeyDown: event => {
                if (event.key === 'Escape') event.currentTarget.value = String(value)
                if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
              },
            }), unit)),
        h('input', {
          id, className: 'tl-range', type: 'range', min: 1, max: 60, step: 1, value, disabled,
          'aria-describedby': id + '-hint', 'aria-valuetext': value + unit,
          style: { '--fill': ((value - 1) / 59) * 100 + '%' },
          onChange: event => { setDraft(null); onChange(Number(event.target.value)) },
        }),
        h('div', { className: 'tl-range-bounds', 'aria-hidden': true }, h('span', null, '1'), h('span', null, '60')),
        h('p', { className: 'tl-hint', id: id + '-hint' }, hint))
    }

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [perMinute, setPerMinute] = React.useState(14)
      const [retryMinutes, setRetryMinutes] = React.useState(5)
      const [loadError, setLoadError] = React.useState('')
      const [saveError, setSaveError] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [saving, setSaving] = React.useState(false)
      const [syncAt, setSyncAt] = React.useState(Date.now())
      const saveTimer = React.useRef(0)
      const pending = React.useRef(null)
      const writes = React.useRef(Promise.resolve())
      const failedPatch = React.useRef(null)
      const outstanding = React.useRef(0)
      const revision = React.useRef(0)

      const pull = React.useCallback(async () => {
        const version = revision.current
        try {
          const res = await fetch(apiBase('/state'), { headers: { Accept: 'application/json' } })
          const data = await res.json()
          if (!data || !data.ok) throw new Error((data && data.error) || '读取状态失败')
          if (version !== revision.current || pending.current || outstanding.current) return
          setStatus(data)
          setSyncAt(Date.now())
          if (!failedPatch.current) {
            setPerMinute(data.settings.perMinute)
            setRetryMinutes(data.settings.retryWaitMinutes)
          }
          setLoadError('')
        } catch (e) {
          setLoadError(String((e && e.message) || e))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => { if (alive && document.visibilityState !== 'hidden') pull() }
        tick()
        const timer = setInterval(tick, 1500)
        return () => { alive = false; clearInterval(timer) }
      }, [pull])

      const push = React.useCallback(async (patch) => {
        const requested = { ...failedPatch.current, ...patch }
        setSaving(true)
        try {
          const res = await fetch(apiBase('/config'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requested), keepalive: true,
          })
          const data = await res.json()
          if (!data || !data.ok) throw new Error((data && data.error) || '保存失败')
          failedPatch.current = null
          setStatus(data)
          setSyncAt(Date.now())
          setSaveError('')
        } catch (e) {
          failedPatch.current = requested
          setSaveError(String((e && e.message) || e))
        } finally {
          setSaving(false)
        }
      }, [])

      const flush = React.useCallback(() => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = 0
        const patch = pending.current
        if (!patch) return
        pending.current = null
        outstanding.current++
        writes.current = writes.current.then(() => push(patch)).finally(() => {
          outstanding.current--
          revision.current++
        })
      }, [push])

      React.useEffect(() => flush, [flush])

      const schedule = (patch, immediate = false) => {
        revision.current++
        pending.current = { ...pending.current, ...patch }
        if (immediate) { flush(); return }
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(flush, 420)
      }

      const settings = status?.settings
      const enabled = settings?.enabled ?? false
      const waiting = status?.waiting
      const used = status?.window.used ?? 0
      const limit = status?.window.limit ?? perMinute
      const recent = status?.recent ?? []
      const visible = filter === 'warn' ? recent.filter(item => item.level === 'warn' || item.level === 'error') : recent
      const displayWait = waiting && (enabled || status.queued || waiting.kind === 'retry')
      const mode = loadError ? 'error' : !settings || !enabled ? 'idle' : displayWait ? 'wait' : 'ok'
      const modes = { error: '状态读取失败', idle: settings ? '已暂停' : '正在读取', wait: '等待发送', ok: '正常放行' }
      const resumeAt = waiting && new Date(waiting.until ?? syncAt + waiting.remainingMs)
      const remaining = resumeAt ? Math.max(0, resumeAt.getTime() - Date.now()) : 0
      const metrics = [
        ['累计请求', status?.stats.total], ['排队等待', status?.stats.rateWaits],
        ['异常重试', status?.stats.retries], ['请求失败', status?.stats.failures],
      ]
      const dirty = settings && (perMinute !== settings.perMinute || retryMinutes !== settings.retryWaitMinutes)
      const routes = settings?.providers ?? []
      const toggle = () => {
        if (!settings) return
        setStatus({ ...status, settings: { ...settings, enabled: !enabled } })
        schedule({ enabled: !enabled }, true)
      }

      return h('div', { className: 'tl-panel' },
        h('style', null, CSS),
        h('header', { className: 'tl-head' },
          h('div', null, h('h2', null, 'TokenShare 限流'),
            routes.length > 0 && routes.join(',') !== 'tokenshare' && h('p', { className: 'tl-scope' }, '受控线路 ' + routes.join('、'))),
          h('button', {
            type: 'button', className: 'tl-toggle', role: 'switch', 'aria-label': '启用限流',
            'aria-checked': enabled, disabled: saving || !settings, onClick: toggle,
          }, h('span', null, '启用限流'), h('span', { className: 'tl-track', 'aria-hidden': true }))),
        loadError && h('div', { className: 'tl-notice error', role: 'alert' },
          loadError, h('button', { type: 'button', className: 'tl-action', onClick: pull }, '重新读取')),
        h('section', { className: 'tl-window', 'aria-label': '请求窗口' },
          h('div', { className: 'tl-line' },
            h('h3', null, settings ? '近 ' + settings.windowSeconds + ' 秒用量' : '请求窗口'),
            h('span', { className: 'tl-state', 'data-mode': mode }, modes[mode])),
          displayWait && h('div', { className: 'tl-notice' },
            h('div', { className: 'tl-resume' },
              h('b', null, !enabled ? '已排队请求仍在等待' : waiting.kind === 'account' ? '账号限流' : waiting.kind === 'rate' ? '窗口已满' : '等待重试'),
              h('time', { className: 'tl-deadline', dateTime: resumeAt.toISOString() },
                resumeAt.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))),
            h('p', null, resumeAt.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) +
              ' 北京时间恢复，剩余 ' + fmtClock(remaining) + (status.queued ? '，' + status.queued + ' 个请求排队。' : '。'))),
          h('div', { className: 'tl-meter' },
            h('div', { className: 'tl-reading' }, h('strong', null, status ? used : '—'), ' / ' + (status ? limit : '—') + ' 次'),
            h('div', { className: 'tl-gauge', 'aria-hidden': true },
              Array.from({ length: limit }, (_, i) => h('i', { key: i, 'data-on': !!status && i < used })))),
          h('dl', { className: 'tl-metrics' },
            metrics.map(([label, count]) => h('div', { key: label }, h('dt', null, label), h('dd', null, count ?? '—'))))),
        h('section', { className: 'tl-section', 'aria-label': '限流规则' },
          h('div', { className: 'tl-section-head' },
            h('h3', null, '限流规则'),
            h('span', { className: 'tl-secondary', role: 'status' },
              saveError ? '保存失败' : saving ? '正在保存…' : dirty ? '待保存' : '自动保存',
              (dirty || saveError) && h('button', {
                type: 'button', className: 'tl-action', disabled: saving || !settings,
                onClick: () => schedule(saveError ? failedPatch.current : { perMinute, retryWaitMinutes: retryMinutes }, true),
              }, saveError ? '重试保存' : '立即保存'))),
          saveError && h('p', { className: 'tl-notice error', role: 'alert' }, saveError),
          h('div', { className: 'tl-rule-grid' },
            h(Slider, {
              id: 'tl-request-cap', label: '窗口请求上限', value: perMinute, unit: '次', disabled: !settings,
              hint: '超出上限的请求按顺序排队。',
              onChange: value => { setPerMinute(value); schedule({ perMinute: value }) },
            }),
            h(Slider, {
              id: 'tl-retry-delay', label: '故障重试间隔', value: retryMinutes, unit: '分钟', disabled: !settings,
              hint: '账号限流时按服务端解限时间等待。',
              onChange: value => { setRetryMinutes(value); schedule({ retryWaitMinutes: value }) },
            }))),
        h('section', { className: 'tl-section', 'aria-label': '最近活动' },
          h('div', { className: 'tl-section-head' },
            h('h3', null, '最近活动'),
            h('select', { className: 'tl-select', value: filter, 'aria-label': '筛选最近活动', onChange: e => setFilter(e.target.value) },
              h('option', { value: 'all' }, '全部活动'), h('option', { value: 'warn' }, '仅警告和错误'))),
          visible.length > 0 ? h('ul', { className: 'tl-log' }, visible.map((item, i) => {
            const text = item.text
            let label = text
            if (text === '已监听 llm/stream') label = '模型请求已接入限流'
            else if (text.startsWith('已监听 agent/request-error')) label = '图片上限恢复已就绪'
            else if (text.startsWith('节流已就绪，管控：')) label = '已启用线路 ' + text.slice('节流已就绪，管控：'.length)
            else if (item.level === 'error' && text.length > 80) label = '请求失败，查看详情'
            return h('li', { className: 'tl-log-row', key: item.at + '-' + i },
              h('time', { dateTime: new Date(item.at).toISOString() }, fmtTime(item.at)),
              h('span', { className: 'tl-log-dot ' + item.level, 'aria-hidden': true }),
              item.level === 'error' && label !== text
                ? h('details', { className: 'tl-log-copy' }, h('summary', null, label), h('p', null, text))
                : h('span', { className: 'tl-log-copy', title: label !== text ? text : undefined }, label))
          })) : h('p', { className: 'tl-empty' }, status ? (filter === 'warn' ? '近期没有警告或错误。' : '暂无活动记录。') : '正在读取活动记录…')))
    }

    // 设置导航行的小图标：跟随主题前景色，未注册时会退化成通用齿轮。
    function SectionIcon(props) {
      const size = (props && props.size) || 16
      return h('svg', {
        viewBox: '0 0 64 64',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      },
        h('circle', {
          cx: 32, cy: 32, r: 23, fill: 'none',
          stroke: 'currentColor', strokeOpacity: 0.28, strokeWidth: 5,
        }),
        h('path', {
          d: 'M32 9 A23 23 0 1 1 13.4 43.5',
          fill: 'none', stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round',
        }),
        h('path', { d: 'M25 21 H39 L32.8 30.2 H31.2 Z', fill: 'currentColor' }),
        h('path', { d: 'M31.2 33.8 H32.8 L39 43 H25 Z', fill: 'currentColor', fillOpacity: 0.65 }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (!slots) return
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'tokenshare-limiter',
          order: 26,
          label: 'TokenShare 限流',
        }, () => h(Panel)))
        slots.inject('settings.section.icon', () => slots.register({
          name: 'settings.section.icon',
          id: 'tokenshare-limiter',
        }, (props) => h(SectionIcon, props)))
      },
    }
  },
})
