/**
 * Pure pricing core for the session-cost plugin.
 *
 * Everything here is a plain function over plain data: no Cordis context, no
 * clock, no I/O. The Host half supplies the price table, the holiday list and
 * the session events; this module answers "what did that cost".
 *
 * Price unit: the currency named by `pricing.currency` (CNY for the official
 * DeepSeek page) per **million** tokens.
 *
 * The peak/off-peak rule is the one the official page states and the sibling
 * `dsh-deepseek-peak-pricing` plugin already implements: Beijing time, Monday to
 * Friday, inside the configured minute-of-day windows, excluding statutory
 * holidays. Everything else is off-peak, and the off-peak price is half the peak
 * price. Because every session event carries its own timestamp, a session that
 * spanned a switch is priced per call rather than at one rate for the whole log.
 */

/** Beijing wall-clock offset from UTC. */
export const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/** Peak window key. */
export const PHASE_PEAK = 'peak'

/** Off-peak window key. */
export const PHASE_OFF_PEAK = 'offPeak'

/**
 * Bundled offline price table — the official DeepSeek page as this plugin ships.
 *
 * It is only the fallback: when the sibling peak-pricing plugin has synced the
 * official page into `storages/`, the Host half prefers that live snapshot so
 * both plugins quote one table. `fetchedAt: 0` marks it as never fetched.
 */
export const BUNDLED_PRICING = {
  source: 'bundled',
  sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  fetchedAt: 0,
  currency: 'CNY',
  unit: 'per_million_tokens',
  rules: {
    windows: [[540, 720], [840, 1080]],
    weekdays: [1, 2, 3, 4, 5],
    timeZone: 'Asia/Shanghai',
  },
  models: {
    'deepseek-flash': {
      name: 'deepseek-flash',
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
      offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    },
    'deepseek-v4-pro': {
      name: 'deepseek-v4-pro',
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
      offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    },
  },
}

/** Zero-pad one date component. */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * Break one instant into Beijing wall-clock parts.
 * @param {number} atMs - epoch milliseconds.
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, weekday: number, dateKey: string, minutesOfDay: number}} the parts; `weekday` is ISO (1=Monday … 7=Sunday).
 */
export function beijingParts(atMs) {
  const local = new Date(atMs + BEIJING_OFFSET_MS)
  const year = local.getUTCFullYear()
  const month = local.getUTCMonth() + 1
  const day = local.getUTCDate()
  const hour = local.getUTCHours()
  const minute = local.getUTCMinutes()
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: local.getUTCDay() === 0 ? 7 : local.getUTCDay(),
    dateKey: `${year}-${pad(month)}-${pad(day)}`,
    minutesOfDay: hour * 60 + minute,
  }
}

/**
 * Coerce a finite number, or return the fallback.
 * @param {unknown} value - the raw value.
 * @param {number} fallback - used when the value is not a finite number.
 * @returns {number} the number.
 */
