import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import {
  imageLimitFromFailure,
  retainedImageCount,
  pendingImageCount,
  oldestImageTargets,
  offloadImagesForFailure,
} from '../image-limit.js'

const FAILURE = {
  status: 400,
  code: 'INVALID_REQUEST',
  message: 'At most 4 image(s) may be provided in one prompt. (parameter=image)',
}

const image = (id, offloaded = false) => ({
  type: 'image',
  attachment: { attachmentId: `sha256:${id}` },
  ...offloaded ? { offloaded: true } : {},
})
const text = (value) => ({ type: 'text', text: value })

function sessionFixture(events) {
  const bySeq = new Map(events.map((event, index) => [index + 1, event]))
  const appended = []
  const session = {
    surface: { nodes: [...bySeq.keys()] },
    appended,
    eventAt(seq) { return bySeq.get(seq) },
    deriveEventMessage(event) {
      return event.type === 'user/message' ? event.data : event.data.message
    },
    append(type, data) {
      appended.push({ type, data })
      // 模拟宿主 image/offload 投影：下一次请求不再发送这些图片。
      for (const target of data.targets) {
        const event = bySeq.get(target.seq)
        const message = this.deriveEventMessage(event)
        for (const index of target.imageIndexes) message.content[index].offloaded = true
      }
    },
  }
  return session
}

function fiveImageSession({ includeMemory = true } = {}) {
  return sessionFixture([
    { type: 'user/message', data: { content: [image('one'), text('first')] } },
    { type: 'assistant/message', data: { message: { content: [image('assistant-output-must-not-count')] } } },
    { type: 'tool/result', data: { message: { content: [image('two'), image('three')] } } },
    ...includeMemory
      ? [{ type: 'user/message', data: { source: { kind: 'plugin:memsearch' }, content: [text('[memsearch] memory-recall')] } }]
      : [],
    { type: 'tool/result', data: { message: { content: [image('four'), image('five')] } } },
  ])
}

test('只识别明确的单 prompt 图片数量上限错误', () => {
  assert.equal(imageLimitFromFailure(FAILURE), 4)
  assert.equal(imageLimitFromFailure({ ...FAILURE, message: 'At most 7 images may be provided in one prompt' }), 7)
  assert.equal(imageLimitFromFailure({ status: 400 }), null)
  assert.equal(imageLimitFromFailure({ code: 'INVALID_REQUEST', message: FAILURE.message }), 4)
  assert.equal(imageLimitFromFailure({ ...FAILURE, status: 429 }), null)
  assert.equal(imageLimitFromFailure({ ...FAILURE, message: 'INVALID_REQUEST: some other problem' }), null)
  assert.equal(imageLimitFromFailure(null), null)
})

test('5 张输入图片 + 记忆纯文本：只转存最旧 1 张，记忆消息不参与计数', () => {
  const session = fiveImageSession()
  assert.equal(retainedImageCount(session), 5)
  const result = offloadImagesForFailure({ session }, FAILURE)
  assert.equal(result.maxImages, 4)
  assert.equal(result.retained, 5)
  assert.equal(result.offloaded, 1)
  const memorySeq = 4
  assert.deepEqual(session.appended, [{
    type: 'image/offload',
    data: { targets: [{ seq: 1, imageIndexes: [0] }] },
  }])
  assert.ok(!session.appended[0].data.targets.some(target => target.seq === memorySeq))
  assert.equal(retainedImageCount(session), 4)
  assert.equal(offloadImagesForFailure({ session }, FAILURE), null, '重试时已合规，不得重复转存或无限重试')
})

test('已转存图片不占发送名额，但原始图片下标保持稳定', () => {
  const session = sessionFixture([
    { type: 'user/message', data: { content: [image('old-offloaded', true), image('oldest-retained')] } },
    { type: 'tool/result', data: { message: { content: [image('three'), image('four'), image('five'), image('six')] } } },
  ])
  assert.equal(retainedImageCount(session), 5)
  assert.deepEqual(oldestImageTargets(session, 1), [{ seq: 1, imageIndexes: [1] }])
})

