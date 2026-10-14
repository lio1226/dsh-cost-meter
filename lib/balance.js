/**
 * Account-balance lookup for the session-cost plugin.
 *
 * Two sources, in order:
 *
 * 1. The Host's own signed-in DeepSeek account (`ctx.deepseekAccount`). This is
 *    the wallet DSH itself knows about, and it needs no key from the user.
 * 2. The Open Platform HTTP endpoint `GET <baseUrl>/user/balance`, which needs
 *    an API key. The key is resolved per call through `ctx.credentials`, so it
 *    is read from the process environment, the provider-managed store, or a
 *    `.env` file — never from this plugin's config, and never returned to the
 *    browser.
 *
 * A failure in one source is not fatal: the result names which source answered
 * and what went wrong, so the panel can explain itself instead of going blank.
 */

/** Wallet currency ids the endpoint and the account view both use. */
const KNOWN_CURRENCIES = new Set(['CNY', 'USD'])

/**
 * Coerce a money value that may arrive as a string, as the Platform does.
 * @param {unknown} value - the raw value.
 * @returns {number|null} the amount, or null when unparseable.
 */
function amountOf(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Keep only wallets this plugin can render.
 * @param {unknown} list - wallets from either source.
 * @returns {Array<{currency: string, balance: number|null, raw: string}>} the wallets.
 */
function normalizeWallets(list) {
  if (!Array.isArray(list)) return []
  const wallets = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const currency = typeof item.currency === 'string' && KNOWN_CURRENCIES.has(item.currency.toUpperCase())
      ? item.currency.toUpperCase()
      : 'CNY'
    const balance = amountOf(item.balance)
    wallets.push({
      currency,
      balance,
      raw: typeof item.balance === 'string' ? item.balance : balance === null ? '' : String(balance),
    })
  }
  return wallets
}

/**
 * Resolve one credential by environment-variable name through the layered
 * credential service, falling back to the raw process environment.
 *
 * `CredentialRef` is a branded string at the type level and a plain string at
 * runtime, so no dependency on the credentials package is needed.
 * @param {object} ctx - the Cordis context.
 * @param {string} name - the environment-variable name.
 * @returns {Promise<{value: string, source: string}|null>} the credential, or null when unset.
 */
async function resolveCredential(ctx, name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(name)
      if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value.trim() !== '') {
        return { value: hit.value.trim(), source: typeof hit.source === 'string' ? hit.source : 'credentials' }
      }
    } catch {
      /* fall through to the bare environment */
    }
  }
  const fromEnv = process.env[name]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { value: fromEnv.trim(), source: 'env' }
  return null
}

/**
 * Find an Open Platform key among the configured names, first hit wins.
 * @param {object} ctx - the Cordis context.
 * @param {object} config - the resolved plugin config.
 * @returns {Promise<{value: string, source: string, name: string}|null>} the key, or null when none is configured.
 */
export async function resolveApiKey(ctx, config) {
  const names = [config.balance.apiKeyEnv, ...(config.balance.fallbackKeyEnvs ?? [])]
    .filter(name => typeof name === 'string' && name !== '')
  for (const name of names) {
    const hit = await resolveCredential(ctx, name)
    if (hit !== null) return { ...hit, name }
  }
  return null
}

/**
 * Ask the signed-in DeepSeek account for its wallets.
 * @param {object} ctx - the Cordis context.
 * @param {object} config - the resolved plugin config.
 * @returns {Promise<object>} `{status, wallets, bonusWallets, source}` — `status` is `ok`, `signed-out` or `failed`.
 */