function numberOf(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Read one three-bucket rate out of either naming convention the official page
 * and its parsers use.
 * @param {unknown} raw - the rate object.
 * @returns {{cacheHit: number, cacheMiss: number, output: number}|null} the rate, or null when the object carries no usable numbers.
 */
export function readRate(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const miss = raw.cacheMiss ?? raw.inputCacheMiss ?? raw.input
  if (miss === undefined && raw.cacheHit === undefined && raw.output === undefined) return null
  const cacheMiss = numberOf(miss, 0)
  return {
    // A table that names only the miss price means "cache hits are not billed separately".
    cacheHit: numberOf(raw.cacheHit ?? raw.inputCacheHit ?? raw.cachedInput ?? raw.cacheRead, cacheMiss),
    cacheMiss,
    output: numberOf(raw.output, 0),
  }
}

/**
 * Normalize any accepted price-table shape into the internal one.
 *
 * Accepted: this plugin's bundled shape (`models` keyed by model id) and the
 * sibling `dsh-deepseek-peak-pricing` snapshot shape (`models` as an array of
 * `{ key, name, peak: { inputCacheHit … }, offPeak }` plus `rules`).
 * @param {unknown} raw - the candidate table.
 * @returns {{source: string, sourceUrl: string, fetchedAt: number, currency: string, unit: string, rules: {windows: number[][], weekdays: number[], timeZone: string}, models: Record<string, {name: string, peak: object, offPeak: object}>}|null} the normalized table, or null when nothing usable was found.
 */
export function normalizePricing(raw) {
  if (raw === null || typeof raw !== 'object') return null
  // Callers that know where the table came from (`loadPricing`) set this; a bare
  // table is honestly "unknown" rather than silently labelled as something.
  const source = typeof raw.source === 'string' && raw.source !== '' ? raw.source : 'unknown'
  const models = {}
  const list = Array.isArray(raw.models)
    ? raw.models
    : raw.models !== null && typeof raw.models === 'object' ? Object.entries(raw.models).map(([key, value]) => ({ key, ...value })) : []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const peak = readRate(entry.peak)
    const offPeak = readRate(entry.offPeak) ?? peak
    // A flat table (no peak/off-peak split) uses the same rate for both phases.
    const flat = peak === null ? readRate(entry) : null
    const resolvedPeak = peak ?? flat
    if (resolvedPeak === null) continue
    const key = typeof entry.key === 'string' && entry.key !== '' ? entry.key : String(entry.name ?? '')
    if (key === '') continue
    models[key] = {
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : key,
      peak: resolvedPeak,
      offPeak: offPeak ?? resolvedPeak,
    }
  }
  if (Object.keys(models).length === 0) return null
  const rawRules = raw.rules !== null && typeof raw.rules === 'object' ? raw.rules : {}
  const windows = Array.isArray(rawRules.windows)
    ? rawRules.windows
      .filter(window => Array.isArray(window) && window.length >= 2)
      .map(window => [numberOf(window[0], 0), numberOf(window[1], 0)])
      .filter(window => window[1] > window[0])
    : []
  const weekdays = Array.isArray(rawRules.weekdays)
    ? rawRules.weekdays.map(value => numberOf(value, 0)).filter(value => value >= 1 && value <= 7)
    : []
  return {
    source,
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : '',
    fetchedAt: numberOf(raw.fetchedAt, 0),
    currency: typeof raw.currency === 'string' && raw.currency !== '' ? raw.currency : 'CNY',
    unit: typeof raw.unit === 'string' ? raw.unit : 'per_million_tokens',
    rules: {
      windows: windows.length > 0 ? windows : BUNDLED_PRICING.rules.windows,
      weekdays: weekdays.length > 0 ? weekdays : BUNDLED_PRICING.rules.weekdays,
      timeZone: typeof rawRules.timeZone === 'string' ? rawRules.timeZone : 'Asia/Shanghai',
    },
    models,
  }
}

/**
 * Classify one instant as peak or off-peak.
 * @param {number} atMs - epoch milliseconds of the billed call.
 * @param {object} pricing - a normalized price table.
 * @param {Iterable<string>} [holidays] - Beijing `YYYY-MM-DD` statutory holidays, off-peak all day.
 * @returns {'peak'|'offPeak'} the phase.
 */
export function phaseAt(atMs, pricing, holidays) {
  const rules = pricing !== null && pricing !== undefined ? pricing.rules : BUNDLED_PRICING.rules
  const parts = beijingParts(atMs)
  if (holidays !== undefined && holidays !== null) {
    for (const day of holidays) {
      if (day === parts.dateKey) return PHASE_OFF_PEAK
    }
  }
  if (!rules.weekdays.includes(parts.weekday)) return PHASE_OFF_PEAK
  for (const [start, end] of rules.windows) {
    // A window that wraps past midnight is compared the same way the sibling does.
    if (start < end ? parts.minutesOfDay >= start && parts.minutesOfDay < end : parts.minutesOfDay >= start || parts.minutesOfDay < end) {
      return PHASE_PEAK
    }
  }
  return PHASE_OFF_PEAK
}

/**
 * Epoch milliseconds of a Beijing wall-clock minute on a day offset from `atMs`.
 * @param {number} atMs - any instant.
 * @param {number} dayOffset - whole days added to `atMs`'s Beijing day.
 * @param {number} minutesOfDay - minutes since Beijing midnight.
 * @returns {number} epoch milliseconds.
 */
function beijingMinuteAt(atMs, dayOffset, minutesOfDay) {
  const parts = beijingParts(atMs)
  return Date.UTC(parts.year, parts.month - 1, parts.day) - BEIJING_OFFSET_MS
    + dayOffset * 86400000 + minutesOfDay * 60000
}

/**
 * Describe the phase now and when it next changes.
 *
 * The phase is a step function whose only discontinuities are the configured
 * window boundaries and Beijing midnight (where the weekday and the holiday
 * date change), so scanning just those instants is exact — no polling.
 * @param {number} atMs - the instant to describe.
 * @param {object} pricing - a normalized price table.
 * @param {Iterable<string>} [holidays] - Beijing `YYYY-MM-DD` statutory holidays.
 * @returns {{phase: 'peak'|'offPeak', nextPhase: 'peak'|'offPeak', phaseEndsAt: number|null, remainingMs: number|null}} the description; `phaseEndsAt` is null when no change was found within the scan horizon.
 */
