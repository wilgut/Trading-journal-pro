// Cliente de Yahoo Finance: precios históricos y datos fundamentales.
// Incluye control de concurrencia, caché en memoria (TTL) y manejo de crumb.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
]

const CHART_TTL = 6 * 60 * 60 * 1000 // 6 horas
const FUND_TTL = 12 * 60 * 60 * 1000 // 12 horas

export interface PriceSeries {
  dates: number[] // timestamps en ms, ascendentes
  closes: number[] // cierres ajustados alineados con dates
}

export interface Fundamentals {
  name: string | null
  sector: string | null
  price: number | null
  marketCap: number | null
  trailingPE: number | null
  priceToBook: number | null
  priceToSales: number | null
  freeCashflow: number | null
  returnOnEquity: number | null
  profitMargin: number | null
  debtToEquity: number | null
  revenueGrowth: number | null
  earningsGrowth: number | null
  beta: number | null
}

interface CacheEntry<T> {
  value: T
  ts: number
}

const chartCache = new Map<string, CacheEntry<PriceSeries | null>>()
const fundCache = new Map<string, CacheEntry<Fundamentals | null>>()

// --- Utilidades genéricas -------------------------------------------------

// Ejecuta fn sobre items con un máximo de `limit` tareas en paralelo.
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length || 1) },
    worker
  )
  await Promise.all(workers)
  return results
}

async function timedFetch(
  url: string,
  init: RequestInit = {},
  ms = 12000
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timer)
  }
}

function num(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'object' && v !== null && 'raw' in v) {
    const raw = (v as { raw: unknown }).raw
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  }
  return null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// --- Precios históricos ---------------------------------------------------

export async function fetchChart(
  symbol: string,
  opts: {
    range?: string
    period1?: number
    period2?: number
    interval?: string
  } = {}
): Promise<PriceSeries | null> {
  const interval = opts.interval ?? '1d'
  const qs = opts.range
    ? `range=${opts.range}&interval=${interval}`
    : `period1=${opts.period1}&period2=${opts.period2}&interval=${interval}`
  const key = `${symbol}|${qs}`

  const cached = chartCache.get(key)
  if (cached && Date.now() - cached.ts < CHART_TTL) return cached.value

  let value: PriceSeries | null = null
  for (let attempt = 0; attempt < 2 && value === null; attempt++) {
    try {
      const host = HOSTS[attempt % HOSTS.length]
      const res = await timedFetch(
        `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}` +
          `&includeAdjustedClose=true`,
        { headers: { 'User-Agent': UA } }
      )
      if (!res.ok) continue
      const json = await res.json()
      const result = json?.chart?.result?.[0]
      if (!result) continue

      const ts: number[] = result.timestamp ?? []
      const adj: (number | null)[] | undefined =
        result.indicators?.adjclose?.[0]?.adjclose
      const close: (number | null)[] | undefined =
        result.indicators?.quote?.[0]?.close
      const raw = adj ?? close ?? []

      const dates: number[] = []
      const closes: number[] = []
      for (let i = 0; i < ts.length; i++) {
        const c = raw[i]
        if (c != null && Number.isFinite(c) && c > 0) {
          dates.push(ts[i] * 1000)
          closes.push(c)
        }
      }
      if (closes.length > 0) value = { dates, closes }
    } catch {
      // reintentar con el siguiente host
    }
  }

  chartCache.set(key, { value, ts: Date.now() })
  return value
}

// --- Datos fundamentales --------------------------------------------------

let crumb: { crumb: string; cookie: string } | null = null
let crumbPromise: Promise<{ crumb: string; cookie: string } | null> | null = null

async function getCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  if (crumb) return crumb
  if (crumbPromise) return crumbPromise

  crumbPromise = (async () => {
    for (const seedUrl of [
      'https://fc.yahoo.com',
      'https://finance.yahoo.com',
    ]) {
      try {
        const seed = await timedFetch(
          seedUrl,
          { headers: { 'User-Agent': UA } },
          8000
        )
        const setCookies = seed.headers.getSetCookie?.() ?? []
        const cookie = setCookies
          .map((c) => c.split(';')[0])
          .filter(Boolean)
          .join('; ')
        if (!cookie) continue

        const cr = await timedFetch(
          'https://query1.finance.yahoo.com/v1/test/getcrumb',
          { headers: { 'User-Agent': UA, cookie } },
          8000
        )
        const text = (await cr.text()).trim()
        if (cr.ok && text && !text.startsWith('<') && text.length < 40) {
          crumb = { crumb: text, cookie }
          return crumb
        }
      } catch {
        // probar la siguiente semilla
      }
    }
    return null
  })()

  const result = await crumbPromise
  crumbPromise = null
  return result
}

export async function fetchFundamentals(
  symbol: string
): Promise<Fundamentals | null> {
  const key = symbol
  const cached = fundCache.get(key)
  if (cached && Date.now() - cached.ts < FUND_TTL) return cached.value

  const modules =
    'price,summaryDetail,defaultKeyStatistics,financialData,assetProfile'

  let value: Fundamentals | null = null
  for (let attempt = 0; attempt < 2 && value === null; attempt++) {
    try {
      const c = await getCrumb()
      const host = HOSTS[attempt % HOSTS.length]
      const url =
        `${host}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
        `?modules=${modules}` +
        (c ? `&crumb=${encodeURIComponent(c.crumb)}` : '')
      const res = await timedFetch(url, {
        headers: {
          'User-Agent': UA,
          ...(c ? { cookie: c.cookie } : {}),
        },
      })
      if (res.status === 401 || res.status === 403) {
        crumb = null // crumb caducado: forzar renovación
        continue
      }
      if (!res.ok) continue

      const json = await res.json()
      const r = json?.quoteSummary?.result?.[0]
      if (!r) continue

      const price = r.price ?? {}
      const sd = r.summaryDetail ?? {}
      const ks = r.defaultKeyStatistics ?? {}
      const fd = r.financialData ?? {}
      const ap = r.assetProfile ?? {}

      value = {
        name: str(price.longName) ?? str(price.shortName),
        sector: str(ap.sector),
        price: num(fd.currentPrice) ?? num(price.regularMarketPrice),
        marketCap: num(price.marketCap) ?? num(sd.marketCap),
        trailingPE: num(sd.trailingPE) ?? num(ks.trailingPE),
        priceToBook: num(ks.priceToBook),
        priceToSales: num(sd.priceToSalesTrailing12Months),
        freeCashflow: num(fd.freeCashflow),
        returnOnEquity: num(fd.returnOnEquity),
        profitMargin: num(fd.profitMargins),
        debtToEquity: num(fd.debtToEquity),
        revenueGrowth: num(fd.revenueGrowth),
        earningsGrowth: num(fd.earningsGrowth),
        beta: num(sd.beta) ?? num(ks.beta),
      }
    } catch {
      // reintentar
    }
  }

  fundCache.set(key, { value, ts: Date.now() })
  return value
}
