/**
 * Host-half tests: configuration resolution, price-table loading, and the JSON
 * route end to end against a fake Cordis context and a fake sessionQuery.
 *
 * Everything runs against a temporary `DSH_HOME`, so no real profile state is
 * read or written and no network request is made.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, buildPayload, dataDirOf, loadPricing, resolveConfig, siblingSnapshotPath } from '../lib/index.js'
import { normalizePricing } from '../lib/pricing.js'

/** A fresh temporary DSH home. */
function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-cost-meter-test-'))
}

/** The sibling plugin's snapshot shape, as its own parser writes it. */
const SIBLING_SNAPSHOT = {
  schemaVersion: 1,
  snapshot: {
    schemaVersion: 1,
    sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    fetchedAt: 1790913353829,
    currency: 'CNY',
    unit: 'per_million_tokens',
    models: [
      {
        name: 'deepseek-flash',
        key: 'deepseek-flash',
        peak: { inputCacheHit: 0.04, inputCacheMiss: 2, output: 8 },
        offPeak: { inputCacheHit: 0.02, inputCacheMiss: 1, output: 4 },
      },
    ],
    rules: { windows: [[540, 720], [840, 1080]], weekdays: [1, 2, 3, 4, 5], timeZone: 'Asia/Shanghai' },
  },
  source: 'official',
  fetchedAt: 1790913353829,
  lastAttemptAt: 1790913353829,
  lastError: null,
}

/** One `assistant/message` event. */
function call(atIso, provider, model, usage) {
  return {
    type: 'assistant/message',
    seq: 1,
    time: Date.parse(atIso),
    data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider, model } }, usage },
  }
}

/**
 * A Cordis-context stand-in that records the registered route.
 * @param {object[]} events - what `sessionQuery.readSession` returns.
 * @returns {{ctx: object, route: () => object}} the fake context and a route accessor.
 */
function fakeContext(events) {
  let registered = null
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'sessionQuery') return { readSession: async () => ({ session: { id: 'session-test' }, events }) }
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register(route) {
        registered = route
        return () => {
          registered = null
        }
      },
    },
  }
  return { ctx, route: () => registered }
}

/** A minimal `IncomingMessage` stand-in. */
function fakeRequest(method, url) {
  return { method, url, headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' } }
}

/** A minimal `ServerResponse` stand-in that captures the JSON body. */
function fakeResponse() {
  const captured = { status: 0, body: null, headers: null }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(payload) {
      captured.body = JSON.parse(payload)
    },
  }
}

/** Let the plugin's asynchronous startup settle. */
async function settle() {
  for (let index = 0; index < 6; index += 1) await new Promise(resolve => setImmediate(resolve))
}

test('resolveConfig applies defaults and coerces the user configuration', () => {
  const defaults = resolveConfig(undefined)
  assert.equal(defaults.locale, 'zh')
  assert.equal(defaults.decimals, 4)
  assert.equal(defaults.useSiblingPricing, true)
  assert.equal(defaults.balance.apiKeyEnv, 'DEEPSEEK_BALANCE_API_KEY')
  assert.deepEqual(defaults.balance.fallbackKeyEnvs, ['DEEPSEEK_API_KEY'])
  assert.equal(defaults.balance.baseUrl, 'https://api.deepseek.com')
  assert.equal(defaults.balance.enabled, true)
  assert.deepEqual(defaults.holidays, [])

  const custom = resolveConfig({
    locale: 'en',
    decimals: 99,
    useSiblingPricing: false,
    cacheSeconds: 0,
    holidays: ['2026-10-01', 'not-a-date', 7],
    balance: { enabled: false, refreshMinutes: 0, apiKeyEnv: '', fallbackKeyEnvs: [] },
  })
  assert.equal(custom.locale, 'en')
  // Clamped into range rather than rejected.
  assert.equal(custom.decimals, 8)
  assert.equal(custom.cacheSeconds, 1)
  assert.equal(custom.useSiblingPricing, false)
  assert.deepEqual(custom.holidays, ['2026-10-01'])
  assert.equal(custom.balance.enabled, false)
  assert.equal(custom.balance.refreshMinutes, 1)
  // An empty name falls back to the default.
  assert.equal(custom.balance.apiKeyEnv, 'DEEPSEEK_BALANCE_API_KEY')
})