export function describePhase(atMs, pricing, holidays) {
  const rules = pricing !== null && pricing !== undefined ? pricing.rules : BUNDLED_PRICING.rules
  const phase = phaseAt(atMs, pricing, holidays)
  const candidates = new Set()
  for (let offset = 0; offset <= 8; offset += 1) {
    candidates.add(beijingMinuteAt(atMs, offset, 0))
    for (const [start, end] of rules.windows) {
      candidates.add(beijingMinuteAt(atMs, offset, start))
      candidates.add(beijingMinuteAt(atMs, offset, end))
    }
  }
  let changeAt = null
  for (const candidate of [...candidates].sort((left, right) => left - right)) {
    if (candidate <= atMs) continue
    if (phaseAt(candidate, pricing, holidays) !== phase) {
      changeAt = candidate
      break
    }
  }
  return {
    phase,
    nextPhase: phase === PHASE_PEAK ? PHASE_OFF_PEAK : PHASE_PEAK,
    phaseEndsAt: changeAt,
    remainingMs: changeAt === null ? null : changeAt - atMs,
  }
}

/**
 * Normalize a model id for tolerant lookup.
 * @param {unknown} value - the raw id.
 * @returns {string} lowercase alphanumerics, with a trailing date or version stamp removed.
 */
export function normalizeModelKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[-@]\d{4}-?\d{2}-?\d{2}$/, '')
    .replace(/[-@]v\d+(\.\d+)*$/, '')
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * Find the price entry for one provider/model pair.
 *
 * Exact model id first, then the normalized match, then the model id alone
 * ignoring the provider — a table keyed only by model id still prices a
 * `provider:model` route.
 * @param {object} pricing - a normalized price table.
 * @param {string} provider - the route provider id.
 * @param {string} model - the route model id.
 * @returns {{key: string, name: string, peak: object, offPeak: object}|null} the entry, or null when unpriced.
 */
export function findPrice(pricing, provider, model) {
  if (pricing === null || pricing === undefined) return null
  const models = pricing.models ?? {}
  const direct = models[model]
  if (direct !== undefined) return { key: model, ...direct }
  const normalized = normalizeModelKey(model)
  if (normalized !== '') {
    for (const [key, entry] of Object.entries(models)) {
      if (normalizeModelKey(key) === normalized) return { key, ...entry }
    }
  }
  const qualified = `${provider}:${model}`
  const exactQualified = models[qualified]
  if (exactQualified !== undefined) return { key: qualified, ...exactQualified }
  return null
}

/**
 * Price one usage sample, keeping the four buckets apart.
 *
 * `inputTokens` is the cache-miss prompt side (the token-meter projection folds
 * it as `uncachedInputTokens`), so the three prompt buckets are disjoint exactly
 * as the provider bills them. Reasoning tokens are reported but not charged:
 * every adapter this plugin has seen already counts them inside output.
 * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} usage - provider-reported usage.
 * @param {{peak: object, offPeak: object}|null} entry - the price entry.
 * @param {'peak'|'offPeak'} phase - the phase the call billed at.
 * @returns {{cacheMiss: number, cacheHit: number, cacheWrite: number, output: number, total: number}} the cost in the table's currency.
 */
export function costBreakdownOf(usage, entry, phase) {
  const zero = { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0 }
  if (entry === null || entry === undefined) return zero
  const rate = phase === PHASE_PEAK ? entry.peak : entry.offPeak
  const cacheMiss = Math.max(0, numberOf(usage?.inputTokens, 0)) * rate.cacheMiss
  const cacheHit = Math.max(0, numberOf(usage?.cacheReadTokens, 0)) * rate.cacheHit
  // A cache write is charged at the miss rate unless the table prices it apart.
  const cacheWrite = Math.max(0, numberOf(usage?.cacheWriteTokens, 0)) * (rate.cacheWrite ?? rate.cacheMiss)
  const output = Math.max(0, numberOf(usage?.outputTokens, 0)) * rate.output
  return {
    cacheMiss: cacheMiss / 1e6,
    cacheHit: cacheHit / 1e6,
    cacheWrite: cacheWrite / 1e6,
    output: output / 1e6,
    total: (cacheMiss + cacheHit + cacheWrite + output) / 1e6,
  }
}

/**
 * Price one usage sample.
 * @param {object} usage - provider-reported usage.
 * @param {{peak: object, offPeak: object}|null} entry - the price entry.
 * @param {'peak'|'offPeak'} phase - the phase the call billed at.
 * @returns {number} the cost in the table's currency.
 */
export function costOfUsage(usage, entry, phase) {
  return costBreakdownOf(usage, entry, phase).total
}

