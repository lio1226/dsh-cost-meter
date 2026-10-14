/**
 * Host half of the session-cost plugin.
 *
 * Responsibilities:
 *
 * 1. Own one price table. The sibling `dsh-deepseek-peak-pricing` plugin already
 *    syncs the official DeepSeek pricing page into `storages/`, so when that
 *    snapshot exists this half reads it and both plugins quote the same numbers.
 *    Otherwise the bundled table is used, and `config.json` can override either.
 * 2. Price one session. The browser half knows the session's aggregate token
 *    counts but not which model billed them or at which phase, so the fold runs
 *    here: `ctx.sessionQuery.readSession()` returns the complete log, every
 *    `assistant/message` carries provider-reported `usage` and its own provider,
 *    model and timestamp, and each call is priced at the peak/off-peak phase of
 *    its own instant.
 * 3. Read the account balance from the signed-in DeepSeek account, falling back
 *    to the Open Platform endpoint with a layered credential.
 * 4. Serve both over one read-only JSON route. The API key never reaches the
 *    browser and the browser never parses a session log.
 *
 * Deliberately dependency-free — Node built-ins plus optional Host services
 * reached through `ctx.get()`, so the package works linked into a profile from a
 * source directory with no `node_modules` of its own.
 */
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readBalance } from './balance.js'
import { BUNDLED_PRICING, describePhase, foldSession, normalizePricing } from './pricing.js'

/** Plugin identity, matching the loader row in `cordis.patch.yml`. */
export const name = 'dsh-cost-meter'

/** `webServer` owns the HTTP carrier the client half reads. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/cost-meter'

/** Client bundle id, matching the `window.__ModuleLoader__.load` id. */
export const CLIENT_ID = 'dsh-cost-meter'

/** Data directory name under this DSH home's `storages/`. */
const STORAGE_NAME = 'dsh-cost-meter'

/** Sibling plugin whose synced official price table this plugin prefers. */
const SIBLING_STORAGE = 'dsh-deepseek-peak-pricing'

/**
 * Reject a request that did not come from this machine's own page.
 *
 * The same defence the `/api` gateway uses: the `Host` header must be a loopback
 * authority (or a configured trusted one), and a browser must not mark the
 * request cross-site. It stops DNS-rebinding and cross-site reads, not a local
 * attacker.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {string[]} trustedHosts - extra authorities this deployment serves.
 * @returns {boolean} true when the request is trusted.
 */
function isTrustedRequest(request, trustedHosts) {
  const headers = request.headers ?? {}
  const host = typeof headers.host === 'string' ? headers.host : undefined
  if (host === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const loopback = hostUrl.hostname === 'localhost'
    || hostUrl.hostname === '[::1]'
    || hostUrl.hostname === '::1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostUrl.hostname)
  const trusted = Array.isArray(trustedHosts) && trustedHosts.some((entry) => {
    try {
      return new URL(`http://${entry}`).hostname === hostUrl.hostname
    } catch {
      return false
    }
  })
  if (!loopback && !trusted) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).hostname !== hostUrl.hostname) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Render an unknown thrown value as a short message.
 * @param {unknown} error - the thrown value.
 * @returns {string} the message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Clamp a user-supplied number into an inclusive range.
 * @param {unknown} value - the raw value.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @param {number} fallback - used when the value is not a finite number.
 * @returns {number} the clamped value.
 */
function clampNumber(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * Resolve this DSH home's plugin data directory.
 * @param {NodeJS.ProcessEnv} [env] - the process environment.
 * @returns {string} the directory holding `config.json`.
 */
export function dataDirOf(env = process.env) {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'storages', STORAGE_NAME)
}

/**
 * Path of the sibling plugin's synced price snapshot.
 * @param {NodeJS.ProcessEnv} [env] - the process environment.
 * @returns {string} the path.
 */
export function siblingSnapshotPath(env = process.env) {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'storages', SIBLING_STORAGE, 'snapshot.json')
}

/**
 * The resolved configuration, and the source of every default.
 * @returns {object} the default configuration.
 */
function defaultConfig() {
  return {
    locale: 'zh',
    decimals: 4,
    /** Prefer the sibling plugin's synced official table; `false` pins the bundled one. */
    useSiblingPricing: true,
    /** Beijing `YYYY-MM-DD` statutory holidays: off-peak all day. */
    holidays: [],
    /** Serve a cached fold for this long, so a fast-changing browser cannot rescan the log. */
    cacheSeconds: 8,
    balance: {
      enabled: true,
      apiKeyEnv: 'DEEPSEEK_BALANCE_API_KEY',
      fallbackKeyEnvs: ['DEEPSEEK_API_KEY'],
      baseUrl: 'https://api.deepseek.com',
      refreshMinutes: 5,
      timeoutMs: 12_000,
      clientVersion: '0.2.0',
    },
  }
}