test('dataDirOf and siblingSnapshotPath honour DSH_HOME', () => {
  const home = tempHome()
  assert.equal(dataDirOf({ DSH_HOME: home }), join(home, 'storages', 'dsh-cost-meter'))
  assert.equal(siblingSnapshotPath({ DSH_HOME: home }), join(home, 'storages', 'dsh-deepseek-peak-pricing', 'snapshot.json'))
  // An unset DSH_HOME falls back to ~/.dsh rather than throwing.
  assert.ok(dataDirOf({}).endsWith(join('.dsh', 'storages', 'dsh-cost-meter')))
})

test('loadPricing prefers the config override, then the sibling snapshot, then bundled', async () => {
  const home = tempHome()
  const env = { DSH_HOME: home }

  // 1. No snapshot anywhere: the bundled table answers.
  const bundled = await loadPricing(resolveConfig(undefined), env)
  assert.equal(bundled.source, 'bundled')
  assert.ok(Object.keys(bundled.models).includes('deepseek-flash'))

  // 2. The sibling plugin's synced official snapshot wins, with its provenance.
  const siblingDir = join(home, 'storages', 'dsh-deepseek-peak-pricing')
  mkdirSync(siblingDir, { recursive: true })
  writeFileSync(join(siblingDir, 'snapshot.json'), JSON.stringify(SIBLING_SNAPSHOT))
  const official = await loadPricing(resolveConfig(undefined), env)
  assert.equal(official.source, 'official')
  assert.equal(official.fetchedAt, 1790913353829)
  assert.deepEqual(official.models['deepseek-flash'].peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 })

  // 3. A config override beats both.
  const override = await loadPricing(resolveConfig({
    prices: { models: { 'only-model': { peak: { cacheHit: 1, cacheMiss: 2, output: 3 }, offPeak: { cacheHit: 1, cacheMiss: 2, output: 3 } } } },
  }), env)
  assert.equal(override.source, 'config')
  assert.deepEqual(Object.keys(override.models), ['only-model'])

  // 4. A malformed snapshot is skipped rather than fatal.
  writeFileSync(join(siblingDir, 'snapshot.json'), '{ not json')
  const recovered = await loadPricing(resolveConfig(undefined), env)
  assert.equal(recovered.source, 'bundled')
})

test('buildPayload describes the session, the phase and the price table', () => {
  const config = resolveConfig({ holidays: ['2026-10-02'] })
  // The same labelling `loadPricing` applies to a sibling snapshot.
  const pricing = normalizePricing({ ...SIBLING_SNAPSHOT.snapshot, source: 'official' })
  const fold = {
    currency: 'CNY',
    cost: 0.5,
    totals: { calls: 2, totalTokens: 100, cacheHitRate: 0.5, costByBucket: { cacheMiss: 0.1, cacheHit: 0.1, cacheWrite: 0, output: 0.3 } },
    models: [{ label: 'deepseek-official / deepseek-flash', cost: 0.5, calls: 2, unpriced: 0 }],
    turns: 1,
    lastEventAt: 1,
  }
  const payload = buildPayload({
    sessionId: 'session-test',
    fold,
    pricing,
    balance: { status: 'off', message: '', fetchedAt: 0, wallets: [], bonusWallets: [], source: 'none' },
    config,
    // Friday 2026-10-02 13:17 Beijing, which config marks a statutory holiday.
    now: Date.parse('2026-10-02T05:17:48Z'),
    sessionError: null,
    cached: false,
  })
  assert.equal(payload.clientId, 'dsh-cost-meter')
  assert.equal(payload.session.ok, true)
  assert.equal(payload.session.cost, 0.5)
  assert.equal(payload.session.currency, 'CNY')
  assert.equal(payload.session.turns, 1)
  assert.equal(payload.pricing.source, 'official')
  assert.equal(payload.pricing.holidayCount, 1)
  assert.equal(payload.pricing.phase, 'offPeak')
  assert.equal(payload.pricing.models.length, 1)
  assert.equal(payload.display.decimals, 4)
})

