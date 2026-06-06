#!/usr/bin/env python3
"""
SEC EDGAR Insider Buying Scanner

Fetches Form 4 filings from the last 24 hours, filters for executive/director
open-market purchases > $100k, and returns a ranked list by dollar value.

Usage:
    python3 scripts/sec_insider_buys.py

Requirements:
    pip install requests

NOTE: SEC EDGAR (www.sec.gov / data.sec.gov / efts.sec.gov) blocks requests
from cloud-provider IP ranges (AWS, GCP, Azure). Run this script from a
residential or corporate network, or use a proxy/VPN that routes through a
non-cloud IP. The SEC fair-access policy also requires a descriptive User-Agent
header (set via HEADERS below). See https://www.sec.gov/os/accessing-edgar-data
"""

import requests
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
import json
import time
import sys

# SEC requires an identifying User-Agent per their fair-access policy
HEADERS = {
    "User-Agent": "TradingJournalPro WILFRED.GUTIERREZ@gmail.com",
    "Accept-Encoding": "gzip, deflate",
    "Accept": "application/json, text/html, */*",
}

MIN_PURCHASE_VALUE = 100_000   # $100k threshold
MAX_FILINGS = 80               # cap to stay well within rate limits
REQUEST_DELAY = 0.12           # 12 req/s max per SEC policy


# ---------------------------------------------------------------------------
# EDGAR helpers
# ---------------------------------------------------------------------------

def get_date_range(days: int = 1):
    now = datetime.now()
    end = now.strftime("%Y-%m-%d")
    start = (now - timedelta(days=days)).strftime("%Y-%m-%d")
    return start, end


def efts_search(start_date: str, end_date: str, size: int = MAX_FILINGS) -> list:
    """
    Call the EDGAR full-text search index for Form 4 filings.
    Returns a list of hit dicts from the response.
    """
    url = "https://efts.sec.gov/LATEST/search-index"
    params = {
        "forms": "4",
        "dateRange": "custom",
        "startdt": start_date,
        "enddt": end_date,
        "hits.hits.total.value": "true",
    }
    resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data.get("hits", {}).get("hits", [])


def efts_search_recent(size: int = MAX_FILINGS) -> list:
    """Fallback: grab the most recent Form 4 filings (no date filter)."""
    url = "https://efts.sec.gov/LATEST/search-index"
    params = {"forms": "4"}
    resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data.get("hits", {}).get("hits", [])[:size]


def get_filing_index(cik: str, acc_dashes: str) -> dict | None:
    """Fetch the filing's index JSON to enumerate documents."""
    acc_nodash = acc_dashes.replace("-", "")
    url = (
        f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodash}/"
        f"{acc_dashes}-index.json"
    )
    try:
        resp = requests.get(url, headers=HEADERS, timeout=20)
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return None


def fetch_form4_xml(cik: str, acc_dashes: str, filename: str) -> str | None:
    """Download the Form 4 XML document."""
    acc_nodash = acc_dashes.replace("-", "")
    url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodash}/{filename}"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=20)
        if resp.status_code == 200 and resp.text.strip():
            return resp.text
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# XML parser
# ---------------------------------------------------------------------------

def _text(el) -> str:
    return el.text.strip() if el is not None and el.text else ""


