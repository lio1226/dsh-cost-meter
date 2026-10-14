/**
 * Client half of the session-cost plugin.
 *
 * This file IS the built browser bundle: DSH serves each plugin's `./client`
 * export straight to the page, so it is authored in the module-loader factory
 * format (`window.__ModuleLoader__.load({ id, factory })`) rather than as an ES
 * module. The only external it resolves is `react`, which the shell seeds in its
 * baseline module table — no build step, no third-party UI dependency, and no
 * import of any Harness Client package.
 *
 * It contributes one entry to `conversation.composer.dock` — the ambient row
 * below the composer card that already carries the host's token-total/cache-hit
 * pill and its timing pill — showing the current conversation's cost. Clicking
 * it opens a panel with the priced breakdown per model and phase, and the
 * account balance.
 *
 * The browser never parses a session log and never sees an API key: it asks the
 * Host half at `/cost-meter/api/state?sessionId=…` and renders the answer. The
 * `tokenUsage` slot projection is used as a cheap change signal — when the
 * session's token totals move, the cost is worth re-reading — not as the source
 * of the price, because the projection cannot attribute tokens to a model or to
 * a peak/off-peak phase.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cost-meter',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    // `react-dom` is one of the shell's seed modules, so a plugin bundle may take
    // it from the module table without shipping its own copy. Only the portal is
    // used: the host's own dock pills open their detail panel the same way.
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Routes owned by the host half. */
    const API_STATE = '/cost-meter/api/state'
    const API_REFRESH = '/cost-meter/api/refresh'

    /** Injected stylesheet element id, so re-activation cannot double-inject. */
    const STYLE_ID = 'dsh-cost-meter-style'

    /** Locale namespace this half registers its copy under. */
    const NS = 'dsh-cost-meter'

    /** How long the panel may sit idle before it re-reads the session. */
    const DEFAULT_POLL_SECONDS = 15

    /** Wait this long after the projection moves before asking again. */
    const PROJECTION_DEBOUNCE_MS = 1200

    /** Gap between the pill and the panel, in pixels. */
    const PANEL_GAP = 8

    /** Bilingual copy. Flat `key: string` pairs only — the locale service takes a dict. */
    const DICT = {
      zh: {
        title: '会话费用',
        pillTip: '当前对话费用，点开查看分项费用与余额',
        pillLoading: '¥…',
        loading: '正在读取…',
        loadFailed: '读取失败',
        noSession: '当前没有会话',
        noUsage: '本会话还没有产生用量',
        cacheMiss: '输入 · 缓存未命中',
        cacheHit: '输入 · 缓存命中',
        cacheWrite: '输入 · 缓存写入',
        output: '输出',
        total: '合计',
        tokens: 'tokens',
        cacheHitRate: '缓存命中率',
        callsAndTurns: '{calls} 次调用 · {turns} 轮',
        priced: '已计价',
        unpriced: '{count} 次调用未匹配价格表',
        byModel: '按模型计价',
        modelCalls: '{calls} 次',
        phasePeak: '高峰',
        phaseOffPeak: '谷时',
        phaseNow: '当前时段 {phase}',
        switchIn: '距切换 {time}',
        phaseDetail: '谷时价为高峰价的一半',
        balance: '账户余额',
        bonus: '赠送',
        toppedUp: '充值',
        balanceUpdated: '更新于 {time}',
        balanceNotQueried: '尚未查询余额',
        balanceOff: '余额查询已在 config.json 中关闭',
        balanceUnconfigured: '未登录 DeepSeek 账户，且未设置 {name}',
        balanceFailed: '余额查询失败',
        balanceStale: '刷新失败，显示上次结果',
        refresh: '刷新',
        refreshing: '刷新中…',
        close: '关闭',
        pricingFromOfficial: '官方页面',
        pricingFromBundled: '内置兜底表',
        pricingFromConfig: 'config.json 覆盖',
        pricingLine: '价格表 {source}{updated}',
        pricingUpdated: ' · 更新于 {time}',
        pricingNever: '',
        holidayNote: '节假日表 {count} 天',
        disclaimer: '每次调用按其发生时刻计价（高峰 / 谷时）。',
        minutes: '分',
        seconds: '秒',
        hours: '小时',
        exact: '精确值',
      },
      en: {
        title: 'Session cost',
        pillTip: 'Cost of this conversation — click for the breakdown and balance',
        pillLoading: '¥…',
        loading: 'Reading…',
        loadFailed: 'Could not read',
        noSession: 'No session',
        noUsage: 'This session has no usage yet',
        cacheMiss: 'Input · cache miss',
        cacheHit: 'Input · cache hit',
        cacheWrite: 'Input · cache write',
        output: 'Output',
        total: 'Total',
        tokens: 'tokens',
        cacheHitRate: 'Cache hit rate',
        callsAndTurns: '{calls} calls · {turns} turns',
        priced: 'priced',
        unpriced: '{count} calls without a price',
        byModel: 'Priced by model',
        modelCalls: '{calls} calls',
        phasePeak: 'Peak',
        phaseOffPeak: 'Off-peak',
        phaseNow: 'Billing {phase}',
        switchIn: 'switches in {time}',
        phaseDetail: 'the off-peak rate is half the peak rate',
        balance: 'Account balance',
        bonus: 'granted',
        toppedUp: 'topped up',
        balanceUpdated: 'updated {time}',
        balanceNotQueried: 'Balance not queried yet',
        balanceOff: 'Balance queries are disabled in config.json',
        balanceUnconfigured: 'Not signed in to a DeepSeek account, and {name} is not set',
        balanceFailed: 'Balance query failed',
        balanceStale: 'refresh failed — showing the last result',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        close: 'Close',
        pricingFromOfficial: 'official page',
        pricingFromBundled: 'bundled fallback',
        pricingFromConfig: 'config.json override',
        pricingLine: 'Price table: {source}{updated}',
        pricingUpdated: ' · updated {time}',
        pricingNever: '',
        holidayNote: '{count} holiday days',
        disclaimer: 'Every call is priced at the moment it happened (peak / off-peak).',
        minutes: 'm',
        seconds: 's',
        hours: 'h',
        exact: 'exact',
      },
    }

    /**
     * Stylesheet. Every colour is a DSH theme token so the entry follows light
     * and dark; the pill markup and metrics mirror the host's own dock pill
     * (`StatsPills`) and its detail panel (`stat-dialog`) so the two sit together
     * without a visible seam. The tokens are taken bare, exactly as the host's own
     * stylesheet takes them — a renamed token degrades the appearance rather than
     * breaking the entry, and a fallback literal would freeze a colour that the
     * theme is supposed to own.
     */
    const CSS = `
.dcm-root{box-sizing:border-box;min-width:0;max-width:100%;display:inline-flex}
.dcm-pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;
  border:0;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);
  font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));
  font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}
.dcm-pill svg{flex:none;width:14px;height:14px}
.dcm-pill:hover,.dcm-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dcm-pill[data-state="error"]{color:var(--dsw-alias-state-error-primary)}
.dcm-pill[data-state="loading"]{color:var(--dsw-alias-label-tertiary)}
.dcm-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dcm-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(352px,100vw - 24px);
  max-height:min(70vh,560px);overflow:auto;padding:12px 14px;border-radius:var(--dsw-radius-lg);
  background:var(--dsw-specific-menu);color:var(--dsw-alias-label-secondary);
  backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);
  font-size:12px;line-height:18px;text-align:left}
.dcm-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}
.dcm-title{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-weight:500}
.dcm-title svg{flex:none;width:14px;height:14px}
.dcm-total{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.dcm-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin:8px 0 10px}
.dcm-phase{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.dcm-chip{border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500}
.dcm-chip[data-phase="peak"]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.dcm-chip[data-phase="offPeak"]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.dcm-muted{color:var(--dsw-alias-label-tertiary)}
.dcm-rows{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px 12px;margin:0}
.dcm-rows dt,.dcm-rows dd{margin:0;min-width:0}
.dcm-rows dt{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcm-rows dd{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dcm-rows dd.dcm-tok{color:var(--dsw-alias-label-tertiary)}
.dcm-rows .dcm-sum{color:var(--dsw-alias-label-primary);font-weight:500}
.dcm-section{margin-top:12px}
.dcm-section-title{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-weight:500;margin-bottom:6px}
.dcm-section-title svg{flex:none;width:14px;height:14px}
.dcm-model{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:8px 10px;margin-bottom:6px}
.dcm-model-head{display:flex;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-primary)}
.dcm-model-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcm-model-meta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;margin-top:2px}
.dcm-model-cost{font-variant-numeric:tabular-nums;white-space:nowrap}
.dcm-balance{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.dcm-balance-amount{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.dcm-note{color:var(--dsw-alias-label-tertiary);margin:6px 0 0}
.dcm-warn{color:var(--dsw-alias-state-warn-primary)}
.dcm-err{color:var(--dsw-alias-state-error-primary)}
.dcm-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;
  padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dcm-foot-text{color:var(--dsw-alias-label-tertiary);min-width:0}
.dcm-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:0 0;
  color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);padding:2px 9px;
  font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.dcm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dcm-btn:disabled{opacity:.55;cursor:default}
`

    /** One shared store per session: the pill and the panel read the same fetch. */
    const stores = new Map()
    const listeners = new Set()
    const inFlight = new Map()

    /** The store record for one session (stable identity until it changes). */
    function storeOf(sessionId) {
      let store = stores.get(sessionId)
      if (store === undefined) {
        store = { status: 'idle', data: null, error: null, busy: false }
        stores.set(sessionId, store)
      }
      return store
    }

    /** Merge a patch into one session's store and notify every reader. */
    function setStore(sessionId, patch) {
      stores.set(sessionId, Object.assign({}, storeOf(sessionId), patch))
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-cost-meter] listener failed', error)
        }
      }
    }

    /**
     * Read this plugin's payload from the host, sharing one request per session
     * between the pill, the panel and any second instance of either.
     * @param {string} sessionId - the session to price.
     * @param {{refresh?: boolean}} [options] - `refresh` forces a re-fold and a balance refresh.
     * @returns {Promise<void>} resolution after the store settles.
     */
    function load(sessionId, options) {
      if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve()
      const refresh = options !== undefined && options.refresh === true
      const key = `${refresh ? 'r' : 'g'}:${sessionId}`
      const existing = inFlight.get(key)
      if (existing !== undefined) return existing
      const before = storeOf(sessionId)
      setStore(sessionId, { busy: true, error: null, status: before.data === null ? 'loading' : before.status })
      const query = `?sessionId=${encodeURIComponent(sessionId)}`
      const request = (async () => {
        try {
          const response = await fetch(refresh ? `${API_REFRESH}${query}` : `${API_STATE}${query}`, {
            method: refresh ? 'POST' : 'GET',
            headers: { accept: 'application/json' },
          })
          const body = await response.json().catch(() => null)
          if (body === null || body.ok !== true) {
            throw new Error(body !== null && body.error !== undefined ? body.error.message : `HTTP ${response.status}`)
          }
          setStore(sessionId, { status: 'ready', data: body.value, error: null, busy: false })
        } catch (error) {
          setStore(sessionId, {
            status: storeOf(sessionId).data === null ? 'error' : storeOf(sessionId).status,
            error: error instanceof Error ? error.message : String(error),
            busy: false,
          })
        }
      })().finally(() => {
        inFlight.delete(key)
      })
      inFlight.set(key, request)
      return request
    }

    /** Subscribe to store changes (the `useSyncExternalStore` contract). */
    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    /** Read one session's store reactively. */
    function useStore(sessionId) {
      const read = React.useCallback(() => storeOf(sessionId), [sessionId])
      return React.useSyncExternalStore(subscribe, read, read)
    }

    /** Interpolate `{name}` placeholders in one message. */
    function interpolate(text, params) {
      if (params === undefined || params === null) return text
      return String(text).replace(/\{(\w+)\}/g, (match, key) => {
        const value = params[key]
        return value === undefined || value === null ? match : String(value)
      })
    }

    /** Resolve the active UI language, preferring the locale service. */
    function detectLang(ctx) {
      try {
        const locale = typeof ctx?.get === 'function' ? ctx.get('locale') : undefined
        if (locale !== undefined && locale !== null) {
          const snapshot = typeof locale.getSnapshot === 'function'
            ? locale.getSnapshot()
            : typeof locale.getLocale === 'function' ? locale.getLocale() : null
          const id = typeof snapshot === 'string'
            ? snapshot
            : snapshot !== null && snapshot !== undefined ? snapshot.id ?? snapshot.locale ?? snapshot.active : null
          if (typeof id === 'string' && id !== '') return id.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
        }
      } catch {
        /* the browser language is a good enough fallback */
      }
      const navigatorLang = typeof navigator !== 'undefined' ? navigator.language ?? 'zh' : 'zh'
      return String(navigatorLang).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
    }

    /**
     * Build the translate function.
     *
     * The copy is registered with the Client locale service so it follows the
     * active language like any other plugin's, and a local table answers for any
     * key the service does not resolve — a component that threw here would blank
     * the dock entry.
     * @param {object} ctx - the client Cordis context.
     * @returns {(key: string, params?: object) => string} the translator.
     */
    function makeTranslate(ctx) {
      const locale = typeof ctx?.get === 'function' ? ctx.get('locale') : undefined
      if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
        try {
          locale.register(NS, { zh: DICT.zh, en: DICT.en })
        } catch {
          for (const lang of ['zh', 'en']) {
            try {
              locale.register(NS, lang, DICT[lang])
            } catch {
              /* the local table below still renders every key */
            }
          }
        }
      }
      const lang = detectLang(ctx)
      const local = (key, params) => interpolate(DICT[lang][key] ?? DICT.zh[key] ?? key, params)
      if (locale === undefined || locale === null || typeof locale.bind !== 'function') return local
      let bound = null
      try {
        const candidate = locale.bind(NS)
        if (typeof candidate === 'function') bound = candidate
      } catch {
        return local
      }
      if (bound === null) return local
      return (key, params) => {
        try {
          const value = bound(key, params)
          // An unresolved key comes back as the key itself; our own copy is better.
          if (typeof value === 'string' && value !== key) return interpolate(value, params)
        } catch {
          /* fall through to the local table */
        }
        return local(key, params)
      }
    }

    /** The currency symbol for one code. */
    function symbolOf(currency) {
      if (currency === 'CNY') return '¥'
      if (currency === 'USD') return '$'
      if (currency === 'EUR') return '€'
      return `${currency ?? ''} `
    }

    /**
     * Render a money amount. Small amounts keep their precision rather than
     * rounding a sub-cent session to `0.00`.
     * @param {unknown} value - the amount.
     * @param {object} display - the payload's display block.
     * @returns {string} the display string.
     */
    function money(value, display) {
      const amount = Number(value)
      const symbol = symbolOf(display?.currency)
      if (!Number.isFinite(amount)) return `${symbol}—`
      const decimals = Number.isFinite(display?.decimals) ? Number(display.decimals) : 4
      if (amount === 0) return `${symbol}${(0).toFixed(Math.min(decimals, 2))}`
      const places = amount > 0 && amount < Math.pow(10, -decimals) ? decimals + 2 : decimals
      const text = amount.toFixed(places).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
      return `${symbol}${text}`
    }

    /** Compact token count: `872`, `12.3K`, `5.28M`. */
    function tokens(value) {
      const count = Number(value)
      if (!Number.isFinite(count) || count < 0) return '—'
      if (count < 1000) return String(Math.round(count))
      if (count < 999500) return `${Math.round(count / 100) / 10}K`
      return `${Math.round(count / 10000) / 100}M`
    }

    /** Group-separated exact token count. */
    function exactTokens(value) {
      const count = Number(value)
      if (!Number.isFinite(count)) return '—'
      return Math.round(count).toLocaleString('en-US')
    }

    /** A share as a percentage, or an em dash when the denominator was zero. */
    function percent(rate) {
      const value = Number(rate)
      if (!Number.isFinite(value)) return '—'
      return `${(value * 100).toFixed(1)}%`
    }

    /**
     * Compact remaining time for the phase countdown.
     * @param {unknown} ms - remaining milliseconds.
     * @param {(key: string, params?: object) => string} t - the translator.
     * @returns {string} the label.
     */
    function remaining(ms, t) {
      const total = Number(ms)
      if (!Number.isFinite(total) || total <= 0) return '—'
      const seconds = Math.round(total / 1000)
      const hours = Math.floor(seconds / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      if (hours > 0) return `${hours}${t('hours')} ${minutes}${t('minutes')}`
      if (minutes > 0) return `${minutes}${t('minutes')}`
      return `${seconds}${t('seconds')}`
    }

    /** Render one timestamp as a local time, or an em dash. */
    function stamp(atMs) {
      const value = Number(atMs)
      if (!Number.isFinite(value) || value <= 0) return null
      try {
        return new Date(value).toLocaleTimeString()
      } catch {
        return null
      }
    }

    /** The balance glyph and the cost glyph, drawn from `currentColor`. */
    function IconCost() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 8.5, key: 'c' }),
        h('path', { d: 'M14.6 9.4a3.2 3.2 0 0 0-2.6-1.3c-1.5 0-2.6.8-2.6 2s1.1 1.8 2.6 2.2c1.5.4 2.6 1 2.6 2.2s-1.1 2-2.6 2a3.2 3.2 0 0 1-2.6-1.3', key: 's' }),
        h('path', { d: 'M12 6.4v11.2', key: 'b' }),
      )
    }

    /** The wallet glyph. */
    function IconWallet() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('rect', { x: 3, y: 6, width: 18, height: 13, rx: 3, key: 'r' }),
        h('path', { d: 'M3 10h13a2 2 0 0 1 0 4H3', key: 'p' }),
      )
    }

    /**
     * The composer dock entry: one pill plus, while open, its detail panel.
     * @param {{sessionId?: string, useProjection?: Function, ctx?: object}} props - the slot's standard props.
     * @returns {object|null} the React element, or null when there is no session to price.
     */
    function CostPill(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const t = props.t
      const store = useStore(sessionId)
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const warned = React.useRef(false)

      // A missing session id means this assembly did not hand the slot its
      // standard props. Stay visible with an explanation rather than silently
      // rendering nothing, and say so once in the console.
      const noSession = sessionId === ''
      React.useEffect(() => {
        if (!noSession || warned.current) return
        warned.current = true
        console.warn('[dsh-cost-meter] the composer dock slot provided no sessionId; the cost pill cannot price a session')
      }, [noSession])

      // The slot's own projection is the change signal: when the session's token
      // totals move, the priced fold is worth re-reading.
      const projection = typeof props.useProjection === 'function' ? props.useProjection('tokenUsage') : undefined
      const projectionTotal = projection === undefined || projection === null
        ? null
        : Number(projection.uncachedInputTokens ?? 0) + Number(projection.outputTokens ?? 0)
          + Number(projection.cacheReadTokens ?? 0) + Number(projection.cacheWriteTokens ?? 0)

      const data = store.data
      const pollSeconds = Number.isFinite(data?.display?.refreshSeconds) ? data.display.refreshSeconds : DEFAULT_POLL_SECONDS

      React.useEffect(() => {
        if (sessionId === '') return undefined
        void load(sessionId, {})
        const timer = setInterval(() => {
          // A hidden tab costs nothing; the composer is not being read.
          if (typeof document !== 'undefined' && document.hidden) return
          void load(sessionId, {})
        }, Math.max(5, pollSeconds) * 1000)
        return () => clearInterval(timer)
      }, [sessionId, pollSeconds])
      // Re-read shortly after the projection moves, coalescing a burst of turns.
      const lastProjection = React.useRef(projectionTotal)
      React.useEffect(() => {
        if (projectionTotal === null) return undefined
        if (lastProjection.current === projectionTotal) return undefined
        lastProjection.current = projectionTotal
        const timer = setTimeout(() => void load(sessionId, {}), PROJECTION_DEBOUNCE_MS)
        return () => clearTimeout(timer)
      }, [projectionTotal, sessionId])

      // Re-measure the anchor while the panel is open: the composer moves when the
      // window resizes, the sidebar toggles, or the transcript grows.
      React.useLayoutEffect(() => {
        if (!open) {
          setAnchor(null)
          return undefined
        }
        const measure = () => {
          const rect = buttonRef.current !== null ? buttonRef.current.getBoundingClientRect() : null
          if (rect === null) return
          setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + PANEL_GAP })
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [open])

      // Dismiss on Escape or on a press outside both the pill and the panel.
      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onPointerDown = (event) => {
          const target = event.target
          if (panelRef.current !== null && panelRef.current.contains(target)) return
          if (buttonRef.current !== null && buttonRef.current.contains(target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open])

      const session = data?.session ?? null
      const failed = store.status === 'error' && data === null
      const amount = session !== null && session.ok === true ? session.cost : null
      const label = noSession
        ? '—'
        : amount === null
          ? (failed ? t('loadFailed') : t('pillLoading'))
          : money(amount, { ...data?.display, currency: session.currency ?? data?.display?.currency })
      const state = noSession ? 'error' : failed ? 'error' : data === null ? 'loading' : 'ready'

      const pill = h(
        'button',
        {
          ref: buttonRef,
          type: 'button',
          className: 'dcm-pill',
          'data-state': state,
          title: store.error !== null && failed ? `${t('loadFailed')}: ${store.error}` : t('pillTip'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': `${t('title')} ${label}`,
          onClick: () => setOpen(value => !value),
        },
        h(IconCost, { key: 'icon' }),
        h('span', { className: 'dcm-label', key: 'label' }, label),
      )

      if (!open) return h('span', { className: 'dcm-root' }, pill)

      // Clamp the panel inside the viewport, opening upward from the pill.
      const width = Math.min(352, window.innerWidth - 24)
      const left = anchor === null ? 12 : Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))
      const bottom = anchor === null ? 80 : Math.max(8, Math.min(anchor.bottom, window.innerHeight - 120))
      const style = anchor === null
        ? { left: '-9999px', bottom: 0, visibility: 'hidden', width: `${width}px` }
        : { left: `${left}px`, bottom: `${bottom}px`, width: `${width}px` }

      return h(
        'span',
        { className: 'dcm-root' },
        pill,
        ReactDOM.createPortal(
          h(
            'div',
            {
              ref: panelRef,
              className: 'dcm-panel',
              style,
              role: 'dialog',
              'aria-label': t('title'),
            },
            renderPanel({ t, store, data, session, sessionId, onClose: () => setOpen(false) }),
          ),
          document.body,
        ),
      )
    }

    /**
     * The panel body: phase, priced breakdown, per-model detail, balance, footer.
     * @param {object} params - the render inputs.
     * @returns {object[]} the React children.
     */
    function renderPanel(params) {
      const { t, store, data, session, sessionId, onClose } = params
      const children = []
      const display = data?.display ?? {}
      const currency = session?.currency ?? display.currency

      children.push(h(
        'div',
        { className: 'dcm-head', key: 'head' },
        h('span', { className: 'dcm-title' }, h(IconCost, null), t('title')),
        h(
          'span',
          { className: 'dcm-total' },
          session !== null && session.ok === true ? money(session.cost, { ...display, currency }) : t('loading'),
        ),
      ))

      if (data === null) {
        children.push(h('div', { className: 'dcm-rule', key: 'rule-0' }))
        children.push(h(
          'p',
          { className: 'dcm-note', key: 'pending' },
          store.status === 'error' ? `${t('loadFailed')}: ${store.error ?? ''}` : t('loading'),
        ))
        return children
      }

      if (session === null || session.ok !== true) {
        children.push(h('div', { className: 'dcm-rule', key: 'rule-1' }))
        children.push(h(
          'p',
          { className: 'dcm-note dcm-err', key: 'session-error' },
          `${t('loadFailed')}: ${session?.error ?? store.error ?? ''}`,
        ))
        return children
      }

      // Phase chip plus the countdown to the next switch, on the same clock the
      // host priced with.
      const pricing = data.pricing ?? {}
      const totals = session.totals ?? {}
      const hasBreakdown = (totals.totalTokens ?? 0) > 0

      children.push(h(
        'div',
        { className: 'dcm-phase', key: 'phase' },
        h('span', { className: 'dcm-chip', 'data-phase': pricing.phase ?? 'offPeak' }, pricing.phase === 'peak' ? t('phasePeak') : t('phaseOffPeak')),
        pricing.remainingMs !== null && Number.isFinite(pricing.remainingMs)
          ? h('span', { className: 'dcm-muted' }, t('switchIn', { time: remaining(pricing.remainingMs, t) }))
          : h('span', { className: 'dcm-muted' }, t('phaseDetail')),
      ))

      if (!hasBreakdown) {
        children.push(h('p', { className: 'dcm-note', key: 'empty' }, t('noUsage')))
      } else {
        const buckets = totals.costByBucket ?? {}
        const rows = []
        const row = (key, label, tokenValue, cost) => {
          rows.push(h('dt', { key: `${key}-l` }, label))
          rows.push(h('dd', { className: 'dcm-tok', key: `${key}-t`, title: `${exactTokens(tokenValue)} ${t('tokens')}` }, `${tokens(tokenValue)} ${t('tokens')}`))
          rows.push(h('dd', { key: `${key}-c` }, money(cost, { ...display, currency })))
        }
        row('miss', t('cacheMiss'), totals.inputTokens, buckets.cacheMiss)
        row('hit', t('cacheHit'), totals.cacheReadTokens, buckets.cacheHit)
        if ((totals.cacheWriteTokens ?? 0) > 0) row('write', t('cacheWrite'), totals.cacheWriteTokens, buckets.cacheWrite)
        row('out', t('output'), totals.outputTokens, buckets.output)
        rows.push(h('dt', { className: 'dcm-sum', key: 'sum-l' }, t('total')))
        rows.push(h('dd', { className: 'dcm-tok', key: 'sum-t' }, `${tokens(totals.totalTokens)} ${t('tokens')}`))
        rows.push(h('dd', { className: 'dcm-sum', key: 'sum-c' }, money(session.cost, { ...display, currency })))
        children.push(h('dl', { className: 'dcm-rows', key: 'breakdown' }, rows))

        children.push(h(
          'p',
          { className: 'dcm-note', key: 'meta' },
          `${t('cacheHitRate')} ${percent(totals.cacheHitRate)} · ${t('callsAndTurns', { calls: totals.calls ?? 0, turns: session.turns ?? 0 })}`,
        ))
      }

      if (Array.isArray(session.models) && session.models.length > 0) {
        const models = []
        for (const model of session.models) {
          models.push(h(
            'div',
            { className: 'dcm-model', key: `m:${model.label}` },
            h(
              'div',
              { className: 'dcm-model-head' },
              h('span', { className: 'dcm-model-name', title: model.label }, model.label),
              h('span', { className: 'dcm-model-cost' }, money(model.cost, { ...display, currency })),
            ),
            h(
              'div',
              { className: 'dcm-model-meta' },
              `${t('modelCalls', { calls: model.calls })} · ${tokens(model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens + model.outputTokens)} ${t('tokens')}`,
              model.unpriced > 0 ? ` · ${t('unpriced', { count: model.unpriced })}` : '',
            ),
          ))
        }
        children.push(h('div', { className: 'dcm-section', key: 'models' }, h('div', { className: 'dcm-section-title' }, t('byModel')), ...models))
      }

      // Balance: the wallet the account reports, or an explanation of why not.
      const balance = data.balance ?? { status: 'off' }
      const wallets = Array.isArray(balance.wallets) ? balance.wallets : []
      const primary = wallets.find(wallet => wallet.currency === currency) ?? wallets[0] ?? null
      const updated = stamp(balance.fetchedAt)
      const balanceChildren = [
        h('div', { className: 'dcm-section-title', key: 'bt' }, h('span', null, h(IconWallet, null), ` ${t('balance')}`)),
      ]
      if (balance.status === 'ok' && primary !== null) {
        balanceChildren.push(h(
          'div',
          { className: 'dcm-balance', key: 'amount' },
          h('span', { className: 'dcm-muted' }, balance.source === 'account' ? 'DeepSeek' : (balance.keyName ?? '')),
          h('span', { className: 'dcm-balance-amount' }, money(primary.balance, { ...display, currency: primary.currency })),
        ))
        const parts = []
        if (primary.granted !== undefined) parts.push(`${t('bonus')} ${money(primary.granted, { ...display, currency: primary.currency })}`)
        if (primary.toppedUp !== undefined) parts.push(`${t('toppedUp')} ${money(primary.toppedUp, { ...display, currency: primary.currency })}`)
        if (wallets.length > 1) {
          for (const wallet of wallets) {
            if (wallet === primary) continue
            parts.push(`${wallet.currency} ${money(wallet.balance, { ...display, currency: wallet.currency })}`)
          }
        }
        if (updated !== null) parts.push(t('balanceUpdated', { time: updated }))
        balanceChildren.push(h('p', { className: 'dcm-note', key: 'parts' }, parts.join(' · ')))
        if (balance.stale === true) balanceChildren.push(h('p', { className: 'dcm-note dcm-warn', key: 'stale' }, t('balanceStale')))
      } else if (balance.status === 'unconfigured') {
        balanceChildren.push(h('p', { className: 'dcm-note', key: 'nc' }, t('balanceUnconfigured', { name: balance.keyName ?? 'DEEPSEEK_BALANCE_API_KEY' })))
      } else if (balance.status === 'off') {
        balanceChildren.push(h('p', { className: 'dcm-note', key: 'off' }, t('balanceOff')))
      } else {
        balanceChildren.push(h(
          'p',
          { className: 'dcm-note dcm-warn', key: 'fail' },
          `${t('balanceFailed')}: ${balance.message ?? ''}`,
        ))
      }
      children.push(h('div', { className: 'dcm-section', key: 'balance' }, ...balanceChildren))

      const source = pricing.source === 'official'
        ? t('pricingFromOfficial')
        : pricing.source === 'config' ? t('pricingFromConfig') : t('pricingFromBundled')
      const pricingUpdated = stamp(pricing.fetchedAt)
      const holidayCount = Number.isFinite(pricing.holidayCount) ? pricing.holidayCount : 0
      children.push(h(
        'div',
        { className: 'dcm-foot', key: 'foot' },
        h(
          'span',
          { className: 'dcm-foot-text' },
          t('pricingLine', {
            source,
            updated: pricingUpdated !== null ? t('pricingUpdated', { time: pricingUpdated }) : t('pricingNever'),
          }),
          holidayCount > 0 ? ` · ${t('holidayNote', { count: holidayCount })}` : '',
          h('br', null),
          t('disclaimer'),
        ),
        h(
          'button',
          {
            className: 'dcm-btn',
            type: 'button',
            key: 'refresh',
            disabled: store.busy,
            onClick: () => void load(sessionId, { refresh: true }),
          },
          store.busy ? t('refreshing') : t('refresh'),
        ),
      ))

      return children
    }

    /** Services that must exist before this half activates. */
    const inject = ['slots']

    /**
     * Client plugin body: inject the stylesheet and register the dock entry.
     * @param {object} ctx - the client Cordis context.
     * @returns {void}
     */
    function apply(ctx) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => {
        style.remove()
      }, `${NS}: styles`)

      const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (slots === undefined || slots === null) {
        console.error('[dsh-cost-meter] the slots service is unavailable; the cost pill is not registered')
        return
      }
      const t = makeTranslate(ctx)
      ctx.effect(() => slots.inject('conversation.composer.dock', () => slots.register({
        name: 'conversation.composer.dock',
        id: 'cost-meter',
        // The host's token/cache-hit pill occupies order 0; sit just after it.
        order: 1,
        registrant: NS,
      }, props => h(CostPill, { ...props, t }))), `${NS}: composer cost pill`)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