test('GET /cost-meter/api/state prices a session log and refuses a cross-site read', async () => {
  const home = tempHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const events = [
      // Peak: Friday 2026-10-02 10:00 Beijing.
      call('2026-10-02T02:00:00Z', 'deepseek-official', 'deepseek-flash', {
        inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0,
      }),
      { type: 'turn/start', seq: 2, time: Date.parse('2026-10-02T02:00:00Z'), data: { turn: 1 } },
    ]
    const { ctx, route } = fakeContext(events)
    // Balance stays off, so the route never reaches the network.
    apply(ctx, { balance: { enabled: false } })
    await settle()

    assert.ok(route() !== null, 'the plugin registered a route')
    assert.equal(route().path, '/cost-meter')
    assert.equal(route().kind, 'prefix')

    const ok = fakeResponse()
    await route().handler(fakeRequest('GET', '/cost-meter/api/state?sessionId=session-test'), ok)
    assert.equal(ok.captured.status, 200)
    assert.equal(ok.captured.body.ok, true)
    const value = ok.captured.body.value
    assert.equal(value.sessionId, 'session-test')
    assert.equal(value.session.ok, true)
    assert.equal(value.session.turns, 1)
    // 1M miss at 2 + 1M hit at 0.04 + 1M output at 8, all at the peak rate.
    assert.equal(Math.round(value.session.cost * 1e6) / 1e6, 10.04)
    assert.equal(value.session.totals.calls, 1)
    assert.equal(value.session.models.length, 1)
    assert.equal(value.session.models[0].label, 'deepseek-official / deepseek-flash')
    assert.equal(value.session.totals.costByBucket.cacheMiss, 2)
    assert.equal(value.session.totals.costByBucket.cacheHit, 0.04)
    assert.equal(value.session.totals.costByBucket.output, 8)
    assert.equal(value.balance.status, 'off')
    assert.equal(value.pricing.source, 'bundled')
    // The API key is never part of the payload.
    assert.equal(JSON.stringify(value).includes('sk-'), false)

    // A cross-site read is refused before any session work happens.
    const crossSite = fakeResponse()
    const hostile = fakeRequest('GET', '/cost-meter/api/state?sessionId=session-test')
    hostile.headers['sec-fetch-site'] = 'cross-site'
    await route().handler(hostile, crossSite)
    assert.equal(crossSite.captured.status, 403)
    assert.equal(crossSite.captured.body.ok, false)

    // A non-loopback Host is refused too.
    const foreign = fakeResponse()
    const foreignRequest = fakeRequest('GET', '/cost-meter/api/state')
    foreignRequest.headers.host = 'example.com'
    await route().handler(foreignRequest, foreign)
    assert.equal(foreign.captured.status, 403)

    // An unknown route is a 404, not a crash.
    const missing = fakeResponse()
    await route().handler(fakeRequest('GET', '/cost-meter/api/nope'), missing)
    assert.equal(missing.captured.status, 404)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a session the query service cannot read degrades to an explained error', async () => {
  const home = tempHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      get(name) {
        if (name === 'sessionQuery') {
          return { readSession: async () => { throw new Error('no such session') } }
        }
        return undefined
      },
      effect(callback) {
        callback()
        return () => {}
      },
      webServer: { register(route) { this.registered = route; return () => {} } },
    }
    apply(ctx, { balance: { enabled: false } })
    await settle()
    const response = fakeResponse()
    await ctx.webServer.registered.handler(fakeRequest('GET', '/cost-meter/api/state?sessionId=missing'), response)
    assert.equal(response.captured.status, 200)
    const value = response.captured.body.value
    assert.equal(value.session.ok, false)
    assert.match(value.session.error, /no such session/)
    assert.equal(value.session.cost, 0)
    assert.deepEqual(value.session.models, [])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
