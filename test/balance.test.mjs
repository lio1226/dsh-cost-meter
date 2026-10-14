/**
 * Balance-lookup tests: the Open Platform response parser, credential
 * resolution through the layered credential service, and the three-way outcome
 * of `readBalance`.
 *
 * No network request is made: `ctx.web` is either absent (so the fetch path is
 * stubbed out by an unconfigured key) or a stand-in that returns a fixture.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePlatformBalance, readBalance, resolveApiKey } from '../lib/balance.js'
import { resolveConfig } from '../lib/index.js'

/** The config shape `readBalance` expects. */
const CONFIG = resolveConfig(undefined)

/**
 * A Cordis context stand-in.
 * @param {object} [options] - the services to expose.
 * @returns {object} the context.
 */
function fakeContext(options = {}) {
  return {
    get(name) {
      if (name === 'deepseekAccount') return options.account
      if (name === 'credentials') return options.credentials
      if (name === 'web') return options.web
      return undefined
    },
  }
}

test('parsePlatformBalance reads the documented /user/balance body', () => {
  const parsed = parsePlatformBalance({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      { currency: 'USD', total_balance: '5.00', granted_balance: '0.00', topped_up_balance: '5.00' },
    ],
  })
  assert.equal(parsed.available, true)
  assert.equal(parsed.wallets.length, 2)
  assert.deepEqual(parsed.wallets[0], { currency: 'CNY', balance: 110, raw: '110.00', granted: 10, toppedUp: 100 })
  assert.equal(parsed.wallets[1].currency, 'USD')
  // Malformed input yields no wallets rather than throwing.
  assert.deepEqual(parsePlatformBalance(null), { wallets: [], available: false })
  assert.deepEqual(parsePlatformBalance({ balance_infos: 'nope' }), { wallets: [], available: false })
  // An unparseable amount reads as null, not as zero.
  assert.equal(parsePlatformBalance({ balance_infos: [{ currency: 'CNY', total_balance: '' }] }).wallets[0].balance, null)
})

test('resolveApiKey layers the credential service over the process environment', async () => {
  const config = resolveConfig({ balance: { apiKeyEnv: 'DCM_TEST_KEY', fallbackKeyEnvs: ['DCM_TEST_FALLBACK'] } })
  // The credential service answers first and names its source.
  const fromStore = await resolveApiKey(fakeContext({
    credentials: { resolve: async (ref) => (ref === 'DCM_TEST_KEY' ? { value: ' sk-from-store ', source: 'provider-store' } : undefined) },
  }), config)
  assert.deepEqual(fromStore, { value: 'sk-from-store', source: 'provider-store', name: 'DCM_TEST_KEY' })

  // An empty stored value is absent, so the fallback name is tried.
  const fromFallback = await resolveApiKey(fakeContext({
    credentials: {
      resolve: async (ref) => (ref === 'DCM_TEST_FALLBACK' ? { value: 'sk-fallback', source: 'file' } : undefined),
    },
  }), config)
  assert.deepEqual(fromFallback, { value: 'sk-fallback', source: 'file', name: 'DCM_TEST_FALLBACK' })

  // Nothing configured anywhere: no key, no throw.
  assert.equal(await resolveApiKey(fakeContext({}), config), null)
  // A credential service that throws does not take the query down with it.
  assert.equal(await resolveApiKey(fakeContext({ credentials: { resolve: async () => { throw new Error('locked') } } }), config), null)
  // A name outside the environment-variable grammar is never resolved.
  assert.equal(await resolveApiKey(fakeContext({}), resolveConfig({ balance: { apiKeyEnv: 'not a var', fallbackKeyEnvs: [] } })), null)
})

test('readBalance prefers the signed-in account', async () => {
  const balance = await readBalance(fakeContext({
    account: {
      getBalance: async () => ({
        status: 'ready',
        value: [{ currency: 'CNY', balance: '15.62575136' }],
        bonusWallets: [{ currency: 'CNY', balance: '0' }],
      }),
    },
  }), CONFIG)
  assert.equal(balance.status, 'ok')
  assert.equal(balance.source, 'account')
  assert.equal(balance.wallets[0].balance, 15.62575136)
  assert.equal(balance.bonusWallets[0].balance, 0)
  assert.ok(balance.fetchedAt > 0)
})

test('readBalance falls back to the platform endpoint when signed out', async () => {
  const seen = []
  const balance = await readBalance(fakeContext({
    account: { getBalance: async () => null },
    credentials: { resolve: async (ref) => (ref === 'DEEPSEEK_BALANCE_API_KEY' ? { value: 'sk-test', source: 'provider-store' } : undefined) },
    web: {
      fetch: async (request) => {
        seen.push(request)
        return {
          statusCode: 200,
          body: { content: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.50', granted_balance: '2.50', topped_up_balance: '40.00' }] }) },
        }
      },
    },
  }), CONFIG)
  assert.equal(balance.status, 'ok')
  assert.equal(balance.source, 'platform')
  assert.equal(balance.wallets[0].balance, 42.5)
  assert.equal(balance.wallets[0].granted, 2.5)
  assert.equal(balance.keyName, 'DEEPSEEK_BALANCE_API_KEY')
  // The key travels in the Authorization header and nowhere else.
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(seen[0].headers.authorization, 'Bearer sk-test')
})

test('an invalid platform key reports authentication failure without retrying another account', async () => {
  const calls = []
  const balance = await readBalance(fakeContext({
    account: { getBalance: async () => null },
    credentials: { resolve: async () => ({ value: 'sk-bad', source: 'provider-store' }) },
    web: {
      fetch: async (request) => {
        calls.push(request)
        return { statusCode: 401, body: { content: '' } }
      },
    },
  }), CONFIG)
  assert.equal(balance.status, 'failed')
  assert.match(balance.message, /401/)
  assert.match(balance.message, /DEEPSEEK_BALANCE_API_KEY/)
  // Exactly one attempt: a rejected key must not be retried against another account.
  assert.equal(calls.length, 1)
})

test('readBalance explains an unconfigured key instead of showing a number', async () => {
  const balance = await readBalance(fakeContext({ account: { getBalance: async () => null } }), resolveConfig(undefined))
  assert.equal(balance.status, 'unconfigured')
  assert.match(balance.message, /DEEPSEEK_BALANCE_API_KEY/)
  assert.deepEqual(balance.wallets, [])
})

test('a disabled balance query is reported as off, with no lookup at all', async () => {
  let touched = false
  const balance = await readBalance(fakeContext({
    account: { getBalance: async () => { touched = true; return null } },
  }), resolveConfig({ balance: { enabled: false } }))
  assert.equal(balance.status, 'off')
  assert.equal(touched, false)
})

test('an account query failure falls through to the platform path', async () => {
  const balance = await readBalance(fakeContext({
    account: { getBalance: async () => { throw new Error('grant changed') } },
    credentials: { resolve: async () => ({ value: 'sk-test', source: 'env' }) },
    web: {
      fetch: async () => ({
        statusCode: 200,
        body: { content: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }) },
      }),
    },
  }), CONFIG)
  assert.equal(balance.status, 'ok')
  assert.equal(balance.source, 'platform')
})
