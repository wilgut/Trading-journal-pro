// Tipos compartidos del sistema de ranking cuantitativo SP500 + Nasdaq100.

export type FactorKey =
  | 'momentum'
  | 'quality'
  | 'value'
  | 'growth'
  | 'lowVolatility'

export const FACTOR_KEYS: FactorKey[] = [
  'momentum',
  'quality',
  'value',
  'growth',
  'lowVolatility',
]

export type FactorWeights = Record<FactorKey, number>

// Pesos por defecto del modelo (suman 1.0):
// 30% Momentum + 25% Quality + 20% Value + 15% Growth + 10% Low Volatility
export const DEFAULT_WEIGHTS: FactorWeights = {
  momentum: 0.3,
  quality: 0.25,
  value: 0.2,
  growth: 0.15,
  lowVolatility: 0.1,
}

// Métricas crudas (sin normalizar) por acción.
export interface RawMetrics {
  // Momentum (precio)
  mom12_1: number | null // retorno 12 meses excluyendo el último
  mom6_1: number | null // retorno 6 meses excluyendo el último
  // Low Volatility (precio)
  volatility: number | null // volatilidad anualizada de retornos diarios
  beta: number | null
  // Value (fundamental)
  earningsYield: number | null // 1 / PER
  bookToPrice: number | null // 1 / P/B
  fcfYield: number | null // free cash flow / market cap
  // Quality (fundamental)
  roe: number | null // return on equity
  profitMargin: number | null
  debtToEquity: number | null
  // Growth (fundamental)
  revenueGrowth: number | null
  earningsGrowth: number | null
}

export type FactorScores = Record<FactorKey, number | null>

export interface SymbolData {
  symbol: string
  name: string
  sector: string | null
  price: number | null
  marketCap: number | null
  indices: string[]
  metrics: RawMetrics
  hasPrice: boolean
  hasFundamentals: boolean
}

export interface RankedStock {
  rank: number
  symbol: string
  name: string
  sector: string | null
  price: number | null
  marketCap: number | null
  indices: string[]
  score: number // score compuesto ponderado
  factors: FactorScores // scores de factor (z-scores, independientes del peso)
  metrics: RawMetrics // valores crudos para mostrar/ordenar
  coverage: number // fracción de factores con datos (0..1)
}