async function readAccountBalance(ctx, config) {
  const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined
  if (account === undefined || account === null || typeof account.getBalance !== 'function') {
    return { status: 'unavailable', wallets: [], bonusWallets: [] }
  }
  try {
    const view = await account.getBalance({
      version: config.balance.clientVersion,
      locale: config.locale === 'en' ? 'en' : 'zh',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
    // A null result means "signed out or the grant changed" — not an error.
    if (view === null || view === undefined) return { status: 'signed-out', wallets: [], bonusWallets: [] }
    if (view.status !== 'ready') return { status: 'failed', wallets: [], bonusWallets: [], message: 'account query failed' }
    return {
      status: 'ok',
      wallets: normalizeWallets(view.value),
      bonusWallets: normalizeWallets(view.bonusWallets),
    }
  } catch (error) {
    return {
      status: 'failed',
      wallets: [],
      bonusWallets: [],
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Parse the Open Platform `/user/balance` body.
 * @param {unknown} body - the decoded JSON body.
 * @returns {{wallets: Array<{currency: string, balance: number|null, raw: string}>, available: boolean}} the parsed wallets.
 */
export function parsePlatformBalance(body) {
  if (body === null || typeof body !== 'object') return { wallets: [], available: false }
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : []
  const wallets = []
  for (const info of infos) {
    if (info === null || typeof info !== 'object') continue
    const currency = typeof info.currency === 'string' && KNOWN_CURRENCIES.has(info.currency.toUpperCase())
      ? info.currency.toUpperCase()
      : 'CNY'
    wallets.push({
      currency,
      // The total is what the user can spend; granted and topped-up are its parts.
      balance: amountOf(info.total_balance),
      raw: typeof info.total_balance === 'string' ? info.total_balance : String(info.total_balance ?? ''),
      granted: amountOf(info.granted_balance),
      toppedUp: amountOf(info.topped_up_balance),
    })
  }
  return { wallets, available: body.is_available === true }
}

/**
 * Query the Open Platform balance endpoint with a resolved key.
 * @param {object} ctx - the Cordis context.
 * @param {object} config - the resolved plugin config.
 * @returns {Promise<object>} `{status, wallets, source, message?}`.
 */
async function readPlatformBalance(ctx, config) {
  const key = await resolveApiKey(ctx, config)
  if (key === null) return { status: 'unconfigured', wallets: [], source: 'none', keyName: config.balance.apiKeyEnv }
  const base = String(config.balance.baseUrl ?? '').replace(/\/+$/, '')
  const url = `${base}/user/balance`
  try {
    const web = typeof ctx.get === 'function' ? ctx.get('web') : undefined
    let text = null
    let status = 0
    if (web !== undefined && web !== null && typeof web.fetch === 'function') {
      const result = await web.fetch({ url, headers: { authorization: `Bearer ${key.value}` } }, AbortSignal.timeout(config.balance.timeoutMs))
      status = Number(result?.statusCode)
      text = result?.body?.content
    } else if (typeof fetch === 'function') {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${key.value}`, accept: 'application/json' },
        signal: AbortSignal.timeout(config.balance.timeoutMs),
      })
      status = response.status
      text = await response.text()
    } else {
      return { status: 'failed', wallets: [], source: key.source, keyName: key.name, message: 'no HTTP client available' }
    }
    if (!Number.isFinite(status) || status < 200 || status >= 300) {
      return {
        status: 'failed',
        wallets: [],
        source: key.source,
        keyName: key.name,
        message: status === 401 ? `HTTP 401 (the key in ${key.name} is not an Open Platform key)` : `HTTP ${status}`,
      }
    }
    if (typeof text !== 'string' || text.trim() === '') {
      return { status: 'failed', wallets: [], source: key.source, keyName: key.name, message: 'empty response body' }
    }
    const parsed = parsePlatformBalance(JSON.parse(text))
    if (parsed.wallets.length === 0) {
      return { status: 'failed', wallets: [], source: key.source, keyName: key.name, message: 'no wallet in the response' }
    }
    return { status: 'ok', wallets: parsed.wallets, source: key.source, keyName: key.name, available: parsed.available }
  } catch (error) {
    return {
      status: 'failed',
      wallets: [],
      source: key.source,
      keyName: key.name,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Read the account balance, preferring the signed-in account and falling back to
 * the Open Platform key path.
 * @param {object} ctx - the Cordis context.
 * @param {object} config - the resolved plugin config.
 * @returns {Promise<object>} the balance snapshot the panel renders.
 */
export async function readBalance(ctx, config) {
  const fetchedAt = Date.now()
  if (config.balance.enabled !== true) {
    return { status: 'off', message: 'balance is disabled in config.json', fetchedAt, wallets: [], bonusWallets: [], source: 'off' }
  }
  const account = await readAccountBalance(ctx, config)
  if (account.status === 'ok' && account.wallets.length > 0) {
    return {
      status: 'ok',
      source: 'account',
      message: '',
      fetchedAt,
      wallets: account.wallets,
      bonusWallets: account.bonusWallets,
    }
  }
  const platform = await readPlatformBalance(ctx, config)
  if (platform.status === 'ok') {
    return {
      status: 'ok',
      source: 'platform',
      message: '',
      fetchedAt,
      wallets: platform.wallets,
      bonusWallets: [],
      available: platform.available === true,
      keyName: platform.keyName,
      keySource: platform.source,
    }
  }
  // Neither source answered: report the more actionable of the two failures.
  const message = platform.status === 'unconfigured'
    ? (account.status === 'signed-out'
      ? `not signed in to a DeepSeek account, and ${config.balance.apiKeyEnv} is not set`
      : `no balance source available (${config.balance.apiKeyEnv} is not set)`)
    : platform.message ?? ''
  return {
    status: platform.status === 'unconfigured' ? 'unconfigured' : 'failed',
    source: 'none',
    message,
    fetchedAt,
    wallets: [],
    bonusWallets: [],
    keyName: platform.keyName ?? config.balance.apiKeyEnv,
    keySource: platform.source ?? 'none',
  }
}
