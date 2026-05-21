// Normalización de métricas y construcción del ranking ponderado.

import { winsorizedZScores } from './stats'
import {
  FACTOR_KEYS,
  type FactorKey,
  type FactorScores,
  type FactorWeights,
  type RankedStock,
  type RawMetrics,
  type SymbolData,
} from './types'

export { FACTOR_KEYS }

interface MetricDef {
  key: keyof RawMetrics
  factor: FactorKey
  higherBetter: boolean
}

// Cada factor se compone de una o varias métricas. El score del factor es la
// media de los z-scores transversales de sus métricas disponibles.
const METRIC_DEFS: MetricDef[] = [
  { key: 'mom12_1', factor: 'momentum', higherBetter: true },
  { key: 'mom6_1', factor: 'momentum', higherBetter: true },
  { key: 'roe', factor: 'quality', higherBetter: true },
  { key: 'profitMargin', factor: 'quality', higherBetter: true },
  { key: 'debtToEquity', factor: 'quality', higherBetter: false },
  { key: 'earningsYield', factor: 'value', higherBetter: true },
  { key: 'bookToPrice', factor: 'value', higherBetter: true },
  { key: 'fcfYield', factor: 'value', higherBetter: true },
  { key: 'revenueGrowth', factor: 'growth', higherBetter: true },
  { key: 'earningsGrowth', factor: 'growth', higherBetter: true },
  { key: 'volatility', factor: 'lowVolatility', higherBetter: false },
  { key: 'beta', factor: 'lowVolatility', higherBetter: false },
]

// Score compuesto: suma ponderada de los factores con datos, con los pesos
// renormalizados sobre los factores disponibles (un factor sin datos no
// penaliza ni beneficia a la acción).
export function compositeScore(
  factors: FactorScores,
  weights: FactorWeights
): number {
  let weightSum = 0
  let acc = 0
  for (const f of FACTOR_KEYS) {
    const v = factors[f]
    if (v != null && Number.isFinite(v)) {
      acc += weights[f] * v
      weightSum += weights[f]
    }
  }
  return weightSum > 0 ? acc / weightSum : 0
}

// Construye el ranking completo a partir de los datos crudos por símbolo.
// Los z-scores de factor son independientes de los pesos, de modo que el
// cliente puede recalcular el score al instante al cambiar la ponderación.
export function buildRanking(
  symbols: SymbolData[],
  weights: FactorWeights
): RankedStock[] {
  const metricZ = new Map<keyof RawMetrics, (number | null)[]>()
  for (const def of METRIC_DEFS) {
    const values = symbols.map((s) => s.metrics[def.key])
    metricZ.set(def.key, winsorizedZScores(values, def.higherBetter))
  }

  const ranked: RankedStock[] = symbols.map((s, i) => {
    const factors: FactorScores = {
      momentum: null,
      quality: null,
      value: null,
      growth: null,
      lowVolatility: null,
    }

    for (const f of FACTOR_KEYS) {
      const zs: number[] = []
      for (const def of METRIC_DEFS) {
        if (def.factor !== f) continue
        const z = metricZ.get(def.key)?.[i]
        if (z != null && Number.isFinite(z)) zs.push(z)
      }
      if (zs.length > 0) {
        factors[f] = zs.reduce((a, b) => a + b, 0) / zs.length
      }
    }

    const withData = FACTOR_KEYS.filter((f) => factors[f] != null).length

    return {
      rank: 0,
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      price: s.price,
      marketCap: s.marketCap,
      indices: s.indices,
      score: compositeScore(factors, weights),
      factors,
      metrics: s.metrics,
      coverage: withData / FACTOR_KEYS.length,
    }
  })

  ranked.sort((a, b) => b.score - a.score)
  ranked.forEach((r, i) => {
    r.rank = i + 1
  })
  return ranked
}
