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

    const CSS = [
      '.tl-panel{display:flex;flex-direction:column;gap:16px;padding:2px 0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.tl-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.tl-title{font-size:14px;font-weight:600;margin:0}',
      '.tl-sub{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0}',
      '.tl-pill{flex:none;font-size:11px;padding:2px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.tl-pill.on{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.tl-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px}',
      '.tl-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.tl-label{font-size:13px;font-weight:500}',
      '.tl-value{font-size:13px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.tl-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0}',
      '.tl-range{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:999px;outline:none;cursor:pointer;margin:2px 0 0}',
      '.tl-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-brand-primary);border:2px solid var(--dsw-alias-bg-layer-1);box-shadow:0 1px 4px rgba(0,0,0,.28);cursor:pointer;transition:transform .12s ease}',
      '.tl-range::-webkit-slider-thumb:hover{transform:scale(1.12)}',
      '.tl-range::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-brand-primary);border:2px solid var(--dsw-alias-bg-layer-1);cursor:pointer}',
      '.tl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}',
      '.tl-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.tl-stat .k{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.tl-stat .v{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.tl-wait{display:flex;align-items:center;gap:9px;border-radius:9px;padding:9px 12px;font-size:12px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent);color:var(--dsw-alias-label-primary)}',
      '.tl-wait .dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:tl-pulse 1.4s ease-in-out infinite}',
      '@keyframes tl-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
      '.tl-wait.retry{border-color:color-mix(in srgb,#e5a13a 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,#e5a13a 12%,transparent)}',
      '.tl-wait.retry .dot{background:#e5a13a}',
      '.tl-log{display:flex;flex-direction:column;gap:5px;max-height:190px;overflow:auto}',
      '.tl-log-item{display:flex;gap:9px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.tl-log-item .t{flex:none;font-variant-numeric:tabular-nums;opacity:.7}',
      '.tl-log-item.warn .m{color:#c9861f}',
      '.tl-log-item.error .m{color:#d94a4f}',
      '.tl-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.tl-btn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}',
      '.tl-btn:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.tl-btn:disabled{opacity:.5;cursor:default}',
      '.tl-err{border:1px solid #d94a4f;border-radius:8px;padding:7px 11px;font-size:12px;color:#d94a4f}',
      '.tl-empty{font-size:12px;color:var(--dsw-alias-label-secondary)}',
    ].join('\n')

    const clampInt = (n, min, max) => Math.min(max, Math.max(min, Math.round(Number(n) || min)))

    const fmtClock = (ms) => {
      const total = Math.max(0, Math.ceil(ms / 1000))
      const m = Math.floor(total / 60)
      const s = total % 60
      return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s} 秒`
    }

    const fmtTime = (at) => {
      const d = new Date(at)
      return [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((n) => String(n).padStart(2, '0'))
        .join(':')
    }

    function Slider(props) {
      const { label, value, min, max, step, unit, hint, onChange } = props
      const pct = ((value - min) / (max - min)) * 100
      return h('div', { className: 'tl-card' },
        h('div', { className: 'tl-row' },
          h('span', { className: 'tl-label' }, label),
          h('span', { className: 'tl-value' }, `${value} ${unit}`),
        ),
        h('input', {
          className: 'tl-range',
          type: 'range',
          min,
          max,
          step,
          value,
          'aria-label': label,
          style: {
            background: `linear-gradient(to right, var(--dsw-alias-brand-primary) ${pct}%, var(--dsw-alias-border-l1) ${pct}%)`,
          },
          onChange: (event) => onChange(clampInt(event.target.value, min, max)),
        }),
        h('p', { className: 'tl-hint' }, hint),
      )
    }

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [perMinute, setPerMinute] = React.useState(14)
      const [retryMinutes, setRetryMinutes] = React.useState(5)
      const [error, setError] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [syncAt, setSyncAt] = React.useState(Date.now())
      const primed = React.useRef(false)
      const saveTimer = React.useRef(0)

      const pull = React.useCallback(async () => {
        try {
          const res = await fetch(apiBase('/state'), { headers: { Accept: 'application/json' } })
          const data = await res.json()
          if (!data || !data.ok) throw new Error((data && data.error) || '读取状态失败')
          setStatus(data)
          setSyncAt(Date.now())
          if (!primed.current) {
            primed.current = true
            setPerMinute(data.settings.perMinute)
            setRetryMinutes(data.settings.retryWaitMinutes)
          }
          setError('')
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => { if (alive && document.visibilityState !== 'hidden') pull() }
        tick()
        const timer = setInterval(tick, 1500)
        return () => { alive = false; clearInterval(timer) }
      }, [pull])

      React.useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

      const push = React.useCallback(async (patch) => {
        setSaving(true)
        try {
          const res = await fetch(apiBase('/config'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
          const data = await res.json()
          if (!data || !data.ok) throw new Error((data && data.error) || '保存失败')
          setStatus(data)
          setSyncAt(Date.now())
          setError('')
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setSaving(false)
        }
      }, [])

      const schedule = (patch) => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => { saveTimer.current = 0; push(patch) }, 420)
      }

      const settings = status && status.settings
      const enabled = settings ? settings.enabled : true
      const waiting = status && status.waiting
      const used = status ? status.window.used : 0
      const limit = status ? status.window.limit : perMinute
      const recent = (status && status.recent) || []

      const remaining = waiting ? Math.max(0, waiting.remainingMs - (Date.now() - syncAt)) : 0

      const toggle = () => {
        if (!settings) return
        const next = !settings.enabled
        setStatus({ ...status, settings: { ...settings, enabled: next } })
        push({ enabled: next })
      }

      return h('div', { className: 'tl-panel' },
        h('style', null, CSS),
        h('div', { className: 'tl-head' },
          h('div', null,
            h('h3', { className: 'tl-title' }, 'TokenShare 限流'),
            h('p', { className: 'tl-sub' }, '只作用于 TokenShare 这类第三方 provider：出口节流防止超频封号，上游 5xx 后自动等待重放。'),
          ),
          h('button', {
            className: enabled ? 'tl-pill on' : 'tl-pill',
            type: 'button',
            disabled: saving || !settings,
            onClick: toggle,
            title: enabled ? '点击暂停' : '点击启用',
          }, enabled ? '运行中' : '已暂停'),
        ),

        error ? h('div', { className: 'tl-err' }, error) : null,

        waiting
          ? h('div', { className: waiting.kind === 'retry' ? 'tl-wait retry' : 'tl-wait' },
            h('span', { className: 'dot' }),
            waiting.kind === 'retry'
              ? `上游异常，${settings ? settings.retryWaitMinutes : retryMinutes} 分钟后重放 · 还需 ${fmtClock(remaining)}`
              : `已达到每分钟上限，排队等待 · 还需 ${fmtClock(remaining)}`,
          )
          : null,

        h(Slider, {
          label: '每分钟最多请求',
          value: perMinute,
          min: 1,
          max: 60,
          step: 1,
          unit: '次/分钟',
          hint: `窗口 ${settings ? settings.windowSeconds : 60} 秒内最多放行 ${perMinute} 次。超出的请求会排到窗口滚动之后再发出，而不是直接失败。`,
          onChange: (value) => { setPerMinute(value); schedule({ perMinute: value }) },
        }),

        h(Slider, {
          label: '异常后等待重试',
          value: retryMinutes,
          min: 1,
          max: 60,
          step: 1,
          unit: '分钟',
          hint: '遇到 429 / 5xx 这类上游临时故障时，等这么久再发一次。已经输出过正文的请求不重放，避免内容重复。',
          onChange: (value) => { setRetryMinutes(value); schedule({ retryWaitMinutes: value }) },
        }),

        h('div', { className: 'tl-grid' },
          h('div', { className: 'tl-stat' }, h('span', { className: 'k' }, '本窗口用量'), h('span', { className: 'v' }, `${used} / ${limit}`)),
          h('div', { className: 'tl-stat' }, h('span', { className: 'k' }, '累计请求'), h('span', { className: 'v' }, status ? status.stats.total : 0)),
          h('div', { className: 'tl-stat' }, h('span', { className: 'k' }, '排队等待'), h('span', { className: 'v' }, status ? status.stats.rateWaits : 0)),
          h('div', { className: 'tl-stat' }, h('span', { className: 'k' }, '异常重放'), h('span', { className: 'v' }, status ? status.stats.retries : 0)),
        ),

        settings && settings.providers && settings.providers.length
          ? h('p', { className: 'tl-hint' }, `当前管控 provider：${settings.providers.join('、')}（在插件配置的 providers 里改）`)
          : null,

        h('div', { className: 'tl-card' },
          h('div', { className: 'tl-row' },
            h('span', { className: 'tl-label' }, '最近记录'),
            h('button', {
              className: 'tl-btn',
              type: 'button',
              disabled: true,
              title: '窗口计数随时间自然滚动',
            }, status ? `失败 ${status.stats.failures} 次` : ''),
          ),
          recent.length
            ? h('div', { className: 'tl-log' },
              recent.map((item, index) => h('div', {
                className: 'tl-log-item' + (item.level === 'warn' ? ' warn' : item.level === 'error' ? ' error' : ''),
                key: `${item.at}-${index}`,
              },
                h('span', { className: 't' }, fmtTime(item.at)),
                h('span', { className: 'm' }, item.text),
              )),
            )
            : h('div', { className: 'tl-empty' }, '暂无记录。'),
        ),

        h('div', { className: 'tl-actions' },
          h('button', {
            className: 'tl-btn',
            type: 'button',
            disabled: saving,
            onClick: () => push({ perMinute, retryWaitMinutes: retryMinutes }),
          }, saving ? '保存中…' : '立即保存'),
          h('span', { className: 'tl-hint' }, '拖动滑块会自动保存，立刻生效。'),
        ),
      )
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
