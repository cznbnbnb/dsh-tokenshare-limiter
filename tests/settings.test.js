import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { setImmediate as settle } from 'node:timers/promises'

test('快速修改两个滑块合并保存，后续保存依序发送', async () => {
  const posts = []
  const release = Promise.withResolvers()
  let render, timer
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value, () => {}], useRef: current => ({ current }),
    useCallback: fn => fn, useEffect() {},
  }
  const slots = {
    inject: (_, mount) => mount(),
    register(meta, fn) { if (meta.name === 'settings.section') render = fn },
  }
  const window = { __ModuleLoader__: { load: ({ factory }) => factory(() => react).apply({ get: () => slots }) } }
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window, document: { querySelectorAll: () => [] },
    setTimeout: fn => { timer = fn; return 1 }, clearTimeout: () => { timer = null },
    async fetch(_, { body }) {
      posts.push(JSON.parse(body))
      if (posts.length === 1) await release.promise
      return { json: async () => ({ ok: true }) }
    },
  })
  const panel = render().type()
  const sliders = []
  function visit(node) {
    if (node?.type?.name === 'Slider') sliders.push(node)
    node?.children?.flat().forEach(visit)
  }
  visit(panel)
  sliders[0].props.onChange(11)
  sliders[1].props.onChange(3)
  timer()
  await settle()
  sliders[0].props.onChange(12)
  timer()
  await settle()
  assert.deepEqual(posts, [{ perMinute: 11, retryWaitMinutes: 3 }])
  release.resolve()
  await settle()
  assert.deepEqual(posts[1], { perMinute: 12 })
})
