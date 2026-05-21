'use client'

import { useMemo, useState } from 'react'
import BacktestPanel from '@/components/BacktestPanel'
import { compositeScore } from '@/lib/scoring'
import {
  FACTOR_KEYS,
  type FactorKey,
  type FactorWeights,
  type RankedStock,
} from '@/lib/types'

interface RankingResponse {
  generatedAt: string
  universe: string
  requested: number
  priceCoverage: number
  fundamentalsCoverage: number
  count: number
  ranking: RankedStock[]
}

const FACTOR_LABELS: Record<FactorKey, string> = {
  momentum: 'Momentum',
  quality: 'Quality',
  value: 'Value',
  growth: 'Growth',
  lowVolatility: 'Low Volatility',
}

const DEFAULT_RAW_WEIGHTS: FactorWeights = {
  momentum: 30,
  quality: 25,
  value: 20,
  growth: 15,
  lowVolatility: 10,
}

// --- Formateadores --------------------------------------------------------

const fmtPrice = (v: number) => `$${v.toFixed(2)}`
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`
const fmtNum = (v: number) => v.toFixed(2)
const fmtMcap = (v: number) => {
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
  return `$${v.toFixed(0)}`
}

type CellKind = 'int' | 'text' | 'price' | 'mcap' | 'signed' | 'pct' | 'num'

interface Column {
  key: string
  label: string
  kind: CellKind
  get: (r: RankedStock) => number | string | null
}

const COLUMNS: Column[] = [
  { key: 'rank', label: '#', kind: 'int', get: (r) => r.rank },
  { key: 'symbol', label: 'Símbolo', kind: 'text', get: (r) => r.symbol },
  { key: 'name', label: 'Nombre', kind: 'text', get: (r) => r.name },
  {
    key: 'sector',
    label: 'Sector',
    kind: 'text',
    get: (r) => r.sector ?? null,
  },
  {
    key: 'indices',
    label: 'Índice',
    kind: 'text',
    get: (r) => r.indices.join('/') || null,
  },
  { key: 'price', label: 'Precio', kind: 'price', get: (r) => r.price },
  {
    key: 'marketCap',
    label: 'Cap. mercado',
    kind: 'mcap',
    get: (r) => r.marketCap,
  },
  { key: 'score', label: 'Score', kind: 'signed', get: (r) => r.score },
  {
    key: 'momentum',
    label: 'Momentum',
    kind: 'signed',
    get: (r) => r.factors.momentum,
  },
  {
    key: 'quality',
    label: 'Quality',
    kind: 'signed',
    get: (r) => r.factors.quality,
  },
  { key: 'value', label: 'Value', kind: 'signed', get: (r) => r.factors.value },
  {
    key: 'growth',
    label: 'Growth',
    kind: 'signed',
    get: (r) => r.factors.growth,
  },
  {
    key: 'lowVolatility',
    label: 'Low Vol',
    kind: 'signed',
    get: (r) => r.factors.lowVolatility,
  },
  {
    key: 'mom12_1',
    label: 'Mom 12-1',
    kind: 'pct',
    get: (r) => r.metrics.mom12_1,
  },
  {
    key: 'mom6_1',
    label: 'Mom 6-1',
    kind: 'pct',
    get: (r) => r.metrics.mom6_1,
  },
  {
    key: 'volatility',
    label: 'Volat. anual',
    kind: 'pct',
    get: (r) => r.metrics.volatility,
  },
  { key: 'beta', label: 'Beta', kind: 'num', get: (r) => r.metrics.beta },
  {
    key: 'earningsYield',
    label: 'Earn. yield',
    kind: 'pct',
    get: (r) => r.metrics.earningsYield,
  },
  {
    key: 'bookToPrice',
    label: 'Book/Price',
    kind: 'num',
    get: (r) => r.metrics.bookToPrice,
  },
  {
    key: 'fcfYield',
    label: 'FCF yield',
    kind: 'pct',
    get: (r) => r.metrics.fcfYield,
  },
  { key: 'roe', label: 'ROE', kind: 'pct', get: (r) => r.metrics.roe },
  {
    key: 'profitMargin',
    label: 'Margen neto',
    kind: 'pct',
    get: (r) => r.metrics.profitMargin,
  },
  {
    key: 'debtToEquity',
    label: 'Deuda/Equity',
    kind: 'num',
    get: (r) => r.metrics.debtToEquity,
  },
  {
    key: 'revenueGrowth',
    label: 'Crec. ventas',
    kind: 'pct',
    get: (r) => r.metrics.revenueGrowth,
  },
  {
    key: 'earningsGrowth',
    label: 'Crec. BPA',
    kind: 'pct',
    get: (r) => r.metrics.earningsGrowth,
  },
  {
    key: 'coverage',
    label: 'Cobertura',
    kind: 'pct',
    get: (r) => r.coverage,
  },
]

function formatCell(value: number | string | null, kind: CellKind): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'string') return value
  switch (kind) {
    case 'int':
      return String(value)
    case 'price':
      return fmtPrice(value)
    case 'mcap':
      return fmtMcap(value)
    case 'pct':
      return fmtPct(value)
    case 'signed':
    case 'num':
      return fmtNum(value)
    default:
      return String(value)
  }
}

export default function RankingPage() {
  const [universe, setUniverse] = useState('combined')
  const [weights, setWeights] = useState<FactorWeights>({
    ...DEFAULT_RAW_WEIGHTS,
  })
  const [topN, setTopN] = useState<number | 'all'>(20)
  const [sortKey, setSortKey] = useState('rank')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resp, setResp] = useState<RankingResponse | null>(null)

  const generate = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/ranking?universe=${universe}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Error generando el ranking.')
      setResp(json as RankingResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error desconocido.')
      setResp(null)
    } finally {
      setLoading(false)
    }
  }

  // Recalcula el score con los pesos actuales (los z-scores de factor son
  // independientes del peso, así que el reordenado es instantáneo).
  const reweighted = useMemo<RankedStock[]>(() => {
    if (!resp) return []
    const scored = resp.ranking.map((r) => ({
      ...r,
      score: compositeScore(r.factors, weights),
    }))
    scored.sort((a, b) => b.score - a.score)
    scored.forEach((r, i) => {
      r.rank = i + 1
    })
    return scored
  }, [resp, weights])

  const limited = useMemo<RankedStock[]>(
    () => (topN === 'all' ? reweighted : reweighted.slice(0, topN)),
    [reweighted, topN]
  )

  const sorted = useMemo<RankedStock[]>(() => {
    const col = COLUMNS.find((c) => c.key === sortKey) ?? COLUMNS[0]
    const arr = [...limited]
    arr.sort((a, b) => {
      const va = col.get(a)
      const vb = col.get(b)
      if (va == null && vb == null) return 0
      if (va == null) return 1 // nulos siempre al final
      if (vb == null) return -1
      let cmp: number
      if (typeof va === 'string' && typeof vb === 'string') {
        cmp = va.localeCompare(vb)
      } else {
        cmp = (va as number) - (vb as number)
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [limited, sortKey, sortDir])

  const onSort = (col: Column) => {
    if (col.key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(col.key)
      setSortDir(col.kind === 'text' || col.key === 'rank' ? 'asc' : 'desc')
    }
  }

  const totalWeight = FACTOR_KEYS.reduce((a, f) => a + weights[f], 0)

  const exportCsv = () => {
    const header = COLUMNS.map((c) => c.label).join(',')
    const rows = sorted.map((r) =>
      COLUMNS.map((c) => {
        const v = c.get(r)
        if (v == null) return ''
        if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`
        return String(v)
      }).join(',')
    )
    const blob = new Blob([[header, ...rows].join('\n')], {
      type: 'text/csv;charset=utf-8;',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ranking-${universe}-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="py-2">
      <header className="mb-4">
        <h1 className="text-2xl font-bold">Ranking cuantitativo de acciones</h1>
        <p className="text-sm text-slate-500">
          S&amp;P 500 + Nasdaq 100 · modelo multifactor Value · Quality ·
          Momentum · Growth · Low&nbsp;Volatility. Rebalanceo recomendado:
          semanal o mensual.
        </p>
      </header>

      {/* Controles de generación */}
      <section className="bg-white rounded-2xl shadow p-5">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">Universo</span>
            <select
              className="border rounded-lg px-2 py-1.5"
              value={universe}
              onChange={(e) => setUniverse(e.target.value)}
            >
              <option value="combined">SP500 + Nasdaq100</option>
              <option value="sp500">S&amp;P 500</option>
              <option value="nasdaq100">Nasdaq 100</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">Salida</span>
            <select
              className="border rounded-lg px-2 py-1.5"
              value={String(topN)}
              onChange={(e) =>
                setTopN(
                  e.target.value === 'all' ? 'all' : Number(e.target.value)
                )
              }
            >
              <option value="20">Top 20</option>
              <option value="50">Top 50</option>
              <option value="100">Top 100</option>
              <option value="all">Todas</option>
            </select>
          </label>
          <button
            onClick={generate}
            disabled={loading}
            className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium disabled:opacity-50"
          >
            {loading ? 'Generando…' : 'Generar ranking'}
          </button>
          {resp && (
            <button
              onClick={exportCsv}
              className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium"
            >
              Exportar CSV
            </button>
          )}
        </div>

        {/* Pesos del modelo */}
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-slate-700">
              Pesos del score (ajuste instantáneo)
            </h2>
            <button
              onClick={() => setWeights({ ...DEFAULT_RAW_WEIGHTS })}
              className="text-xs text-slate-500 underline"
            >
              Restablecer 30/25/20/15/10
            </button>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {FACTOR_KEYS.map((f) => {
              const normPct =
                totalWeight > 0 ? (weights[f] / totalWeight) * 100 : 0
              return (
                <div key={f} className="border rounded-lg p-2.5">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium text-slate-700">
                      {FACTOR_LABELS[f]}
                    </span>
                    <span className="tabular-nums text-slate-500">
                      {normPct.toFixed(0)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={1}
                    value={weights[f]}
                    onChange={(e) =>
                      setWeights((w) => ({
                        ...w,
                        [f]: Number(e.target.value),
                      }))
                    }
                    className="w-full"
                  />
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {error && (
        <p className="text-sm text-red-600 mt-4 bg-red-50 rounded-lg p-3">
          ⚠ {error}
        </p>
      )}
      {loading && (
        <p className="text-sm text-slate-500 mt-4">
          Descargando precios y fundamentales de Yahoo Finance para todo el
          universo. La primera carga puede tardar 1-2&nbsp;minutos…
        </p>
      )}

      {/* Tabla de ranking */}
      {resp && !loading && (
        <section className="bg-white rounded-2xl shadow p-5 mt-4">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3">
            <h2 className="text-lg font-semibold">
              Ranking ·{' '}
              {topN === 'all' ? `${sorted.length} acciones` : `Top ${topN}`}
            </h2>
            <span className="text-xs text-slate-400">
              {resp.priceCoverage}/{resp.requested} con precio ·{' '}
              {resp.fundamentalsCoverage}/{resp.requested} con fundamentales ·
              generado {new Date(resp.generatedAt).toLocaleString('es-ES')}
            </span>
          </div>
          <p className="text-xs text-slate-400 mb-3">
            Los scores de factor son z-scores transversales (0 = media del
            universo). Haz clic en cualquier cabecera para ordenar.
          </p>

          <div className="overflow-x-auto">
            <table className="text-xs border-collapse w-full">
              <thead>
                <tr className="bg-slate-50 text-slate-500">
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      onClick={() => onSort(c)}
                      className={`px-2 py-2 font-medium cursor-pointer select-none whitespace-nowrap border-b border-slate-200 ${
                        c.kind === 'text' ? 'text-left' : 'text-right'
                      } ${sortKey === c.key ? 'text-slate-900' : ''}`}
                    >
                      {c.label}
                      {sortKey === c.key && (
                        <span>{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr
                    key={r.symbol}
                    className="border-b border-slate-100 hover:bg-slate-50"
                  >
                    {COLUMNS.map((c) => {
                      const v = c.get(r)
                      const isNum = typeof v === 'number'
                      let color = ''
                      if (c.kind === 'signed' && isNum) {
                        color =
                          (v as number) > 0.05
                            ? 'text-emerald-600'
                            : (v as number) < -0.05
                              ? 'text-rose-600'
                              : 'text-slate-500'
                      }
                      const strong =
                        c.key === 'symbol' || c.key === 'score'
                          ? 'font-semibold'
                          : ''
                      return (
                        <td
                          key={c.key}
                          className={`px-2 py-1.5 whitespace-nowrap ${
                            c.kind === 'text'
                              ? 'text-left'
                              : 'text-right tabular-nums'
                          } ${color} ${strong} ${
                            v == null ? 'text-slate-300' : ''
                          }`}
                        >
                          {c.key === 'name' && typeof v === 'string'
                            ? v.length > 26
                              ? v.slice(0, 26) + '…'
                              : v
                            : formatCell(v, c.kind)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Backtest / comparación con benchmark */}
      <BacktestPanel />

      <footer className="text-xs text-slate-400 mt-6 pb-4">
        Datos: Yahoo Finance. Herramienta de análisis cuantitativo; no
        constituye recomendación de inversión.
      </footer>
    </main>
  )
}
