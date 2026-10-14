/**
 * Pricing-core tests: the peak/off-peak rule, table normalization, price lookup
 * and the per-call session fold. Every expectation is derived from the official
 * rule and the published rate table, not from the implementation.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUNDLED_PRICING,
  PHASE_OFF_PEAK,
  PHASE_PEAK,
  beijingParts,
  costBreakdownOf,
  costOfUsage,
  describePhase,
  findPrice,
  foldSession,
  normalizeModelKey,
  normalizePricing,
  phaseAt,
  readRate,
} from '../lib/pricing.js'

/** Build one `assistant/message` event. */
function call(atIso, provider, model, usage) {
  return {
    type: 'assistant/message',
    seq: 1,
    time: Date.parse(atIso),
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider, model } },
      usage,
    },
  }
}

const PRICING = normalizePricing(BUNDLED_PRICING)

test('beijingParts reports the ISO weekday and Beijing wall clock', () => {
  // 2026-10-02 is a Friday; 05:17Z is 13:17 in Beijing.
  const parts = beijingParts(Date.parse('2026-10-02T05:17:48Z'))
  assert.equal(parts.dateKey, '2026-10-02')
  assert.equal(parts.weekday, 5)
  assert.equal(parts.hour, 13)
  assert.equal(parts.minute, 17)
  assert.equal(parts.minutesOfDay, 13 * 60 + 17)
  // Sunday is ISO 7, not 0.
  assert.equal(beijingParts(Date.parse('2026-10-04T02:00:00Z')).weekday, 7)
})

test('the peak windows are Beijing 09:00-12:00 and 14:00-18:00 on weekdays', () => {
  // Friday 2026-10-02, Beijing time.
  assert.equal(phaseAt(Date.parse('2026-10-02T00:59:00Z'), PRICING), PHASE_OFF_PEAK) // 08:59
  assert.equal(phaseAt(Date.parse('2026-10-02T01:00:00Z'), PRICING), PHASE_PEAK) // 09:00
  assert.equal(phaseAt(Date.parse('2026-10-02T03:59:00Z'), PRICING), PHASE_PEAK) // 11:59
  assert.equal(phaseAt(Date.parse('2026-10-02T04:00:00Z'), PRICING), PHASE_OFF_PEAK) // 12:00
  assert.equal(phaseAt(Date.parse('2026-10-02T05:59:00Z'), PRICING), PHASE_OFF_PEAK) // 13:59
  assert.equal(phaseAt(Date.parse('2026-10-02T06:00:00Z'), PRICING), PHASE_PEAK) // 14:00
  assert.equal(phaseAt(Date.parse('2026-10-02T09:59:00Z'), PRICING), PHASE_PEAK) // 17:59
  assert.equal(phaseAt(Date.parse('2026-10-02T10:00:00Z'), PRICING), PHASE_OFF_PEAK) // 18:00
  // The weekend is off-peak all day, including inside a peak window.
  assert.equal(phaseAt(Date.parse('2026-10-03T02:00:00Z'), PRICING), PHASE_OFF_PEAK) // Saturday 10:00
  assert.equal(phaseAt(Date.parse('2026-10-04T06:00:00Z'), PRICING), PHASE_OFF_PEAK) // Sunday 14:00
})

test('a configured statutory holiday is off-peak all day', () => {
  const holidays = ['2026-10-02']
  assert.equal(phaseAt(Date.parse('2026-10-02T02:00:00Z'), PRICING, holidays), PHASE_OFF_PEAK)
  // A different day is unaffected.
  assert.equal(phaseAt(Date.parse('2026-10-05T02:00:00Z'), PRICING, holidays), PHASE_PEAK)
})