/** An empty per-model accumulator. */
function emptyModel(provider, model, label) {
  return {
    provider,
    model,
    label,
    calls: 0,
    priced: 0,
    unpriced: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    peakTokens: 0,
    offPeakTokens: 0,
    peakCalls: 0,
    offPeakCalls: 0,
    cost: 0,
    /** Cost split by billing bucket, so the panel can price each row. */
    costByBucket: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 },
  }
}

/** Add one cost breakdown onto a bucket accumulator. */
function addBuckets(target, breakdown) {
  target.cacheMiss += breakdown.cacheMiss
  target.cacheHit += breakdown.cacheHit
  target.cacheWrite += breakdown.cacheWrite
  target.output += breakdown.output
}

/**
 * Fold one session's events into per-model and whole-session cost.
 *
 * Only `assistant/message` events carry provider usage; every other event is
 * ignored. Each call is priced at the phase of its own timestamp, so a session
 * that crossed a peak switch reports the mixed total it actually billed.
 * @param {readonly object[]} events - session events in ascending seq order.
 * @param {{pricing: object, holidays?: Iterable<string>}} options - the price table and optional holiday list.
 * @returns {object} the fold result.
 */
export function foldSession(events, options) {
  const pricing = options?.pricing ?? null
  const holidays = options?.holidays ?? null
  const models = new Map()
  const totals = {
    calls: 0,
    callsWithUsage: 0,
    unpricedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    peakCalls: 0,
    offPeakCalls: 0,
  }
  const costByBucket = { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 }
  let cost = 0
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
    const data = event.data ?? {}
    const usage = data.usage
    if (usage === null || typeof usage !== 'object') continue
    const source = data.message !== null && typeof data.message === 'object' ? data.message.source ?? {} : {}
    const provider = typeof source.provider === 'string' && source.provider !== '' ? source.provider : 'unknown'
    const model = typeof source.model === 'string' && source.model !== '' ? source.model : 'unknown'
    const label = `${provider} / ${model}`
    const key = label
    const entry = models.get(key) ?? emptyModel(provider, model, label)
    const price = findPrice(pricing, provider, model)
    const atMs = numberOf(event.time, 0)
    const phase = phaseAt(atMs, pricing, holidays)
    const breakdown = costBreakdownOf(usage, price, phase)
    const callCost = breakdown.total
    const callTokens = numberOf(usage.inputTokens, 0) + numberOf(usage.outputTokens, 0)
      + numberOf(usage.cacheReadTokens, 0) + numberOf(usage.cacheWriteTokens, 0)

    entry.calls += 1
    entry.inputTokens += numberOf(usage.inputTokens, 0)
    entry.outputTokens += numberOf(usage.outputTokens, 0)
    entry.cacheReadTokens += numberOf(usage.cacheReadTokens, 0)
    entry.cacheWriteTokens += numberOf(usage.cacheWriteTokens, 0)
    if (phase === PHASE_PEAK) {
      entry.peakTokens += callTokens
      entry.peakCalls += 1
    } else {
      entry.offPeakTokens += callTokens
      entry.offPeakCalls += 1
    }
    if (price === null) entry.unpriced += 1
    else entry.priced += 1
    entry.cost += callCost
    addBuckets(entry.costByBucket, breakdown)
    models.set(key, entry)

    totals.calls += 1
    totals.callsWithUsage += 1
    if (price === null) totals.unpricedCalls += 1
    totals.inputTokens += numberOf(usage.inputTokens, 0)
    totals.outputTokens += numberOf(usage.outputTokens, 0)
    totals.cacheReadTokens += numberOf(usage.cacheReadTokens, 0)
    totals.cacheWriteTokens += numberOf(usage.cacheWriteTokens, 0)
    if (phase === PHASE_PEAK) totals.peakCalls += 1
    else totals.offPeakCalls += 1
    addBuckets(costByBucket, breakdown)
    cost += callCost
  }
  // Prompt-side billing denominator: the three disjoint input buckets.
  const billedInput = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  const allTokens = billedInput + totals.outputTokens
  return {
    currency: pricing !== null && pricing !== undefined ? pricing.currency : BUNDLED_PRICING.currency,
    cost,
    totals: {
      ...totals,
      billedInputTokens: billedInput,
      totalTokens: allTokens,
      cacheHitRate: billedInput > 0 ? totals.cacheReadTokens / billedInput : null,
      peakCallShare: totals.calls > 0 ? totals.peakCalls / totals.calls : null,
      costByBucket,
    },
    models: [...models.values()].sort((left, right) => right.cost - left.cost || right.calls - left.calls),
  }
}
