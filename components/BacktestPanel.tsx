'use client'

import { useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { BacktestResult } from '@/lib/backtest'

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const num2 = (v: number) => v.toFixed(2)

function MetricRow({
  label,
  port,
  bench,
  format,
  higherBetter = true,
}: {
  label: string
  port: number
  bench: number
  format: (v: number) => string
  higherBetter?: boolean
}) {
  const portWins = higherBetter ? port > bench : port < bench
  return (
    <tr className="border-b border-slate-100">
      <td className="py-1.5 pr-4 text-slate-600">{label}</td>
      <td
        className={`py-1.5 pr-4 text-right font-semibold tabular-nums ${
          portWins ? 'text-emerald-600' : 'text-slate-800'
        }`}
      >
        {format(port)}
      </td>
      <td className="py-1.5 text-right tabular-nums text-slate-500">
        {format(bench)}
      </td>
    </tr>
  )
}

export default function BacktestPanel() {
  const [universe, setUniverse] = useState('nasdaq100')
  const [topN, setTopN] = useState(20)
  const [frequency, setFrequency] = useState('weekly')
  const [startYear, setStartYear] = useState(2019)
  const [benchmark, setBenchmark] = useState('SPY')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BacktestResult | null>(null)

  const run = async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({
        universe,
        topN: String(topN),
        frequency,
        startYear: String(startYear),
        benchmark,
      })
      const res = await fetch(`/api/backtest?${qs}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Error en el backtest.')
      setResult(json as BacktestResult)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error desconocido.')
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="bg-white rounded-2xl shadow p-5 mt-6">
      <h2 className="text-lg font-semibold mb-1">
        Validación walk-forward · ¿Supera al benchmark?
      </h2>
      <p className="text-sm text-slate-500 mb-4">
        Backtest punto-en-el-tiempo de los factores de precio (Momentum +
        Low&nbsp;Volatility), reconstruibles históricamente. En cada rebalanceo
        se selecciona el top-N equiponderado y se compara con el benchmark.
      </p>

      <div className="flex flex-wrap gap-3 items-end">
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">Universo</span>
          <select
            className="border rounded-lg px-2 py-1.5"
            value={universe}
            onChange={(e) => setUniverse(e.target.value)}
          >
            <option value="nasdaq100">Nasdaq 100</option>
            <option value="sp500">S&amp;P 500</option>
            <option value="combined">Combinado</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">Top N</span>
          <select
            className="border rounded-lg px-2 py-1.5"
            value={topN}
            onChange={(e) => setTopN(Number(e.target.value))}
          >
            <option value={20}>Top 20</option>
            <option value={50}>Top 50</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">Frecuencia</span>
          <select
            className="border rounded-lg px-2 py-1.5"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
          >
            <option value="weekly">Semanal</option>
            <option value="monthly">Mensual</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">Año inicio</span>
          <select
            className="border rounded-lg px-2 py-1.5"
            value={startYear}
            onChange={(e) => setStartYear(Number(e.target.value))}
          >
            {[2010, 2013, 2015, 2017, 2019, 2021, 2022].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">Benchmark</span>
          <select
            className="border rounded-lg px-2 py-1.5"
            value={benchmark}
            onChange={(e) => setBenchmark(e.target.value)}
          >
            <option value="SPY">SPY (S&amp;P 500)</option>
            <option value="QQQ">QQQ (Nasdaq 100)</option>
            <option value="RSP">RSP (S&amp;P equiponderado)</option>
          </select>
        </label>
        <button
          onClick={run}
          disabled={loading}
          className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium disabled:opacity-50"
        >
          {loading ? 'Ejecutando…' : 'Ejecutar backtest'}
        </button>
      </div>

      {loading && (
        <p className="text-sm text-slate-500 mt-4">
          Descargando histórico de cotizaciones y simulando rebalanceos. Puede
          tardar 1-2&nbsp;minutos…
        </p>
      )}
      {error && (
        <p className="text-sm text-red-600 mt-4">⚠ {error}</p>
      )}

      {result && !loading && (
        <div className="mt-5">
          <div
            className={`rounded-xl px-4 py-3 mb-4 font-semibold ${
              result.beatsBenchmark
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-amber-50 text-amber-700'
            }`}
          >
            {result.beatsBenchmark
              ? `✓ La estrategia SUPERA al benchmark (${result.benchmark})`
              : `✗ La estrategia NO supera al benchmark (${result.benchmark})`}
            <span className="font-normal text-slate-500">
              {' '}
              · CAGR excedente {pct(result.excessCagr)} · hit rate{' '}
              {pct(result.hitRate)} · {result.periods} periodos{' '}
              {result.frequency === 'weekly' ? 'semanales' : 'mensuales'} (
              {result.start} → {result.end})
            </span>
          </div>

          <div className="grid md:grid-cols-2 gap-5">
            <div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-slate-200">
                    <th className="py-1.5 pr-4 font-medium">Métrica</th>
                    <th className="py-1.5 pr-4 text-right font-medium">
                      Estrategia
                    </th>
                    <th className="py-1.5 text-right font-medium">
                      {result.benchmark}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <MetricRow
                    label="CAGR"
                    port={result.portfolio.cagr}
                    bench={result.benchmarkMetrics.cagr}
                    format={pct}
                  />
                  <MetricRow
                    label="Retorno total"
                    port={result.portfolio.totalReturn}
                    bench={result.benchmarkMetrics.totalReturn}
                    format={pct}
                  />
                  <MetricRow
                    label="Sharpe"
                    port={result.portfolio.sharpe}
                    bench={result.benchmarkMetrics.sharpe}
                    format={num2}
                  />
                  <MetricRow
                    label="Volatilidad anual"
                    port={result.portfolio.volatility}
                    bench={result.benchmarkMetrics.volatility}
                    format={pct}
                    higherBetter={false}
                  />
                  <MetricRow
                    label="Máximo drawdown"
                    port={result.portfolio.maxDrawdown}
                    bench={result.benchmarkMetrics.maxDrawdown}
                    format={pct}
                  />
                  <tr className="border-b border-slate-100">
                    <td className="py-1.5 pr-4 text-slate-600">
                      Hit rate vs benchmark
                    </td>
                    <td className="py-1.5 pr-4 text-right font-semibold tabular-nums">
                      {pct(result.hitRate)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-400">
                      —
                    </td>
                  </tr>
                  <tr className="border-b border-slate-100">
                    <td className="py-1.5 pr-4 text-slate-600">
                      Turnover (medio / anual)
                    </td>
                    <td className="py-1.5 pr-4 text-right font-semibold tabular-nums">
                      {pct(result.avgTurnover)} / {pct(result.annualTurnover)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-400">
                      —
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div>
              <p className="text-xs text-slate-400 mb-1">
                Crecimiento de 1$ invertido
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={result.equityCurve}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    minTickGap={40}
                  />
                  <YAxis tick={{ fontSize: 10 }} width={40} />
                  <Tooltip
                    formatter={(v: number) => v.toFixed(2)}
                    labelStyle={{ fontSize: 11 }}
                    contentStyle={{ fontSize: 11 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    type="monotone"
                    dataKey="portfolio"
                    name="Estrategia"
                    stroke="#0f766e"
                    dot={false}
                    strokeWidth={2}
                  />
                  <Line
                    type="monotone"
                    dataKey="benchmark"
                    name={result.benchmark}
                    stroke="#94a3b8"
                    dot={false}
                    strokeWidth={1.5}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="mt-4">
            <p className="text-xs text-slate-400 mb-1">
              Cartera en el último rebalanceo ({result.sampleHoldings.length}{' '}
              acciones)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {result.sampleHoldings.map((s) => (
                <span
                  key={s}
                  className="text-xs bg-slate-100 rounded px-2 py-0.5 font-medium"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
