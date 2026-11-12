/**
 * dsh-tokenshare-limiter — 第三方 provider（默认 TokenShare）的请求节流与异常重试。
 *
 * 三个关注点：
 *   1. 命中 `llm/stream` 瀑布，只对配置里的 provider 路由生效；其它 provider 原样放行。
 *   2. 出口节流：滑动窗口内最多 `perMinute` 次请求，超出的请求在真正发起前排队等待，
 *      窗口滚动后才会发出去（TokenShare 超限封号，所以宁可慢也不能超）。
 *   3. 失败重放：上游 429/5xx 这类「服务端临时不可用」的失败，等 `retryWaitMinutes`
 *      分钟后重新发起一次；已经吐出内容的流不重放，避免正文重复。
 *
 * 参数在设置页用滑块调节，存在插件自己的一个小 JSON 里（见 SETTINGS_FILE）：
 * 改完立刻生效、不重启插件，也不会被插件管理器的禁用/启用抹掉。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'tokenshare-limiter'

const API_PREFIX = '/dsh-tokenshare-limiter/api'

/** 滑块值的落点：~/.dsh/settings/tokenshare-limiter.json */
const SETTINGS_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'settings', 'tokenshare-limiter.json')

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
  const temp = SETTINGS_FILE + '.tmp'
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
  })

  /** 本窗口内已放行的请求时间戳（升序）。 */
  const stamps = []
  const stats = {
    total: 0,
    rateWaits: 0,
    retries: 0,
    failures: 0,
    lastFailure: null,
    waiting: null,
    events: [],
  }

  const note = (text, level) => {
    stats.events.unshift({ at: Date.now(), text, level: level || 'info' })
    if (stats.events.length > 40) stats.events.length = 40
  }

  const currentProviders = providerList()
  note(`节流已就绪，管控：${currentProviders.join(', ')}`)

  const matchesProvider = (provider) => {
    if (typeof provider !== 'string' || !provider) return false
    const lower = provider.toLowerCase()
    return currentProviders.some((target) => lower === target || lower.includes(target))
  }

  // ---- 出口闸门：串行排队，避免并发同时放行挤爆窗口 ----
  let queue = Promise.resolve()

  const acquire = (signal) => {
    const job = async () => {
      for (;;) {
        const cfg = live()
        const windowMs = cfg.windowSeconds * 1000
        const now = Date.now()
        while (stamps.length && now - stamps[0] >= windowMs) stamps.shift()
        if (stamps.length < cfg.perMinute) {
          stamps.push(Date.now())
          stats.total += 1
          return
        }
        // 窗口满了：等到最早那笔滑出窗口，再多给 250ms 余量防止边界抖动。
        const waitMs = stamps[0] + windowMs + 250 - Date.now()
        stats.rateWaits += 1
        stats.waiting = { kind: 'rate', until: Date.now() + Math.max(waitMs, 0) }
        note(`达到每分钟 ${cfg.perMinute} 次上限，排队等待 ${(Math.max(waitMs, 0) / 1000).toFixed(1)} 秒`, 'warn')
        try {
          await delay(waitMs, signal)
        } finally {
          stats.waiting = null
        }
        if (signal && signal.aborted) throw abortError(signal)
      }
    }
    const run = queue.then(job, job)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** 上游异常后统一等这么久（可被取消信号提前叫醒）。 */
  const waitBeforeRetry = async (cfg, attemptNo, failure, signal) => {
    const waitMs = cfg.retryWaitMinutes * 60 * 1000
    stats.waiting = { kind: 'retry', until: Date.now() + waitMs }
    note(`第 ${attemptNo} 次重放：${failureText(failure)}，等待 ${cfg.retryWaitMinutes} 分钟`, 'warn')
    try {
      await delay(waitMs, signal)
    } finally {
      stats.waiting = null
    }
  }

  // ---- 单次请求：包一层，观察终止 chunk，必要时等一会儿重放 ----
  async function* limitedStream(options, next) {
    const cfgAtStart = live()
    const signal = options && options.signal
    const maxRetries = cfgAtStart.maxRetries
    let attempt = 0

    for (;;) {
      const cfg = live()
      try {
        await acquire(signal)
      } catch (error) {
        // 用户取消就照常抛；排队本身出意外则放行这一笔，不让限流器成为故障源。
        if (signal && signal.aborted) throw error
        note(`排队异常，本次直接放行：${String(error && error.message || error)}`, 'error')
      }
      let produced = false
      let failureChunk = null
      let thrown = null

      try {
        for await (const chunk of next()) {
          if (isTerminalErrorChunk(chunk)) {
            failureChunk = chunk
            break
          }
          produced = true
          yield chunk
        }
      } catch (error) {
        thrown = error
      }

      if (thrown) {
        // 迭代器直接抛错：已经输出过就不重放（正文无法回滚），否则按可重试与否决定。
        const failure = thrown && thrown.failure ? thrown.failure : { message: String(thrown && thrown.message || thrown), code: thrown && thrown.code }
        stats.failures += 1
        stats.lastFailure = { at: Date.now(), text: failureText(failure) }
        if (produced || attempt >= maxRetries || !isRetryableFailure(failure) || (signal && signal.aborted)) throw thrown
        attempt += 1
        stats.retries += 1
        await waitBeforeRetry(cfg, attempt, failure, signal)
        continue
      }

      if (!failureChunk) return

      const failure = failureChunk.reason.failure
      stats.failures += 1
      stats.lastFailure = { at: Date.now(), text: failureText(failure) }

      const canRetry = !produced &&
        attempt < maxRetries &&
        isRetryableFailure(failure) &&
        !(signal && signal.aborted)

      if (!canRetry) {
        note(`请求失败：${failureText(failure)}${produced ? '（已输出内容，不再重放）' : ''}`, 'error')
        yield failureChunk
        return
      }

      attempt += 1
      stats.retries += 1
      await waitBeforeRetry(cfg, attempt, failure, signal)
    }
  }

  // 这一层必须绝对安全：它卡在所有模型请求的路径上，
  // 所以任何自身异常都降级成「原样放行」，绝不能把用户的对话拖死。
  ctx.on('llm/stream', (options, next) => {
    try {
      const provider = options && options.provider
      if (!matchesProvider(provider)) return next()
      if (!live().enabled) return next()
      return limitedStream(options, next)
    } catch (error) {
      note(`节流器自身异常，本次直接放行：${String(error && error.message || error)}`, 'error')
      return next()
    }
  })
  note('已监听 llm/stream')

  const snapshot = () => {
    const cfg = live()
    const windowMs = cfg.windowSeconds * 1000
    const now = Date.now()
    while (stamps.length && now - stamps[0] >= windowMs) stamps.shift()
    const waiting = stats.waiting && stats.waiting.until > now
      ? { kind: stats.waiting.kind, remainingMs: stats.waiting.until - now }
      : null
    return {
      ok: true,
      settings: {
        enabled: cfg.enabled,
        perMinute: cfg.perMinute,
        retryWaitMinutes: cfg.retryWaitMinutes,
        windowSeconds: cfg.windowSeconds,
        maxRetries: cfg.maxRetries,
        providers: currentProviders,
      },
      window: { used: stamps.length, limit: cfg.perMinute, windowSeconds: cfg.windowSeconds },
      waiting,
      stats: {
        total: stats.total,
        rateWaits: stats.rateWaits,
        retries: stats.retries,
        failures: stats.failures,
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
    if (next.enabled !== undefined) override.enabled = next.enabled
    if (next.perMinute !== undefined) override.perMinute = next.perMinute
    if (next.retryWaitMinutes !== undefined) override.retryWaitMinutes = next.retryWaitMinutes
    saveSaved({ ...loadSaved(), ...next })
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
