/**
 * Client-bundle tests.
 *
 * The browser artifact is evaluated in a sandbox with a stand-in module table,
 * so the test covers what the page actually depends on: the bundle registers
 * under its own id, pulls only seed modules, exposes `apply`/`inject`, registers
 * one entry in the composer dock beside the host's own stats pill, and renders a
 * pill element tree without throwing.
 *
 * Rendering uses a minimal hook dispatcher: enough for the closed pill (which is
 * all a test can honestly observe without a browser), not a React substitute.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/** Module ids the shell seeds into every page's module table. */
const SEED_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/**
 * Evaluate the bundle in a sandbox and materialize its factory.
 * @returns {{exports: object, requires: string[], registrations: object[], logged: string[]}} the materialized module.
 */
function materialize() {
  const registrations = []
  const requires = []
  const logged = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
  }

  // A hook dispatcher with no reactivity: one render pass per `render()` call.
  const slots = []
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const index = cursor++
      if (slots[index] === undefined) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    // Effects run once per render pass, like React runs them after mount. Timers
    // are stubbed below so the polling effect cannot hold the test runner open.
    useEffect(effect) {
      effect()
    },
    useLayoutEffect(effect) {
      effect()
    },
    useCallback(fn) {
      return fn
    },
    useRef(initial) {
      const index = cursor++
      if (slots[index] === undefined) slots[index] = { current: initial }
      return slots[index]
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
    memo(fn) {
      return fn
    },
  }
  const ReactDOM = {
    createPortal(child, container) {
      return { type: 'portal', props: { container }, children: [child] }
    },
  }

  const moduleTable = {
    react: React,
    'react-dom': ReactDOM,
  }
  const require = (id) => {
    requires.push(id)
    if (!(id in moduleTable)) throw new Error(`unexpected require(${JSON.stringify(id)}) — not a seed module`)
    return moduleTable[id]
  }

  const collect = (level) => (...values) => {
    logged.push(`${level}: ${values.map(value => String(value)).join(' ')}`)
  }
  const evaluate = new Function(
    'window', 'document', 'console', 'fetch', 'navigator',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    SOURCE,
  )
  evaluate(
    fakeWindow,
    {
      body: {},
      head: { appendChild() {} },
      hidden: false,
      createElement: () => ({ dataset: {}, remove() {} }),
      addEventListener() {},
      removeEventListener() {},
    },
    { log: collect('log'), warn: collect('warn'), error: collect('error') },
    () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }),
    { language: 'zh-CN' },
    () => 1,
    () => {},
    () => 1,
    () => {},
  )
  assert.equal(registrations.length, 1, 'the bundle registers exactly one factory')
  const registration = registrations[0]
  const exported = registration.factory(require)
  return {
    exports: exported,
    requires,
    registrations,
    logged,
    /** Re-run the render pass, so hook state advances like a second render. */
    render(element) {
      cursor = 0
      return renderElement(element)
    },
  }
}

/**
 * Resolve function components and arrays down to host elements, one level deep
 * per call — enough for the pill, which is a plain tree of host elements.
 * @param {object|object[]|string|null} element - the element to resolve.
 * @returns {object|object[]|string|null} the resolved tree.
 */
function renderElement(element) {
  if (Array.isArray(element)) return element.map(renderElement)
  if (element === null || element === undefined || typeof element !== 'object') return element
  if (typeof element.type === 'function') return renderElement(element.type(element.props))
  return {
    ...element,
    children: (element.children ?? []).map(renderElement),
  }
}

