import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { accountCooldownDeadline } from '../index.js'

const start = Date.parse('2026-11-25T12:20:00+08:00')
const spacing = Math.ceil(60_000 / 14)
const zero = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
const success = { type: 'finish', reason: { kind: 'stop' } }
const content = { type: 'text-delta', index: 0, text: 'test' }
const blacklist = (time = '12:21:04') => ({
  type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429: ' + JSON.stringify({
    code: 'account_blacklisted', message: 'Too many requests. Please try again after 2026-11-25 ' + time + '.',
  }) } },
})

async function fixture(t, adapter, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'limiter-test-'))
  const disposers = []
  t.after(() => {
    for (const dispose of disposers) dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const previous = process.env.DSH_HOME
  let plugin
  try {
    process.env.DSH_HOME = dir
    plugin = await import('../index.js?' + encodeURIComponent(dir))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start })
  const calls = []
  function mount() {
    const hooks = new Map()
    let handler
    let dispose
    const scope = { effect: fn => fn(), webServer: { register: api => { handler = api.handler } } }
    const runtime = {
      stream(options) {
        let used = false
        return hooks.get('llm/stream').call(runtime, options, () => {
          assert.equal(used, false, 'Cordis permits one next() per dispatch')
          used = true
          calls.push({ name: options.sessionId, at: Date.now() })
          return adapter(options)
        })
      },
    }
    plugin.apply({ on: (name, handler) => hooks.set(name, handler), inject: (_, fn) => fn(scope), effect: fn => { dispose = fn() } }, config)
    disposers.push(dispose)
    return {
      run: (sessionId, signal, provider = 'tokenshare') => Array.fromAsync(runtime.stream({ provider, sessionId, signal })),
      state: () => request('state'),
      configure: patch => request('config', patch),
      reset: () => request('reset', {}),
      dispose,
    }

    async function request(path, patch) {
      const req = Readable.from(patch ? [Buffer.from(JSON.stringify(patch))] : [])
      Object.assign(req, { method: patch ? 'POST' : 'GET', headers: { host: 'localhost' }, url: '/dsh-tokenshare-limiter/api/' + path })
      let result
      await handler(req, { writeHead() {}, end(body) { result = JSON.parse(body) } })
      return result
    }
  }
  return { ...mount(), mount, calls, dir, async tick(ms) { t.mock.timers.tick(ms); await settle() } }
}

test('账户限制按服务端时区解析，显式时区和 Retry-After 同时生效', () => {
  const failure = blacklist().reason.failure
  assert.equal(accountCooldownDeadline(failure, start, 300000), start + 64000)
  const utc = { ...failure, message: failure.message.replace('2026-11-25 12:21:04', '2026-11-25T04:21:04Z') }
  assert.equal(accountCooldownDeadline(utc, start, 300000), start + 64000)
  assert.equal(accountCooldownDeadline({ ...failure, providerRetryAfterMs: 90000 }, start, 300000), start + 90000)
  assert.equal(accountCooldownDeadline({ code: 'account_blacklisted', message: '' }, start, 300000), start + 300000)
  assert.equal(accountCooldownDeadline({ code: 'RATE_LIMIT', message: '429' }, start, 300000), start + 300000)
  assert.equal(accountCooldownDeadline({ status: 429, providerRetryAfterMs: 90000 }, start, 300000), start + 90000)
  assert.equal(accountCooldownDeadline({ status: 503, message: '503: upstream mentioned 429' }, start, 300000), 0)
})

test('零用量失败只重放一次，不向宿主重复输出用量；原请求及同线路会话共用截止时刻', async t => {
  let first = true
  const f = await fixture(t, async function* () {
    if (first) { first = false; yield zero; yield blacklist(); return }
    yield content; yield zero; yield success
  })
  const a = f.run('A')
  await settle()
  const b = f.run('B', undefined, 'tokenshare-secondary')
  const c = f.run('C', undefined, 'different-provider')
  await c
  assert.deepEqual(f.calls.map(x => x.name), ['A', 'C'])
  assert.equal((await f.state()).queued, 2)
  assert.equal((await f.state()).waiting.until, start + 64000)
  await f.tick(63999)
  assert.equal(f.calls.length, 2)
  await f.tick(1)
  assert.deepEqual(f.calls.slice(2), [{ name: 'A', at: start + 64000 }])
  await f.tick(spacing)
  for (const result of await Promise.all([a, b])) assert.deepEqual(result, [content, zero, success])
  assert.deepEqual(f.calls.slice(2), [{ name: 'A', at: start + 64000 }, { name: 'B', at: start + 64000 + spacing }])
  assert.equal((await f.state()).stats.retries, 1)
})