test('describePhase finds the exact switch instant, not an approximation', () => {
  // Friday 13:17 Beijing — inside the midday gap; the peak window reopens at 14:00.
  const described = describePhase(Date.parse('2026-10-02T05:17:48Z'), PRICING, [])
  assert.equal(described.phase, PHASE_OFF_PEAK)
  assert.equal(described.nextPhase, PHASE_PEAK)
  assert.equal(new Date(described.phaseEndsAt).toISOString(), '2026-10-02T06:00:00.000Z')
  assert.equal(described.remainingMs, Date.parse('2026-10-02T06:00:00Z') - Date.parse('2026-10-02T05:17:48Z'))
  // Inside the peak window the next switch is its end.
  const peak = describePhase(Date.parse('2026-10-02T01:30:00Z'), PRICING, [])
  assert.equal(peak.phase, PHASE_PEAK)
  assert.equal(new Date(peak.phaseEndsAt).toISOString(), '2026-10-02T04:00:00.000Z')
  // Saturday 13:00 Beijing: nothing changes at midnight, because Sunday is
  // off-peak too — the next change is Monday's 09:00 peak window.
  const weekend = describePhase(Date.parse('2026-10-03T05:00:00Z'), PRICING, [])
  assert.equal(weekend.phase, PHASE_OFF_PEAK)
  assert.equal(new Date(weekend.phaseEndsAt).toISOString(), '2026-10-05T01:00:00.000Z')
  // Sunday 14:00 Beijing is inside a peak window by the clock but off-peak by
  // the weekday rule, and it stays off-peak until Monday 09:00.
  const sunday = describePhase(Date.parse('2026-10-04T06:00:00Z'), PRICING, [])
  assert.equal(sunday.phase, PHASE_OFF_PEAK)
  assert.equal(new Date(sunday.phaseEndsAt).toISOString(), '2026-10-05T01:00:00.000Z')
  // A holiday inside the working week runs off-peak until the next day's window.
  const holiday = describePhase(Date.parse('2026-10-02T02:00:00Z'), PRICING, ['2026-10-02'])
  assert.equal(holiday.phase, PHASE_OFF_PEAK)
  assert.equal(new Date(holiday.phaseEndsAt).toISOString(), '2026-10-05T01:00:00.000Z')
})

test('readRate accepts both naming conventions and defaults a missing hit rate', () => {
  assert.deepEqual(readRate({ inputCacheHit: 0.04, inputCacheMiss: 2, output: 8 }), { cacheHit: 0.04, cacheMiss: 2, output: 8 })
  assert.deepEqual(readRate({ cacheHit: 1, cacheMiss: 2, output: 3 }), { cacheHit: 1, cacheMiss: 2, output: 3 })
  // A table naming only the miss price bills cache hits at that price.
  assert.deepEqual(readRate({ cacheMiss: 5, output: 1 }), { cacheHit: 5, cacheMiss: 5, output: 1 })
  assert.equal(readRate(null), null)
  assert.equal(readRate({}), null)
})

test('normalizePricing reads the sibling snapshot shape', () => {
  const sibling = {
    schemaVersion: 1,
    sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    fetchedAt: 1790913353829,
    currency: 'CNY',
    models: [
      { name: 'deepseek-flash', key: 'deepseek-flash', peak: { inputCacheHit: 0.04, inputCacheMiss: 2, output: 8 }, offPeak: { inputCacheHit: 0.02, inputCacheMiss: 1, output: 4 } },
    ],
    rules: { windows: [[540, 720], [840, 1080]], weekdays: [1, 2, 3, 4, 5], timeZone: 'Asia/Shanghai' },
  }
  const normalized = normalizePricing(sibling)
  assert.equal(normalized.currency, 'CNY')
  assert.equal(normalized.fetchedAt, 1790913353829)
  assert.deepEqual(normalized.rules.windows, [[540, 720], [840, 1080]])
  assert.deepEqual(normalized.models['deepseek-flash'].peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 })
  assert.deepEqual(normalized.models['deepseek-flash'].offPeak, { cacheHit: 0.02, cacheMiss: 1, output: 4 })
  // A flat table reuses one rate for both phases.
  const flat = normalizePricing({ models: { m: { cacheMiss: 3, cacheHit: 1, output: 6 } } })
  assert.deepEqual(flat.models.m.peak, flat.models.m.offPeak)
  // Garbage yields null rather than a half-built table.
  assert.equal(normalizePricing({ models: [] }), null)
  assert.equal(normalizePricing(null), null)
})

test('findPrice matches exactly, then by normalized id, then by qualified key', () => {
  assert.equal(findPrice(PRICING, 'deepseek-official', 'deepseek-flash').key, 'deepseek-flash')
  // A dated or versioned route still finds the undated table row.
  assert.equal(findPrice(PRICING, 'deepseek-official', 'deepseek-flash-2026-08-22').key, 'deepseek-flash')
  assert.equal(normalizeModelKey('DeepSeek-V4-Pro@v1.2'), 'deepseekv4pro')
  // A table keyed `provider:model` is found through the qualified key.
  const qualified = normalizePricing({ models: { 'vendor-x:model-y': { cacheMiss: 1, cacheHit: 0, output: 2 } } })
  assert.equal(findPrice(qualified, 'vendor-x', 'model-y').key, 'vendor-x:model-y')
  assert.equal(findPrice(PRICING, 'other', 'unknown-model'), null)
})