/** Build the client context stand-in `apply` receives. */
function fakeClientContext() {
  const state = { injected: [], registered: [], effects: [], styleText: null }
  const ctx = {
    get(name) {
      if (name === 'slots') {
        return {
          inject(key, callback) {
            state.injected.push(key)
            const dispose = callback()
            return typeof dispose === 'function' ? dispose : () => {}
          },
          register(options, component) {
            state.registered.push({ options, component })
            return () => {}
          },
        }
      }
      if (name === 'locale') {
        return {
          getSnapshot: () => 'zh',
          register() {},
          bind: () => (key) => key,
        }
      }
      return undefined
    },
    effect(callback, label) {
      state.effects.push(label)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return { ctx, state }
}

test('the bundle registers its factory under the package id', () => {
  const { registrations } = materialize()
  assert.equal(registrations[0].id, 'dsh-cost-meter')
  assert.equal(typeof registrations[0].factory, 'function')
})

test('the bundle requires only seed modules', () => {
  const { requires } = materialize()
  assert.deepEqual([...new Set(requires)].sort(), ['react', 'react-dom'])
  for (const id of requires) assert.ok(SEED_MODULES.has(id), `${id} is a seed module`)
})

test('the module exports apply and inject, and injects the slots service', () => {
  const { exports } = materialize()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
})

test('apply registers one entry in the composer dock beside the host stats pill', () => {
  const { exports } = materialize()
  const { ctx, state } = fakeClientContext()
  exports.apply(ctx)
  assert.deepEqual(state.injected, ['conversation.composer.dock'])
  assert.equal(state.registered.length, 1)
  const { options, component } = state.registered[0]
  assert.equal(options.name, 'conversation.composer.dock')
  assert.equal(options.id, 'cost-meter')
  // The host's token/cache-hit pill occupies order 0; this one sits just after it.
  assert.equal(options.order, 1)
  assert.equal(typeof component, 'function')
  // Resources are owned by an effect so unloading removes them.
  assert.ok(state.effects.some(label => typeof label === 'string' && label.includes('dsh-cost-meter')))
})

test('the pill renders from the slot props without throwing', () => {
  const harness = materialize()
  const { ctx, state } = fakeClientContext()
  harness.exports.apply(ctx)
  const component = state.registered[0].component
  // `t` is injected by apply's wrapper; the slot would pass the standard props.
  const element = harness.render(component({
    sessionId: 'session-6106d868-23d6-45c0-b97c-27d4e6a1e791',
    useProjection: () => ({ uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 }),
  }))
  assert.equal(element.type, 'span')
  assert.equal(element.props.className, 'dcm-root')
  const pill = element.children[0]
  assert.equal(pill.type, 'button')
  assert.equal(pill.props.className, 'dcm-pill')
  assert.equal(pill.props['aria-haspopup'], 'dialog')
  // Before the first payload arrives the pill shows the pending placeholder.
  const label = pill.children[1]
  assert.equal(label.props.className, 'dcm-label')
  assert.equal(label.children[0], '¥…')
})

test('the pill stays visible and explained when the slot passes no sessionId', () => {
  const harness = materialize()
  const { ctx, state } = fakeClientContext()
  harness.exports.apply(ctx)
  const element = harness.render(state.registered[0].component({ useProjection: () => undefined }))
  const pill = element.children[0]
  assert.equal(pill.props['data-state'], 'error')
  assert.equal(pill.children[1].children[0], '—')
  assert.ok(harness.logged.some(line => line.includes('no sessionId')), 'the missing prop is reported once')
})

test('the pill tolerates a missing projection hook and a missing locale service', () => {
  const harness = materialize()
  const { ctx, state } = fakeClientContext()
  harness.exports.apply(ctx)
  assert.doesNotThrow(() => harness.render(state.registered[0].component({ sessionId: 'session-x' })))
  // A context without any locale service still renders.
  const bare = {
    get: (name) => (name === 'slots' ? ctx.get('slots') : undefined),
    effect: (callback) => { callback(); return () => {} },
  }
  assert.doesNotThrow(() => harness.exports.apply(bare))
})

test('apply reports a missing slots service instead of throwing', () => {
  const harness = materialize()
  assert.doesNotThrow(() => harness.exports.apply({
    get: () => undefined,
    effect: (callback) => { callback(); return () => {} },
  }))
  assert.ok(
    harness.logged.some(line => line.includes('slots service is unavailable')),
    `expected a diagnostic, got: ${JSON.stringify(harness.logged)}`,
  )
})

test('the stylesheet styles from theme tokens and never from literal colours', () => {
  const css = SOURCE.slice(SOURCE.indexOf('const CSS = `') + 13, SOURCE.indexOf('`\n\n    /** One shared store'))
  assert.ok(css.length > 500, 'the stylesheet was located')
  // Every colour-ish declaration must go through a token.
  const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []
  assert.deepEqual(literals, [], 'no literal colours in the stylesheet')
  // The class prefix is the plugin's own, so it cannot collide with host classes.
  const classes = [...new Set((css.match(/\.dcm-[a-z-]+/g) ?? []))]
  assert.ok(classes.length >= 15, 'the stylesheet uses the dcm- prefix')
  for (const name of classes) assert.match(name, /^\.dcm-[a-z-]+$/)
  // The host's own metrics are reused so the two dock pills align.
  assert.ok(css.includes('--dsh-content-font-size-secondary'))
  assert.ok(css.includes('--dsw-alias-label-tertiary'))
})

test('the bundle never imports a Harness client package', () => {
  assert.equal(SOURCE.includes("@deepseek-ai/dsh-client-ui-primitives"), false)
  assert.equal(/require\(['"]@deepseek-ai\//.test(SOURCE), false)
})