def parse_form4(xml_content: str, acc_no: str, file_date: str) -> list:
    """
    Parse a Form 4 XML document and return qualifying purchase records.
    Transaction code 'P' = open-market purchase.
    """
    results = []
    try:
        # Strip namespace declarations that trip up ElementTree
        xml_clean = xml_content.replace(" xmlns=", " _xmlns=")
        root = ET.fromstring(xml_clean)
    except ET.ParseError:
        return results

    # Issuer (company)
    issuer = root.find(".//issuer")
    company = _text(issuer.find("issuerName")) if issuer is not None else ""
    ticker = _text(issuer.find("issuerTradingSymbol")).upper() if issuer is not None else ""

    # Reporting owner (insider)
    owner_name, owner_title = "", ""
    is_director = is_officer = False
    ro = root.find(".//reportingOwner")
    if ro is not None:
        oid = ro.find("reportingOwnerId")
        if oid is not None:
            owner_name = _text(oid.find("rptOwnerName"))
        rel = ro.find("reportingOwnerRelationship")
        if rel is not None:
            is_director = _text(rel.find("isDirector")) == "1"
            is_officer = _text(rel.find("isOfficer")) == "1"
            is_10pct = _text(rel.find("isTenPercentOwner")) == "1"
            owner_title = _text(rel.find("officerTitle"))
            if not owner_title:
                owner_title = "Director" if is_director else ("10% Owner" if is_10pct else "Insider")

    # Non-derivative (common stock) transactions
    for tx in root.findall(".//nonDerivativeTransaction"):
        code = _text(tx.find(".//transactionCode"))
        if code != "P":
            continue

        acq = _text(tx.find(".//transactionAcquiredDisposedCode/value"))
        if acq and acq != "A":
            continue  # skip disposals mis-coded P

        try:
            shares = float(_text(tx.find(".//transactionShares/value")))
            price = float(_text(tx.find(".//transactionPricePerShare/value")))
        except (ValueError, TypeError):
            continue

        if shares <= 0 or price <= 0:
            continue

        total = shares * price
        if total < MIN_PURCHASE_VALUE:
            continue

        tx_date = _text(tx.find(".//transactionDate/value")) or file_date

        results.append(
            {
                "company": company,
                "ticker": ticker,
                "insider": owner_name,
                "title": owner_title,
                "shares": int(shares),
                "price": price,
                "total_value": total,
                "tx_date": tx_date,
                "file_date": file_date,
                "is_director": is_director,
                "is_officer": is_officer,
                "sec_url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=&State=0&SIC=&dateb=&owner=include&count=5&search_text=&action=getcompany",
                "filing_url": f"https://www.sec.gov/Archives/edgar/data/",
            }
        )

    return results


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def run_scan(verbose: bool = True) -> list:
    start_date, end_date = get_date_range(days=1)
    log = print if verbose else lambda *a, **k: None

    log(f"[EDGAR scan] date range: {start_date} → {end_date}", flush=True)

    # 1. Get filing list
    hits = []
    try:
        hits = efts_search(start_date, end_date)
        log(f"[EDGAR scan] EFTS returned {len(hits)} Form 4 filings", flush=True)
    except Exception as exc:
        log(f"[EDGAR scan] EFTS error: {exc}", flush=True)

    if not hits:
        log("[EDGAR scan] No dated results – falling back to most-recent feed", flush=True)
        try:
            hits = efts_search_recent()
            log(f"[EDGAR scan] Recent feed: {len(hits)} filings", flush=True)
        except Exception as exc:
            log(f"[EDGAR scan] Recent feed error: {exc}", flush=True)
            return []

    # 2. Process each filing
    all_purchases = []
    processed = 0

    for hit in hits[:MAX_FILINGS]:
        src = hit.get("_source", {})
        file_date = src.get("file_date", end_date)
        acc_dashes = hit.get("_id", "")
        if not acc_dashes or "-" not in acc_dashes:
            continue

        # CIK = first segment of accession number, strip leading zeros
        raw_cik = acc_dashes.split("-")[0].lstrip("0") or "0"

        index = get_filing_index(raw_cik, acc_dashes)
        time.sleep(REQUEST_DELAY)

        if not index:
            continue

        # Find the primary Form 4 XML document
        xml_filename = None
        for doc in index.get("documents", []):
            dtype = doc.get("type", "").strip()
            url_path = doc.get("documentUrl", "") or doc.get("url", "")
            fname = url_path.split("/")[-1] if url_path else ""
            if dtype in ("4", "4/A") and fname.lower().endswith(".xml"):
                xml_filename = fname
                break
        if not xml_filename:
            # Fallback: first XML in the filing
            for doc in index.get("documents", []):
                url_path = doc.get("documentUrl", "") or doc.get("url", "")
                fname = url_path.split("/")[-1] if url_path else ""
                if fname.lower().endswith(".xml"):
                    xml_filename = fname
                    break

        if not xml_filename:
            continue

        xml = fetch_form4_xml(raw_cik, acc_dashes, xml_filename)
        time.sleep(REQUEST_DELAY)

        if not xml:
            continue

        purchases = parse_form4(xml, acc_dashes, file_date)
        all_purchases.extend(purchases)
        processed += 1

        if verbose and purchases:
            for p in purchases:
                log(
                    f"  ✓ {p['ticker'] or p['company']}: {p['insider']} "
                    f"bought {p['shares']:,} sh @ ${p['price']:.2f} "
                    f"= ${p['total_value']:,.0f}",
                    flush=True,
                )

    log(
        f"[EDGAR scan] Processed {processed} filings → "
        f"{len(all_purchases)} qualifying purchases (>${MIN_PURCHASE_VALUE:,})",
        flush=True,
    )

    # Rank by dollar value descending
    all_purchases.sort(key=lambda x: x["total_value"], reverse=True)
    return all_purchases


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def fmt_money(v: float) -> str:
    if v >= 1_000_000:
        return f"${v / 1_000_000:.2f}M"
    return f"${v / 1_000:.0f}K"


def build_slack_message(purchases: list, start_date: str, end_date: str) -> str:
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M UTC")

    if not purchases:
        return (
            f"*SEC EDGAR — Insider Purchases >$100K* | {start_date} → {end_date}\n"
            f"_No qualifying open-market purchases found in this window._\n"
            f"_Scanned at {now_str}_"
        )

    lines = [
        f"*:chart_with_upwards_trend: SEC Insider Buys — Top {min(len(purchases), 20)} Purchases >$100K*",
        f"_{start_date} → {end_date} | Scanned {now_str}_",
        "",
        "| # | Ticker | Company | Insider | Title | Shares | Price | Total |",
        "|---|--------|---------|---------|-------|--------|-------|-------|",
    ]

    for i, p in enumerate(purchases[:20], 1):
        ticker = f"`{p['ticker']}`" if p["ticker"] else "—"
        company = p["company"][:28] + ("…" if len(p["company"]) > 28 else "")
        insider = p["insider"][:22] + ("…" if len(p["insider"]) > 22 else "")
        title = p["title"][:18] + ("…" if len(p["title"]) > 18 else "")
        lines.append(
            f"| {i} | {ticker} | {company} | {insider} | {title} "
            f"| {p['shares']:,} | ${p['price']:.2f} | **{fmt_money(p['total_value'])}** |"
        )

    lines += [
        "",
        f"_Source: SEC EDGAR Form 4 filings · Filtered: open-market purchases (code P) · Threshold: $100K_",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    purchases = run_scan(verbose=True)
    start_date, end_date = get_date_range(days=1)
    msg = build_slack_message(purchases, start_date, end_date)
    print("\n--- SLACK MESSAGE PREVIEW ---")
    print(msg)
    print(json.dumps(purchases[:5], indent=2))