test('未超过上限、没有图片或异常事件不会生成转存记录', () => {
  const session = fiveImageSession()
  // 前三张标记为已转存，留下两张。
  for (const seq of [1, 3]) {
    const event = session.eventAt(seq)
    for (const block of session.deriveEventMessage(event).content) {
      if (block.type === 'image') block.offloaded = true
    }
  }
  const retained = retainedImageCount(session)
  assert.equal(retained, 2)
  assert.equal(offloadImagesForFailure({ session }, FAILURE), null)
  assert.equal(session.appended.length, 0)

  const malformed = {
    surface: { nodes: [1] },
    eventAt() { throw new Error('gone') },
    deriveEventMessage() { throw new Error('gone') },
  }
  assert.equal(retainedImageCount(malformed), 0)
  assert.deepEqual(oldestImageTargets(malformed, 1), [])
})

test('生产监听器：发送前留出新图名额，必要时在 400 后转存重试，其它情况继续 next', async () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(`${os.tmpdir()}/tokenshare-test-home-`)
  try {
    const { apply } = await import('../index.js')
    const listeners = {}
    const ctx = {
      on(name, listener) { listeners[name] = listener; return () => {} },
      inject() {},
      get() { return undefined },
    }
    apply(ctx, { enabled: true, providers: 'tokenshare' })
    const recover = listeners['agent/request-error']
    assert.equal(typeof recover, 'function')

    const session = fiveImageSession()
    const result = await recover(
      { agent: { session }, provider: 'tokenshare', failure: FAILURE, signal: { aborted: false } },
      async () => 'delegated',
    )
    assert.deepEqual(result, { kind: 'retry' })
    assert.equal(session.appended.length, 1)

    assert.equal(await recover(
      { agent: { session }, provider: 'tokenshare', failure: FAILURE, signal: { aborted: false } },
      async () => 'delegated',
    ), 'delegated')

    // 此时历史仍有 4 张。下批新消息带来第 5 张，应在调用模型之前
    // 再转存最旧的 retained 图片，并原样返回整个 decision（含纯文本记忆提示）。
    const admitted = {
      kind: 'enter',
      metadata: { preserved: true },
      messages: [
        { role: 'user', content: [image('new-sixth-occurrence')] },
        { role: 'user', source: { kind: 'plugin:memsearch' }, content: [text('memory-only')] },
      ],
    }
    assert.equal(pendingImageCount(admitted.messages), 1)
    const preStepResult = await listeners['agent/pre-step'](
      {
        agent: { session },
        modelSelection: { provider: 'tokenshare', model: 'test-model' },
        signal: { aborted: false },
      },
      async () => admitted,
    )
    assert.equal(preStepResult, admitted)
    assert.equal(session.appended.length, 2)
    assert.deepEqual(session.appended[1].data.targets, [{ seq: 3, imageIndexes: [0] }])
    assert.equal(retainedImageCount(session) + pendingImageCount(admitted.messages), 4)

    const otherProvider = fiveImageSession()
    assert.equal(await recover(
      { agent: { session: otherProvider }, provider: 'openai', failure: FAILURE, signal: { aborted: false } },
      async () => 'delegated',
    ), 'delegated')
    assert.equal(otherProvider.appended.length, 0)

    const otherFailure = fiveImageSession()
    assert.equal(await recover(
      { agent: { session: otherFailure }, provider: 'tokenshare', failure: { ...FAILURE, message: 'bad request' }, signal: { aborted: false } },
      async () => 'delegated',
    ), 'delegated')
    assert.equal(otherFailure.appended.length, 0)

    const aborted = fiveImageSession()
    assert.equal(await recover(
      { agent: { session: aborted }, provider: 'tokenshare', failure: FAILURE, signal: { aborted: true } },
      async () => 'delegated',
    ), 'delegated')
    assert.equal(aborted.appended.length, 0)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})