test('并发返回更晚的期限后继续等待，取消排队请求，热加载仍能恢复截止时间', async t => {
  const inflight = Promise.withResolvers()
  let opened = 0
  const f = await fixture(t, async function* () {
    if (++opened === 1) { await inflight.promise; yield content; yield blacklist('12:22:00'); return }
    if (opened === 2) { yield zero; yield blacklist(); return }
    yield success
  })
  const partial = f.run('partial')
  const retry = f.run('retry')
  await settle()
  await f.tick(spacing)
  const abort = new AbortController()
  const cancelled = assert.rejects(f.run('cancel', abort.signal), { name: 'AbortError' })
  const pending = f.run('pending')
  await settle()
  abort.abort()
  await cancelled
  assert.equal((await f.state()).queued, 2)
  inflight.resolve()
  assert.deepEqual(await partial, [content, blacklist('12:22:00')])
  const remounted = f.mount()
  assert.equal((await remounted.state()).waiting.until, start + 120000)
  await f.tick(64000 - spacing)
  assert.equal(f.calls.length, 2)
  await f.tick(55999)
  assert.equal(f.calls.length, 2)
  await f.tick(1)
  await f.tick(spacing)
  await Promise.all([retry, pending])
  assert.deepEqual(f.calls.map(x => x.name), ['partial', 'retry', 'retry', 'pending'])
})

test('通用错误按固定时长重试；额度用尽后原样返回零用量和失败', async t => {
  const err = { type: 'finish', reason: { kind: 'error', failure: { status: 503, code: 'SERVER', message: '503' } } }
  const f = await fixture(t, async function* () { yield zero; yield err }, { retryWaitMinutes: 1, maxRetries: 1 })
  const result = f.run('generic')
  await settle()
  assert.equal((await f.state()).waiting.kind, 'retry')
  await f.tick(59999)
  assert.equal(f.calls.length, 1)
  await f.tick(1)
  assert.deepEqual(await result, [zero, err])
  assert.equal(f.calls.length, 2)
})

test('解限后继续遵守滑动窗口，新请求排在已有请求之后；取消队首释放下一位', async t => {
  let first = true
  const f = await fixture(t, async function* () {
    if (first) { first = false; yield zero; yield blacklist(); return }
    yield success
  }, { perMinute: 1, windowSeconds: 10 })
  const abort = new AbortController()
  const firstResult = assert.rejects(f.run('first', abort.signal), { name: 'AbortError' })
  await settle()
  const second = f.run('second')
  const third = f.run('third')
  abort.abort()
  await firstResult
  await f.tick(64000)
  await second
  const last = f.run('last')
  await f.tick(10250)
  await third
  await f.tick(10250)
  await last
  assert.deepEqual(f.calls.map(x => x.name), ['first', 'second', 'third', 'last'])
  assert.ok(f.calls[2].at - f.calls[1].at >= 10000)
})

test('同一 Harness 数据目录中已在运行的另一宿主也遵守新的账号期限', async t => {
  let reject = true
  const f = await fixture(t, async function* () {
    if (reject) { reject = false; yield blacklist(); return }
    yield success
  }, { maxRetries: 0 })
  const other = f.mount()
  await f.run('original')
  const pending = other.run('second-host')
  await settle()
  assert.deepEqual(f.calls.map(x => x.name), ['original'])
  await f.tick(64000)
  assert.deepEqual(await pending, [success])
})

test('429 已返回但原始流仍在关闭时，其它会话立即进入等待', async t => {
  const cleanup = Promise.withResolvers()
  let first = true
  const f = await fixture(t, async function* () {
    if (first) {
      first = false
      try { yield blacklist() } finally { await cleanup.promise }
      return
    }
    yield success
  }, { maxRetries: 0 })
  const original = f.run('original')
  await settle()
  const pending = f.run('pending')
  await settle()
  assert.deepEqual(f.calls.map(x => x.name), ['original'])
  cleanup.resolve()
  await original
  await f.tick(64000)
  assert.deepEqual(await pending, [success])
})