test('costBreakdownOf charges each bucket at its own rate', () => {
  const entry = { peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }, offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 } }
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }
  assert.deepEqual(costBreakdownOf(usage, entry, PHASE_OFF_PEAK), {
    cacheMiss: 1,
    cacheHit: 0.02,
    cacheWrite: 0,
    output: 4,
    total: 5.02,
  })
  assert.deepEqual(costBreakdownOf(usage, entry, PHASE_PEAK), {
    cacheMiss: 2,
    cacheHit: 0.04,
    cacheWrite: 0,
    output: 8,
    total: 10.04,
  })
  // An unpriced route costs nothing rather than throwing.
  assert.equal(costOfUsage(usage, null, PHASE_PEAK), 0)
  // A cache write bills at the miss rate unless the table prices it separately.
  const withWrite = { peak: { cacheHit: 0.1, cacheMiss: 2, output: 4, cacheWrite: 0.5 }, offPeak: { cacheHit: 0.1, cacheMiss: 2, output: 4, cacheWrite: 0.5 } }
  assert.equal(costBreakdownOf({ cacheWriteTokens: 1_000_000 }, withWrite, PHASE_PEAK).cacheWrite, 0.5)
})

test('foldSession prices every call at the phase of its own instant', () => {
  const events = [
    // 2026-10-02 10:00 Beijing — peak.
    call('2026-10-02T02:00:00Z', 'deepseek-official', 'deepseek-flash', {
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
    // 2026-10-02 13:00 Beijing — off-peak.
    call('2026-10-02T05:00:00Z', 'deepseek-official', 'deepseek-flash', {
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
    // Ignored: not an assistant message.
    { type: 'turn/start', seq: 3, time: Date.parse('2026-10-02T05:00:00Z'), data: { turn: 1 } },
    // Ignored: no provider usage recorded.
    { type: 'assistant/message', seq: 4, time: Date.parse('2026-10-02T05:00:00Z'), data: { message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } } } },
  ]
  const fold = foldSession(events, { pricing: PRICING, holidays: [] })
  // 1M miss tokens at peak (2.0) + 1M miss tokens off-peak (1.0).
  assert.equal(Math.round(fold.cost * 1e6) / 1e6, 3)
  assert.equal(fold.totals.calls, 2)
  assert.equal(fold.totals.peakCalls, 1)
  assert.equal(fold.totals.offPeakCalls, 1)
  assert.equal(fold.totals.inputTokens, 2_000_000)
  assert.equal(fold.totals.totalTokens, 2_000_000)
  assert.equal(fold.totals.unpricedCalls, 0)
  assert.equal(fold.models.length, 1)
  assert.equal(fold.models[0].label, 'deepseek-official / deepseek-flash')
  assert.equal(fold.models[0].peakTokens, 1_000_000)
  assert.equal(fold.models[0].offPeakTokens, 1_000_000)
  assert.equal(Math.round(fold.models[0].costByBucket.cacheMiss * 1e6) / 1e6, 3)
})

test('foldSession reports the cache-hit rate over the three input buckets', () => {
  const fold = foldSession([
    call('2026-10-02T05:00:00Z', 'deepseek-official', 'deepseek-flash', {
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0,
    }),
  ], { pricing: PRICING, holidays: [] })
  // 900 hits of 1000 prompt-side tokens.
  assert.equal(fold.totals.cacheHitRate, 0.9)
  assert.equal(fold.totals.billedInputTokens, 1000)
  assert.equal(fold.totals.totalTokens, 1050)
  // 100 * 1 + 900 * 0.02 + 50 * 4 = 100 + 18 + 200 = 318 per million.
  assert.equal(Math.round(fold.cost * 1e6) / 1e6, 318 / 1e6)
})

test('foldSession counts an unpriced model without inventing a cost', () => {
  const fold = foldSession([
    call('2026-10-02T05:00:00Z', 'mystery-vendor', 'mystery-model', { inputTokens: 5_000, outputTokens: 100 }),
  ], { pricing: PRICING, holidays: [] })
  assert.equal(fold.cost, 0)
  assert.equal(fold.totals.unpricedCalls, 1)
  assert.equal(fold.models[0].unpriced, 1)
  assert.equal(fold.models[0].priced, 0)
  // The tokens are still reported, so the panel can say "unpriced" honestly.
  assert.equal(fold.totals.totalTokens, 5_100)
})

test('foldSession on an empty log is a well-formed zero', () => {
  const fold = foldSession([], { pricing: PRICING, holidays: [] })
  assert.equal(fold.cost, 0)
  assert.equal(fold.totals.totalTokens, 0)
  assert.equal(fold.totals.cacheHitRate, null)
  assert.deepEqual(fold.models, [])
})
