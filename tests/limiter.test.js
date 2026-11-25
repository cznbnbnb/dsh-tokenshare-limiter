import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { accountCooldownDeadline } from '../index.js'

const start = Date.parse('2026-11-25T12:20:00+08:00')
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
  t.after(() => rmSync(dir, { recursive: true, force: true }))
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
    plugin.apply({ on: (name, handler) => hooks.set(name, handler), inject: (_, fn) => fn(scope) }, config)
    return {
      run: (sessionId, signal, provider = 'tokenshare') => Array.fromAsync(runtime.stream({ provider, sessionId, signal })),
      state: () => request('state'),
      configure: patch => request('config', patch),
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
  assert.equal(accountCooldownDeadline({ code: 'RATE_LIMIT', message: '429' }, start, 300000), 0)
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
  for (const result of await Promise.all([a, b])) assert.deepEqual(result, [content, zero, success])
  assert.deepEqual(f.calls.slice(2), [{ name: 'A', at: start + 64000 }, { name: 'B', at: start + 64000 }])
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
  await f.tick(64000)
  assert.equal(f.calls.length, 2)
  await f.tick(55999)
  assert.equal(f.calls.length, 2)
  await f.tick(1)
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
