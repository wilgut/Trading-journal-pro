#!/usr/bin/env python3
"""
SEC EDGAR Insider Purchase Monitor
-----------------------------------
Fetches Form 4 filings filed in the last 24 hours, extracts open-market
purchases (transaction code P, acquired A) by directors & officers, filters
to purchases > $100K, and prints a ranked JSON summary.

Usage:
    python scripts/fetch-insider-buys.py [--min-value 100000] [--max-filings 80]
"""

import argparse
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Optional

try:
    import requests
except ImportError:
    print("pip install requests", file=sys.stderr)
    sys.exit(1)

USER_AGENT = "TradingJournalPro/1.0 contact@tradingjournal.pro"
HEADERS = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"}
EDGAR_BASE = "https://www.sec.gov"
SEARCH_BASE = "https://efts.sec.gov"

RATE_LIMIT_SLEEP = 0.12   # 120 ms → stays well under 10 req/s

# ── helpers ────────────────────────────────────────────────────────────────

def fmt_currency(value: float) -> str:
    if value >= 1_000_000:
        return f"${value / 1_000_000:.2f}M"
    if value >= 1_000:
        return f"${value / 1_000:.1f}K"
    return f"${value:.2f}"

def xml_text(root: ET.Element, path: str) -> str:
    el = root.find(path)
    return (el.text or "").strip() if el is not None else ""

# ── EDGAR API ───────────────────────────────────────────────────────────────

def fetch_filing_list(start_date: str, end_date: str, max_hits: int = 100):
    """Return list of (accession_number, cik) for Form 4 filings in range."""
    url = (
        f"{SEARCH_BASE}/LATEST/search-index"
        f"?forms=4&dateRange=custom&startdt={start_date}&enddt={end_date}"
        f"&hits.hits.total.value=true"
    )
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    hits = data.get("hits", {}).get("hits", [])[:max_hits]

    results = []
    for hit in hits:
        accession = hit.get("_id", "")
        display_names = hit.get("_source", {}).get("display_names", [])
        raw_cik = display_names[0].get("id", "") if display_names else ""
        if accession and raw_cik:
            cik = raw_cik.lstrip("0") or raw_cik
            results.append((accession, cik))
    return results

def fetch_form4_xml(cik: str, accession: str) -> Optional[str]:
    """Fetch raw XML for one Form 4 filing (tries index, then fallback URL)."""
    acc_clean = accession.replace("-", "")
    sec_headers = {**HEADERS, "Host": "www.sec.gov"}

    # Preferred: look up the filing index to get the exact XML filename.
    try:
        idx_url = f"{EDGAR_BASE}/Archives/edgar/data/{cik}/{acc_clean}/{accession}-index.json"
        idx = requests.get(idx_url, headers=sec_headers, timeout=15)
        if idx.status_code == 200:
            docs = idx.json().get("documents", [])
            for doc in docs:
                if doc.get("type") == "4" and doc.get("document", "").endswith(".xml"):
                    xml_url = f"{EDGAR_BASE}/Archives/edgar/data/{cik}/{acc_clean}/{doc['document']}"
                    xml_resp = requests.get(xml_url, headers=sec_headers, timeout=15)
                    if xml_resp.status_code == 200:
                        return xml_resp.text
    except Exception:
        pass

    # Fallback: accession-number.xml naming pattern.
    try:
        xml_url = f"{EDGAR_BASE}/Archives/edgar/data/{cik}/{acc_clean}/{accession}.xml"
        xml_resp = requests.get(xml_url, headers=sec_headers, timeout=15)
        if xml_resp.status_code == 200:
            return xml_resp.text
    except Exception:
        pass

    return None

# ── XML parsing ─────────────────────────────────────────────────────────────