test('写盘失败时保留生效中的限流设置，重试成功后才更改', async t => {
  const f = await fixture(t, async function* () { yield success })
  const settingsDir = join(f.dir, 'settings')
  writeFileSync(settingsDir, '阻止创建设置目录')
  assert.equal((await f.configure({ enabled: false })).ok, false)
  assert.equal((await f.state()).settings.enabled, true)
  rmSync(settingsDir)
  const saved = await f.configure({ enabled: false })
  assert.equal(saved.ok, true)
  assert.equal(saved.settings.enabled, false)
  assert.equal(JSON.parse(readFileSync(join(settingsDir, 'tokenshare-limiter.json'), 'utf8')).enabled, false)
})

test('同时提交、跨实例和重新加载时共享额度，任意连续 60 秒最多 14 次', async t => {
  const f = await fixture(t, async function* () { yield success })
  await f.run('before-reload')
  f.dispose()
  const first = f.mount()
  const second = f.mount()
  const pending = Array.from({ length: 28 }, (_, i) => (i % 2 ? first : second).run('queued-' + i))
  await settle()
  assert.equal(f.calls.length, 1)
  assert.equal((await second.state()).window.used, 1)
  assert.equal((await first.reset()).ok, false)
  for (let i = 1; i <= pending.length; i++) {
    await f.tick(spacing - 1)
    assert.equal(f.calls.length, i)
    await f.tick(1)
    assert.equal(f.calls.length, i + 1)
  }
  await Promise.all(pending)
  for (const { at } of f.calls) {
    assert.ok(f.calls.filter(call => call.at > at - 60000 && call.at <= at).length <= 14)
  }
})

test('普通 429 暂停同线路全部会话，跨实例和切换开关也保留 Retry-After', async t => {
  const limited = { type: 'finish', reason: { kind: 'error', failure: { status: 429, message: 'Too many requests', providerRetryAfterMs: 90000 } } }
  const f = await fixture(t, async function* (options) { yield options.sessionId === 'original' ? limited : success }, { maxRetries: 0 })
  const other = f.mount()
  await f.run('original')
  assert.equal((await other.state()).waiting.until, start + 90000)
  await f.configure({ enabled: false })
  const pending = other.run('subagent')
  await other.run('unrelated', undefined, 'different-provider')
  await f.tick(89999)
  assert.deepEqual(f.calls.map(v => v.name), ['original', 'unrelated'])
  await f.tick(1)
  assert.deepEqual(await pending, [success])
})

test('运行中降低上限，另一实例使用新上限并保留窗口内的旧请求', async t => {
  const f = await fixture(t, async function* () { yield success }, { perMinute: 6, windowSeconds: 12 })
  const other = f.mount()
  for (let i = 0; i < 4; i++) {
    if (i) await f.tick(2000)
    await f.run('old-' + i)
  }
  await f.configure({ perMinute: 2 })
  assert.equal((await other.state()).settings.perMinute, 2)
  const next = other.run('after-change')
  await f.tick(9999)
  assert.equal(f.calls.length, 4)
  await f.tick(1)
  await next
  assert.equal(f.calls[4].at, start + 16000)
})

test('慢请求晚到达上游时，另一宿主不能提前用掉它的下一窗口名额', async t => {
  const ready = Promise.withResolvers()
  const arrivals = []
  const f = await fixture(t, async function* ({ sessionId }) {
    if (sessionId === 'slow') await ready.promise
    arrivals.push(Date.now())
    yield success
  }, { perMinute: 2, windowSeconds: 10 })
  const other = f.mount()
  const slow = f.run('slow')
  await f.tick(5000)
  await other.run('fast')
  ready.resolve()
  await slow
  const third = other.run('next')
  await f.tick(5000)
  assert.deepEqual(arrivals, [start + 5000, start + 5000])
  await f.tick(4999)
  assert.equal(arrivals.length, 2)
  await f.tick(1)
  await third
  assert.equal(arrivals[2], start + 15000)
})

test('持有名额的宿主意外退出，其他宿主保守等满一窗后能继续', async t => {
  const f = await fixture(t, async function* () { yield success }, { perMinute: 1, windowSeconds: 10 })
  await f.run('ready')
  const dead = spawnSync(process.execPath, ['-e', ''])
  assert.equal(dead.status, 0)
  const db = new DatabaseSync(join(f.dir, 'settings', 'tokenshare-limiter-cooldowns', 'requests.sqlite'))
  db.prepare('INSERT INTO requests(at, owner) VALUES (?, ?)').run(start - 15000, dead.pid)
  db.close()
  const pending = f.run('after-exit')
  await f.tick(9999)
  assert.equal(f.calls.length, 1)
  await f.tick(1)
  await pending
  assert.equal(f.calls[1].at, start + 10000)
})