/**
 * Coerce the user configuration into the resolved shape.
 * @param {unknown} raw - the parsed `config.json` (and any loader-row override).
 * @returns {object} the resolved configuration.
 */
export function resolveConfig(raw) {
  const base = defaultConfig()
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const balance = source.balance !== null && typeof source.balance === 'object' ? source.balance : {}
  const holidays = Array.isArray(source.holidays)
    ? source.holidays.filter(day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))
    : []
  const fallbackKeyEnvs = Array.isArray(balance.fallbackKeyEnvs)
    ? balance.fallbackKeyEnvs.filter(entry => typeof entry === 'string' && entry !== '')
    : base.balance.fallbackKeyEnvs
  return {
    locale: source.locale === 'en' || source.locale === 'zh' ? source.locale : base.locale,
    decimals: Math.round(clampNumber(source.decimals, 2, 8, base.decimals)),
    useSiblingPricing: source.useSiblingPricing !== false,
    holidays,
    cacheSeconds: clampNumber(source.cacheSeconds, 1, 300, base.cacheSeconds),
    prices: source.prices !== null && typeof source.prices === 'object' ? source.prices : null,
    balance: {
      enabled: balance.enabled !== false,
      apiKeyEnv: typeof balance.apiKeyEnv === 'string' && balance.apiKeyEnv !== '' ? balance.apiKeyEnv : base.balance.apiKeyEnv,
      fallbackKeyEnvs,
      baseUrl: typeof balance.baseUrl === 'string' && balance.baseUrl !== '' ? balance.baseUrl : base.balance.baseUrl,
      refreshMinutes: clampNumber(balance.refreshMinutes, 1, 1440, base.balance.refreshMinutes),
      timeoutMs: clampNumber(balance.timeoutMs, 1000, 60_000, base.balance.timeoutMs),
      clientVersion: typeof balance.clientVersion === 'string' && balance.clientVersion !== ''
        ? balance.clientVersion
        : base.balance.clientVersion,
    },
  }
}

/**
 * Log through the Cordis logger when the context carries one.
 * @param {object} ctx - the Cordis context.
 * @param {'info'|'warn'|'error'} level - the level.
 * @param {string} message - the message.
 * @returns {void}
 */
function log(ctx, level, message) {
  try {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger[level] === 'function') {
      logger[level](`[${CLIENT_ID}] ${message}`)
      return
    }
    console[level === 'info' ? 'log' : level](`[${CLIENT_ID}] ${message}`)
  } catch {
    /* logging must never break the plugin */
  }
}

/**
 * Write a file through a sibling temporary path so a crash cannot truncate it.
 * @param {string} path - the destination.
 * @param {string} content - the payload.
 * @returns {Promise<void>} resolution after the rename.
 */
async function writeAtomic(path, content) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, 'utf8')
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * Load the price table, in preference order:
 * config override → sibling plugin's synced official snapshot → bundled table.
 * @param {object} config - the resolved plugin config.
 * @param {NodeJS.ProcessEnv} [env] - the process environment.
 * @returns {Promise<object>} the normalized table, always usable.
 */
export async function loadPricing(config, env = process.env) {
  const bundled = normalizePricing(BUNDLED_PRICING)
  const override = config.prices === null ? null : normalizePricing({ source: 'config', ...config.prices })
  if (override !== null) return override
  if (config.useSiblingPricing === true) {
    try {
      const raw = JSON.parse(await readFile(siblingSnapshotPath(env), 'utf8'))
      const snapshot = raw !== null && typeof raw === 'object' && raw.snapshot !== null && typeof raw.snapshot === 'object'
        ? raw.snapshot
        : raw
      const normalized = normalizePricing({ ...snapshot, source: 'official' })
      if (normalized !== null) {
        return {
          ...normalized,
          fetchedAt: Number(raw.fetchedAt) || normalized.fetchedAt,
          sourceDetail: 'dsh-deepseek-peak-pricing snapshot',
        }
      }
    } catch {
      /* a missing or malformed sibling snapshot is the normal standalone case */
    }
  }
  return { ...bundled, sourceDetail: 'bundled table' }
}

/**
 * Read one session's events through the Host's session query service.
 * @param {object} ctx - the Cordis context.
 * @param {string} sessionId - the session to read.
 * @returns {Promise<object[]>} the events in ascending seq order.
 */
async function readSessionEvents(ctx, sessionId) {
  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (query === undefined || query === null || typeof query.readSession !== 'function') {
    throw new Error('the sessionQuery service is unavailable in this profile')
  }
  const snapshot = await query.readSession(sessionId)
  const events = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.events) ? snapshot.events : null
  if (events === null) throw new Error('the session read returned no event log')
  return events
}