def parse_form4(xml_text: str, accession: str, cik: str):
    """Return list of purchase dicts from one Form 4 XML."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    issuer_name   = xml_text_el(root, "issuer/issuerName")
    issuer_ticker = xml_text_el(root, "issuer/issuerTradingSymbol").upper()

    owner = root.find("reportingOwner")
    if owner is None:
        return []

    insider_name  = xml_text_el(owner, "reportingOwnerId/rptOwnerName")
    is_director   = xml_text_el(owner, "reportingOwnerRelationship/isDirector") == "1"
    is_officer    = xml_text_el(owner, "reportingOwnerRelationship/isOfficer") == "1"
    officer_title = xml_text_el(owner, "reportingOwnerRelationship/officerTitle")

    if not is_director and not is_officer:
        return []

    insider_title = officer_title or ("Director" if is_director else "Officer")

    purchases = []
    for txn in root.findall("nonDerivativeTable/nonDerivativeTransaction"):
        code     = xml_text_el(txn, "transactionCoding/transactionCode")
        acq_disp = xml_text_el(txn, "transactionAmounts/transactionAcquiredDisposedCode/value")

        if code != "P" or acq_disp != "A":
            continue

        shares_s = xml_text_el(txn, "transactionAmounts/transactionShares/value").replace(",", "")
        price_s  = xml_text_el(txn, "transactionAmounts/transactionPricePerShare/value").replace(",", "")
        date_s   = xml_text_el(txn, "transactionDate/value")
        security = xml_text_el(txn, "securityTitle/value") or "Common Stock"

        try:
            shares = float(shares_s)
            price  = float(price_s)
        except ValueError:
            continue

        if shares <= 0 or price <= 0:
            continue

        purchases.append({
            "issuer_name":    issuer_name,
            "issuer_ticker":  issuer_ticker,
            "insider_name":   insider_name,
            "insider_title":  insider_title,
            "transaction_date": date_s,
            "security":       security,
            "shares":         shares,
            "price_per_share": price,
            "total_value":    shares * price,
            "accession":      accession,
            "filing_url":     f"{EDGAR_BASE}/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=4&dateb=&owner=include&count=10",
        })

    return purchases

def xml_text_el(element: ET.Element, path: str) -> str:
    el = element.find(path)
    return (el.text or "").strip() if el is not None else ""

# ── main ────────────────────────────────────────────────────────────────────

def main(min_value: int = 100_000, max_filings: int = 80):
    now   = datetime.now(timezone.utc)
    start = now - timedelta(hours=24)
    start_date = start.strftime("%Y-%m-%d")
    end_date   = now.strftime("%Y-%m-%d")

    print(f"[edgar] Fetching Form 4 filings from {start_date} to {end_date} …", file=sys.stderr)
    filings = fetch_filing_list(start_date, end_date, max_filings)
    print(f"[edgar] {len(filings)} filing(s) to process", file=sys.stderr)

    all_purchases = []
    for i, (accession, cik) in enumerate(filings):
        print(f"[edgar] {i+1}/{len(filings)}  {accession}", end="\r", file=sys.stderr)
        xml = fetch_form4_xml(cik, accession)
        if xml:
            all_purchases.extend(parse_form4(xml, accession, cik))
        time.sleep(RATE_LIMIT_SLEEP)

    print(f"\n[edgar] Raw purchase transactions found: {len(all_purchases)}", file=sys.stderr)

    # Filter & rank
    meaningful = [p for p in all_purchases if p["total_value"] >= min_value]
    meaningful.sort(key=lambda x: x["total_value"], reverse=True)

    for rank, p in enumerate(meaningful, 1):
        p["rank"] = rank

    print(f"[edgar] Purchases >= ${min_value:,}: {len(meaningful)}", file=sys.stderr)

    # Human-readable summary to stderr
    print("\n" + "=" * 64, file=sys.stderr)
    print(f"  TOP INSIDER PURCHASES — Last 24h  (>{fmt_currency(min_value)})", file=sys.stderr)
    print("=" * 64, file=sys.stderr)

    if not meaningful:
        print("  No qualifying purchases found.\n", file=sys.stderr)
    else:
        for p in meaningful:
            ticker = f" ({p['issuer_ticker']})" if p["issuer_ticker"] else ""
            print(f"\n  #{p['rank']}  {p['issuer_name']}{ticker}", file=sys.stderr)
            print(f"      {p['insider_name']}  —  {p['insider_title']}", file=sys.stderr)
            print(
                f"      {p['shares']:,.0f} shares @ ${p['price_per_share']:.2f}"
                f"  =  {fmt_currency(p['total_value'])}",
                file=sys.stderr,
            )
            print(f"      Date: {p['transaction_date']}", file=sys.stderr)
        print("", file=sys.stderr)

    # Machine-readable output to stdout
    print(json.dumps(meaningful, indent=2))
    return meaningful

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch SEC insider purchases (Form 4)")
    parser.add_argument("--min-value",   type=int, default=100_000)
    parser.add_argument("--max-filings", type=int, default=80)
    args = parser.parse_args()
    main(args.min_value, args.max_filings)
