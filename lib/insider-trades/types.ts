// ─────────────────────────────────────────────────────────────────────────────
//  SEC EDGAR Insider Trades — Shared Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single open-market purchase scraped from a Form 4 filing. */
export interface InsiderTrade {
  /** 1-based rank after sorting by totalValue descending */
  rank: number

  /** Issuing company name (from Form 4 XML) */
  companyName: string

  /** Ticker symbol (from Form 4 XML) */
  ticker: string

  /** Insider's full name as it appears on the filing */
  insiderName: string

  /** Officer title or "Director" / "10% Owner" */
  insiderTitle: string

  isDirector: boolean
  isOfficer: boolean
  isTenPercentOwner: boolean

  /** Date the transaction occurred (YYYY-MM-DD) */
  transactionDate: string

  /** Number of shares purchased */
  shares: number

  /** Price paid per share */
  pricePerShare: number

  /** Total dollar value (shares × price) */
  totalValue: number

  /** Shares owned after this transaction */
  sharesOwnedAfter: number

  /** Date the Form 4 was filed with the SEC */
  filingDate: string

  /** Direct link to the EDGAR filing viewer */
  filingUrl: string

  /** Raw accession number, e.g. "0001234567-24-000001" */
  accessionNumber: string
}

/** Minimal metadata returned by the EDGAR EFTS search API */
export interface FilingMeta {
  accessionNumber: string
  cik: string
  fileDate: string
  entityName: string
}

/** Summary stats for the Slack header */
export interface PurchaseSummary {
  trades: InsiderTrade[]
  totalPurchases: number
  totalValue: number
  hoursBack: number
  minValue: number
  fetchedAt: string
}