/**
 * Count the turns a session log records, for the panel's context line.
 * @param {readonly object[]} events - the session events.
 * @returns {number} the number of `turn/start` events.
 */
function countTurns(events) {
  let turns = 0
  for (const event of events) {
    if (event !== null && typeof event === 'object' && event.type === 'turn/start') turns += 1
  }
  return turns
}

/**
 * Build the payload the client half renders.
 * @param {object} params - the assembled state.
 * @returns {object} the wire payload.
 */
export function buildPayload(params) {
  const { sessionId, fold, pricing, balance, config, now, sessionError, cached } = params
  const phase = describePhase(now, pricing, config.holidays)
  return {
    clientId: CLIENT_ID,
    serverNow: now,
    sessionId: sessionId ?? null,
    session: {
      ok: sessionError === null,
      error: sessionError,
      cached: cached === true,
      cost: fold === null ? 0 : fold.cost,
      currency: fold === null ? pricing.currency : fold.currency,
      totals: fold === null ? null : fold.totals,
      models: fold === null ? [] : fold.models,
      turns: fold === null ? 0 : fold.turns,
      lastEventAt: fold === null ? 0 : fold.lastEventAt,
    },
    pricing: {
      source: pricing.source,
      sourceDetail: pricing.sourceDetail ?? pricing.source,
      sourceUrl: pricing.sourceUrl,
      fetchedAt: pricing.fetchedAt,
      currency: pricing.currency,
      unit: pricing.unit,
      rules: pricing.rules,
      holidayCount: config.holidays.length,
      models: Object.entries(pricing.models).map(([key, entry]) => ({
        key,
        name: entry.name,
        peak: entry.peak,
        offPeak: entry.offPeak,
      })),
      phase: phase.phase,
      nextPhase: phase.nextPhase,
      phaseEndsAt: phase.phaseEndsAt,
      remainingMs: phase.remainingMs,
    },
    balance,
    display: {
      locale: config.locale,
      decimals: config.decimals,
      currency: pricing.currency,
      refreshSeconds: config.cacheSeconds,
    },
  }
}

/**
 * Install the plugin: load configuration and the price table, then serve routes.
 * @param {object} ctx - the Cordis context.
 * @param {object} [rowConfig] - the loader row's `config`, when the patch sets one.
 * @returns {void}
 */
