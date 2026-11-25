/**
 * dsh-tokenshare-limiter — 第三方 provider（默认 TokenShare）的请求节流与异常重试。
 *
 * 四个关注点：
 *   1. 命中 `llm/stream` 瀑布，只对配置里的 provider 路由生效；其它 provider 原样放行。
 *   2. 出口节流：滑动窗口内最多 `perMinute` 次请求，超出的请求在真正发起前排队等待，
 *      窗口滚动后才会发出去（TokenShare 超限封号，所以宁可慢也不能超）。
 *   3. 失败重放：上游 429/5xx 这类「服务端临时不可用」的失败，等 `retryWaitMinutes`
 *      分钟后重新发起一次；已经吐出内容的流不重放，避免正文重复。
 *   4. 图片上限：路由预算在发送前触发宿主图片转存；上游仍报图片数量 400 时，
 *      持久化转存最旧图片并重试，不修改冻结请求、不删除原始附件。
 *
 * 参数在设置页用滑块调节，存在插件自己的一个小 JSON 里（见 SETTINGS_FILE）：
 * 改完立刻生效、不重启插件，也不会被插件管理器的禁用/启用抹掉。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { offloadImagesForFailure, offloadImagesToBudget, pendingImageCount } from './image-limit.js'

export {
  imageLimitFromFailure,
  retainedImageCount,
  pendingImageCount,
  oldestImageTargets,
  offloadImagesToBudget,
  offloadImagesForFailure,
} from './image-limit.js'

export const name = 'tokenshare-limiter'

const API_PREFIX = '/dsh-tokenshare-limiter/api'

/** 滑块值的落点：~/.dsh/settings/tokenshare-limiter.json */
const SETTINGS_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'settings', 'tokenshare-limiter.json')
const COOLDOWN_DIR = join(dirname(SETTINGS_FILE), 'tokenshare-limiter-cooldowns')

/** 这些 HTTP 状态视为「上游临时不可用」，值得等一会儿重放。 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529])
/** 没有 status 时退回失败码判断。 */
const RETRYABLE_CODES = new Set([
  'SERVER',
  'RATE_LIMIT',
  'RATE_LIMITED',
  'OVERLOADED',
  'TRANSPORT',
  'TIMEOUT',
  'EMPTY_RESPONSE',
  'UPSTREAM_ERROR',
  'PROVIDER_ERROR',
])

/**
 * 本插件不声明 schemastery `Config`：本地目录安装时 Node 从包所在目录向上解析，
 * 拿不到 profile 里的 @deepseek-ai/schemastery。所有字段都在下面读的时候做默认值与
 * 范围兜底，用户 patch 里写了什么、写错什么都不会让插件崩掉。
 *
 * 字段（对应 cordis.patch.yml 里 tokenshare-limiter 这一行的 config）：
 *   enabled           总开关，默认 true
 *   providers         管控的 provider 路由，逗号分隔，默认 tokenshare
 *   perMinute         每窗口最多放行次数，默认 14，范围 1..60
 *   retryWaitMinutes  上游异常后等待分钟数，默认 5，范围 1..60
 *   windowSeconds     窗口长度，默认 60，范围 10..600
 *   maxRetries        同请求连续重放上限，默认 6，范围 0..100（6 次 ≈ 半小时，之后把错误交回上层）
 *   maxImages         单 prompt 图片预算，默认 4，范围 1..50；超出先转存最旧图片
 */
/** 读滑块存档；文件不存在或坏掉都按「没存过」处理，回落到插件配置。 */
function loadSaved() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 原子写：先写临时文件再改名，避免半截 JSON 把下次启动弄坏。 */
function saveSaved(data) {
  const dir = dirname(SETTINGS_FILE)
  mkdirSync(dir, { recursive: true })
  const temp = SETTINGS_FILE + '.' + process.pid + '.tmp'
  writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(temp, SETTINGS_FILE)
}