export function apply(ctx, rowConfig) {
  const dir = dataDirOf()
  const state = {
    config: resolveConfig(rowConfig),
    pricing: normalizePricing(BUNDLED_PRICING),
    balance: { status: 'off', message: 'not queried yet', fetchedAt: 0, wallets: [], bonusWallets: [], source: 'none' },
    /** sessionId → { at, fold, error } */
    sessions: new Map(),
  }
  let disposed = false
  let balanceInFlight = null

  /** Read `config.json`, and take the loader row's config as a base when present. */
  const loadConfig = async () => {
    let fileConfig = {}
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
      if (parsed !== null && typeof parsed === 'object') fileConfig = parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') log(ctx, 'warn', `could not read config.json: ${messageOf(error)}`)
    }
    const row = rowConfig !== null && typeof rowConfig === 'object' ? rowConfig : {}
    // The file wins over the row so a user can retune without editing the patch.
    state.config = resolveConfig({ ...row, ...fileConfig, balance: { ...row.balance, ...fileConfig.balance } })
    state.pricing = await loadPricing(state.config)
    log(ctx, 'info', `pricing source: ${state.pricing.sourceDetail ?? state.pricing.source} (${Object.keys(state.pricing.models).length} models, ${state.pricing.currency})`)
  }

  /** Fold one session, reusing a fresh cache entry. */
  const foldFor = async (sessionId, force) => {
    const now = Date.now()
    const cached = state.sessions.get(sessionId)
    if (force !== true && cached !== undefined && now - cached.at < state.config.cacheSeconds * 1000) {
      return { ...cached, cached: true }
    }
    let fold = null
    let error = null
    try {
      const events = await readSessionEvents(ctx, sessionId)
      if (disposed) return { at: now, fold: null, error: null, cached: false }
      fold = foldSession(events, { pricing: state.pricing, holidays: state.config.holidays })
      fold.turns = countTurns(events)
      fold.lastEventAt = events.reduce((latest, event) => {
        const time = Number(event?.time)
        return Number.isFinite(time) && time > latest ? time : latest
      }, 0)
    } catch (caught) {
      error = messageOf(caught)
      log(ctx, 'warn', `could not price session ${sessionId}: ${error}`)
    }
    const entry = { at: now, fold, error, cached: false }
    // Bounded cache: the composer only ever asks about recent sessions.
    if (state.sessions.size > 32) state.sessions.clear()
    state.sessions.set(sessionId, entry)
    return entry
  }

  /** Refresh the balance, honouring the configured interval unless forced. */
  const refreshBalance = async (force) => {
    const age = Date.now() - state.balance.fetchedAt
    const fresh = state.balance.status === 'ok' && age < state.config.balance.refreshMinutes * 60_000
    if (force !== true && fresh) return state.balance
    if (balanceInFlight !== null) return balanceInFlight
    balanceInFlight = (async () => {
      const next = await readBalance(ctx, state.config)
      if (disposed) return state.balance
      // Keep the last good wallets when a refresh fails, so the panel degrades
      // to "stale" instead of losing the number the user was reading.
      if (next.status !== 'ok' && state.balance.status === 'ok' && state.balance.wallets.length > 0) {
        state.balance = { ...state.balance, stale: true, message: next.message, error: next.status }
        return state.balance
      }
      state.balance = next
      return next
    })().finally(() => {
      balanceInFlight = null
    })
    return balanceInFlight
  }

  /** Assemble the payload for one request. */
  const snapshot = async (sessionId, force) => {
    const entry = sessionId === null || sessionId === ''
      ? { at: Date.now(), fold: null, error: null, cached: false }
      : await foldFor(sessionId, force)
    const balance = force === true ? await refreshBalance(true) : await refreshBalance(false)
    return buildPayload({
      sessionId,
      fold: entry.fold,
      pricing: state.pricing,
      balance,
      config: state.config,
      now: Date.now(),
      sessionError: entry.error,
      cached: entry.cached,
    })
  }

  /** Register the JSON routes; the disposer releases them with the fiber. */
  const registerRoutes = () => {
    const runtime = ctx.get('webRuntime')
    const trustedHosts = Array.isArray(runtime?.trustedHosts)
      ? runtime.trustedHosts.filter(host => typeof host === 'string')
      : []
    return ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (request, response) => {
        const send = (status, body) => {
          const payload = JSON.stringify(body)
          response.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(payload),
          })
          response.end(payload)
        }
        if (!isTrustedRequest(request, trustedHosts)) {
          send(403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        const url = new URL(request.url ?? '/', 'http://dsh.internal')
        const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
        const sessionId = url.searchParams.get('sessionId')
        try {
          if (route === '/api/state' && request.method === 'GET') {
            send(200, { ok: true, value: await snapshot(sessionId, false) })
            return
          }
          if (route === '/api/refresh' && request.method === 'POST') {
            send(200, { ok: true, value: await snapshot(sessionId, true) })
            return
          }
          if (route === '/api/pricing' && request.method === 'GET') {
            send(200, {
              ok: true,
              value: {
                source: state.pricing.source,
                sourceDetail: state.pricing.sourceDetail ?? state.pricing.source,
                sourceUrl: state.pricing.sourceUrl,
                fetchedAt: state.pricing.fetchedAt,
                currency: state.pricing.currency,
                unit: state.pricing.unit,
                rules: state.pricing.rules,
                models: state.pricing.models,
              },
            })
            return
          }
          send(404, { ok: false, error: { code: 'not-found', message: `unknown route ${request.method} ${route}` } })
        } catch (error) {
          send(500, { ok: false, error: { code: 'internal', message: messageOf(error) } })
        }
      },
    })
  }

  ctx.effect(() => {
    const offRoute = registerRoutes()
    // Write a commented starter config on first run so the tunables are findable.
    void (async () => {
      try {
        await mkdir(dir, { recursive: true })
        await readFile(join(dir, 'config.json'), 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') {
          const starter = {
            _readme: 'dsh-cost-meter 配置：删除本行不影响。holidays 填北京时间法定节假日 YYYY-MM-DD（全天谷时）；prices 覆盖价格表；balance.apiKeyEnv 指定开放平台 API Key 的环境变量名。',
            _example: {
              holidays: ['2026-10-01'],
              prices: { models: { 'deepseek-flash': { peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }, offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 } } } },
              balance: { refreshMinutes: 5 },
            },
          }
          await writeAtomic(join(dir, 'config.json'), `${JSON.stringify(starter, null, 2)}\n`).catch(() => {})
        }
      }
    })()
    void loadConfig()
      .then(() => refreshBalance(false))
      .catch(error => log(ctx, 'warn', `startup failed: ${messageOf(error)}`))
    return () => {
      disposed = true
      state.sessions.clear()
      offRoute()
    }
  }, `${CLIENT_ID}: cost routes`)

  log(ctx, 'info', `mounted (data dir: ${dir})`)
}