const isRef = (value) => value !== null && typeof value === 'object' && typeof value.get === 'function'
const readRaw = (value, fallback) => {
  const raw = isRef(value) ? value.get() : value
  return raw === undefined || raw === null ? fallback : raw
}
const readNumber = (value, fallback, min, max) => {
  const n = Number(readRaw(value, fallback))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
const readBool = (value, fallback) => {
  const raw = readRaw(value, fallback)
  return typeof raw === 'boolean' ? raw : fallback
}

function abortError(signal) {
  const reason = signal && signal.reason
  if (reason instanceof Error) return reason
  const error = new Error('request aborted')
  error.name = 'AbortError'
  return error
}

/** 可取消等待：signal 一响立刻醒来，不用等满整段。 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError(signal))
      return
    }
    const listenable = signal && typeof signal.addEventListener === 'function'
    let timer = null
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer)
      reject(abortError(signal))
    }
    timer = setTimeout(() => {
      if (listenable) signal.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    if (listenable) signal.addEventListener('abort', onAbort, { once: true })
  })
}

function failureText(failure) {
  if (!failure || typeof failure !== 'object') return '未知失败'
  const status = typeof failure.status === 'number' ? `HTTP ${failure.status}` : ''
  const code = typeof failure.code === 'string' ? failure.code : ''
  const head = [status, code].filter(Boolean).join(' ')
  const message = typeof failure.message === 'string' ? failure.message : ''
  const short = message.length > 120 ? message.slice(0, 117) + '...' : message
  return [head, short].filter(Boolean).join(' · ') || '未知失败'
}

function isRetryableFailure(failure) {
  if (!failure || typeof failure !== 'object') return false
  if (typeof failure.status === 'number' && RETRYABLE_STATUS.has(failure.status)) return true
  const code = typeof failure.code === 'string' ? failure.code.toUpperCase() : ''
  return RETRYABLE_CODES.has(code)
}

/** 只在「还没吐出任何内容」时重放：半截正文重来会让用户看到重复段落。 */
function isTerminalErrorChunk(chunk) {
  return Boolean(
    chunk &&
    chunk.type === 'finish' &&
    chunk.reason &&
    chunk.reason.kind === 'error' &&
    chunk.reason.failure,
  )
}

// TokenShare uses Beijing time for timestamps without an explicit offset.
export function accountCooldownDeadline(failure, now, fallbackMs) {
  const message = failure.message ?? ''
  if (failure.code !== 'account_blacklisted' && !/"code"\s*:\s*"account_blacklisted"/i.test(message)) return 0
  const match = /try again after\s+(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(?:\.\d+)?)(Z|[+-]\d\d:\d\d)?/i.exec(message)
  const deadline = match ? Date.parse(match[1] + 'T' + match[2] + (match[3] ?? '+08:00')) : NaN
  const retryAfter = Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0
    ? now + Math.ceil(failure.providerRetryAfterMs) : 0
  return Math.max(deadline > now ? deadline : 0, retryAfter) || now + fallbackMs
}

export function apply(ctx, config) {
  /** 设置页保存过的值优先于插件配置，重启后从存档读回来。 */
  const saved = loadSaved()
  const override = {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : undefined,
    perMinute: Number.isFinite(saved.perMinute) ? Math.min(60, Math.max(1, Math.round(saved.perMinute))) : undefined,
    retryWaitMinutes: Number.isFinite(saved.retryWaitMinutes)
      ? Math.min(60, Math.max(1, Math.round(saved.retryWaitMinutes)))
      : undefined,
  }

  const providerList = () => {
    const raw = String(readRaw(config && config.providers, 'tokenshare') ?? '')
    const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    return list.length ? list : ['tokenshare']
  }

  const live = () => ({
    enabled: override.enabled !== undefined
      ? override.enabled
      : readBool(config && config.enabled, true),
    perMinute: override.perMinute !== undefined
      ? override.perMinute
      : readNumber(config && config.perMinute, 14, 1, 60),
    retryWaitMinutes: override.retryWaitMinutes !== undefined
      ? override.retryWaitMinutes
      : readNumber(config && config.retryWaitMinutes, 5, 1, 60),
    windowSeconds: readNumber(config && config.windowSeconds, 60, 10, 600),
    maxRetries: readNumber(config && config.maxRetries, 6, 0, 100),
    maxImages: readNumber(config && config.maxImages, 4, 1, 50),
  })

  /** 本窗口内已放行的请求时间戳（升序）。 */
  const stamps = []
  const stats = {
    total: 0,
    rateWaits: 0,
    retries: 0,
    failures: 0,
    imageRecoveries: 0,
    imagesOffloaded: 0,
    lastFailure: null,
    events: [],
  }

  const note = (text, level) => {
    stats.events.unshift({ at: Date.now(), text, level: level || 'info' })
    if (stats.events.length > 40) stats.events.length = 40
  }

  const currentProviders = providerList()
  note(`节流已就绪，管控：${currentProviders.join(', ')}`)

  const matchesProvider = provider => typeof provider === 'string'
    && currentProviders.find(target => provider.toLowerCase().includes(target))
  const cooldowns = new Map()
  const routesByKey = new Map(currentProviders.map(route => [Buffer.from(route).toString('base64url'), route]))
  const lines = new Map(currentProviders.map(route => [route, []]))
  const waits = new Set()
  const replays = new WeakSet()

  // Each upstream deadline has its own immutable marker. Different DSH hosts
  // sharing a profile cannot overwrite a longer embargo with a shorter one.
  function refreshCooldowns(now) {
    if (!existsSync(COOLDOWN_DIR)) return
    for (const file of readdirSync(COOLDOWN_DIR)) {
      const match = /^([A-Za-z0-9_-]+)\.(\d+)\.until$/.exec(file)
      const route = match && routesByKey.get(match[1])
      if (!route) continue
      const until = Number(match[2])
      if (until <= now) rmSync(join(COOLDOWN_DIR, file), { force: true })
      else if (until > (cooldowns.get(route) ?? 0)) cooldowns.set(route, until)
    }
  }

  // 在每次模型请求前为最旧图片转存，按“已准入 surface + 本批 decision”
  // 合计计数。只追加宿主原生事件，始终原样返回 decision，不在这里改图。
  ctx.on('agent/pre-step', async ({ agent, modelSelection, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal?.aborted || !live().enabled || !matchesProvider(modelSelection?.provider)) {
      return decision
    }
    try {
      const cfg = live()
      const recovered = offloadImagesToBudget(agent, cfg.maxImages, pendingImageCount(decision.messages))
      if (recovered) {
        stats.imageRecoveries += 1
        stats.imagesOffloaded += recovered.offloaded
        note(
          `图片预算 ${recovered.maxImages} 张：发送前转存最旧 ${recovered.offloaded} 张（原图保留）`,
          'info',
        )
      }
    } catch (error) {
      // 转存失败不替换消息或拦截对话；明确的上游图片错误仍可由下层兜底。
      note(`发送前图片转存失败：${String(error && error.message || error)}`, 'error')
    }
    return decision
  }, { prepend: true })

  // 未声明精确图片预算的自定义路由可能先把请求发给上游。将明确的
  // “one prompt 最多 N 张”400 接入宿主持久化转存，再让原步骤重试。
  // prepend 让本插件先处理非标准的 INVALID_REQUEST；标准
  // IMAGE_OFFLOAD_REQUIRED 仍由宿主自带监听器接管。
  ctx.on('agent/request-error', async ({ agent, provider, failure, signal }, next) => {
    if (signal?.aborted || !live().enabled || !matchesProvider(provider)) return next()
    try {
      const recovered = offloadImagesForFailure(agent, failure)
      if (!recovered) return next()
      stats.imageRecoveries += 1
      stats.imagesOffloaded += recovered.offloaded
      note(
        `图片上限 ${recovered.maxImages} 张：已转存最旧 ${recovered.offloaded} 张并重试（原图保留）`,
        'warn',
      )
      return { kind: 'retry' }
    } catch (error) {
      note(`图片转存恢复失败，交回原错误：${String(error && error.message || error)}`, 'error')
      return next()
    }
  }, { prepend: true })
  note('已监听 agent/request-error（图片上限恢复）')

  function observeAccountFailure(route, failure) {
    const deadline = accountCooldownDeadline(failure, Date.now(), live().retryWaitMinutes * 60000)
    if (deadline > (cooldowns.get(route) ?? 0)) {
      cooldowns.set(route, deadline)
      try {
        mkdirSync(COOLDOWN_DIR, { recursive: true, mode: 0o700 })
        const key = Buffer.from(route).toString('base64url')
        writeFileSync(join(COOLDOWN_DIR, key + '.' + deadline + '.until'), '', { mode: 0o600 })
      } catch (error) { note(`账号等待已生效，保存解限时间失败：${error.message}`, 'error') }
      note(`${route} 账号限流，所有相关会话等待至 ${new Date(deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）`, 'warn')
    }
    return deadline
  }

  async function wait(kind, until, signal) {
    const entry = { kind, until }
    waits.add(entry)
    try {
      // Node timers wrap above 2^31 - 1 ms. Recheck long account bans in slices.
      await delay(Math.min(until - Date.now(), 2 ** 31 - 1), signal)
    } finally {
      waits.delete(entry)
    }
  }

  async function* limitedStream(runtime, options, next, route) {
    const { signal } = options
    const { maxRetries } = live()
    for (let attempt = 0; ; attempt++) {
      const line = lines.get(route)
      let wake
      const turn = new Promise(resolve => { wake = resolve })
      line.push(wake)
      try {
        if (line.length > 1 && !signal?.aborted) {
          signal?.addEventListener('abort', wake, { once: true })
          try { await turn } finally { signal?.removeEventListener('abort', wake) }
        }
        // Each wake-up checks both gates again. Admission and starting the stream
        // have no intervening await, so simultaneous waiters cannot overbook.
        for (;;) {
          if (signal?.aborted) throw abortError(signal)
          const now = Date.now()
          refreshCooldowns(now)
          const until = cooldowns.get(route) ?? 0
          if (until > now) {
            await wait('account', until, signal)
            continue
          }
          const cfg = live()
          const windowMs = cfg.windowSeconds * 1000
          while (stamps.length && now - stamps[0] >= windowMs) stamps.shift()
          if (stamps.length < cfg.perMinute) {
            stamps.push(now)
            stats.total++
            break
          }
          const opens = stamps[0] + windowMs + 250
          stats.rateWaits++
          note(`达到每分钟 ${cfg.perMinute} 次上限，排队等待 ${((opens - now) / 1000).toFixed(1)} 秒`, 'warn')
          await wait('rate', opens, signal)
        }
      } finally {
        const index = line.indexOf(wake)
        line.splice(index, 1)
        if (index === 0) line[0]?.()
      }

      let produced = false
      let zeroUsage
      let failureChunk
      let deadline = 0
      let thrown
      try {
        let upstream
        if (attempt === 0) upstream = next()
        else {
          // Cordis next() and prepared calls are one-shot. Start a fresh native
          // stream in the same runtime. The outer loop already holds its permit.
          const request = { ...options }
          replays.add(request)
          upstream = runtime.stream(request)
        }
        for await (const chunk of upstream) {
          if (isTerminalErrorChunk(chunk)) {
            failureChunk = chunk
            deadline = observeAccountFailure(route, chunk.reason.failure)
            break
          }
          if (!produced && chunk.type === 'usage' && Object.values(chunk.usage).every(n => n === 0)) {
            zeroUsage = chunk
            continue
          }
          if (zeroUsage) { yield zeroUsage; zeroUsage = undefined }
          produced = true
          yield chunk
        }
      } catch (error) {
        thrown = error
        if (!deadline) deadline = observeAccountFailure(route, error?.failure ?? error ?? {})
      }

      if (!failureChunk && !thrown) {
        if (zeroUsage) yield zeroUsage
        return
      }
      const failure = failureChunk?.reason.failure ?? thrown.failure ?? thrown
      const now = Date.now()
      const cfg = live()
      const retryDelay = cfg.retryWaitMinutes * 60000
      stats.failures++
      stats.lastFailure = { at: now, text: failureText(failure) }
      if (produced || attempt >= maxRetries || !(deadline || isRetryableFailure(failure)) || signal?.aborted) {
        note(`请求失败：${failureText(failure)}${produced ? '（已输出，不再重放）' : ''}`, 'error')
        if (zeroUsage) yield zeroUsage
        if (thrown) throw thrown
        yield failureChunk
        return
      }
      stats.retries++
      if (deadline) continue
      note(`第 ${attempt + 1} 次重放：${failureText(failure)}，等待 ${cfg.retryWaitMinutes} 分钟`, 'warn')
      await wait('retry', now + retryDelay, signal)
    }
  }

  ctx.on('llm/stream', function (options, next) {
    if (replays.delete(options)) return next()
    const route = matchesProvider(options.provider)
    if (!route || !live().enabled) return next()
    return limitedStream(this, options, next, route)
  })
  note('已监听 llm/stream')

  const snapshot = () => {
    const cfg = live()
    const windowMs = cfg.windowSeconds * 1000
    const now = Date.now()
    refreshCooldowns(now)
    while (stamps.length && now - stamps[0] >= windowMs) stamps.shift()
    const active = [...cooldowns].filter(([, until]) => until > now).sort((a, b) => a[1] - b[1])
    const first = active.length
      ? { kind: 'account', route: active[0][0], until: active[0][1] }
      : [...waits].filter(entry => entry.until > now).sort((a, b) => a.until - b.until)[0]
    const waiting = first ? { ...first, remainingMs: first.until - now } : null
    return {
      ok: true,
      settings: {
        enabled: cfg.enabled,
        perMinute: cfg.perMinute,
        retryWaitMinutes: cfg.retryWaitMinutes,
        windowSeconds: cfg.windowSeconds,
        maxRetries: cfg.maxRetries,
        maxImages: cfg.maxImages,
        providers: currentProviders,
      },
      window: { used: stamps.length, limit: cfg.perMinute, windowSeconds: cfg.windowSeconds },
      waiting,
      queued: [...lines.values()].reduce((count, line) => count + line.length, 0),
      stats: {
        total: stats.total,
        rateWaits: stats.rateWaits,
        retries: stats.retries,
        failures: stats.failures,
        imageRecoveries: stats.imageRecoveries,
        imagesOffloaded: stats.imagesOffloaded,
        lastFailure: stats.lastFailure,
      },
      recent: stats.events.slice(0, 12),
    }
  }

  // ---- 设置页 API ----
  const applyPatch = async (patch) => {
    const next = {}
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled)
    if (patch.perMinute !== undefined) next.perMinute = readNumber(patch.perMinute, 14, 1, 60)
    if (patch.retryWaitMinutes !== undefined) next.retryWaitMinutes = readNumber(patch.retryWaitMinutes, 5, 1, 60)
    saveSaved({ ...loadSaved(), ...next })
    if (next.enabled !== undefined) override.enabled = next.enabled
    if (next.perMinute !== undefined) override.perMinute = next.perMinute
    if (next.retryWaitMinutes !== undefined) override.retryWaitMinutes = next.retryWaitMinutes
    const cfg = live()
    note(`设置已更新：每分钟 ${cfg.perMinute} 次，异常等待 ${cfg.retryWaitMinutes} 分钟${cfg.enabled ? '' : '（已暂停）'}`)
    return snapshot()
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })

  const reply = (res, status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  /** 只接受本机回环来源，挡住 DNS rebinding 拿不到鉴权的伪来源。 */
  const denyNonLoopback = (req) => {
    const raw = String(req.headers.host || '')
    const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]
    const name = host.toLowerCase()
    return !(name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1' || name === '0.0.0.0')
  }

  const registerApi = (scope) => {
    const webServer = (scope && (scope.webServer || scope.get('webServer'))) || ctx.get('webServer')
    if (!webServer) return
    scope.effect(() => webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      async handler(req, res) {
        if (denyNonLoopback(req)) {
          reply(res, 403, { ok: false, error: '只接受本机请求' })
          return
        }
        const path = String(req.url || '').split('?')[0].slice(API_PREFIX.length) || '/'
        try {
          if (req.method === 'GET' && (path === '/state' || path === '/')) {
            reply(res, 200, snapshot())
            return
          }
          if (req.method === 'POST' && path === '/config') {
            const body = await readBody(req)
            reply(res, 200, await applyPatch(body || {}))
            return
          }
          if (req.method === 'POST' && path === '/reset') {
            stamps.length = 0
            note('手动清空当前窗口计数')
            reply(res, 200, snapshot())
            return
          }
          reply(res, 404, { ok: false, error: '未知接口' })
        } catch (error) {
          reply(res, 400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }))
  }

  // webServer 可能比本插件晚就绪，用动态注入等它；没有 Web 载体时插件其余部分照常工作。
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerApi)
    else if (ctx.get('webServer')) registerApi(ctx)
  } catch (error) {
    note(`设置页接口未注册：${String(error && error.message || error)}`, 'warn')
  }
}
