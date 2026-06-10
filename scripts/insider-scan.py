#!/usr/bin/env python3
"""
Live SEC EDGAR Form 4 insider purchase scanner.
Fetches filings from the last 24 hours, filters for open-market purchases >$100K,
and prints a JSON array ranked by total value.

Usage:
  python scripts/insider-scan.py [--min-value 100000] [--hours-back 24] [--limit 60]
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Optional

EDGAR_BASE = "https://www.sec.gov"
EFTS_SEARCH = "https://efts.sec.gov/LATEST/search-index"
USER_AGENT = "TradingJournalPro/1.0 WILFRED.GUTIERREZ@gmail.com"


def edgar_get(url: str, retries: int = 3) -> Optional[str]:
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"}
            )
            with urllib.request.urlopen(req, timeout=12) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(2 ** attempt)
            elif e.code == 404:
                return None
            else:
                return None
        except Exception:
            if attempt < retries:
                time.sleep(1)
    return None


def search_filings(start: str, end: str, size: int = 200) -> list:
    params = urllib.parse.urlencode(
        {"q": "", "forms": "4", "dateRange": "custom",
         "startdt": start, "enddt": end, "from": "0", "size": str(size)}
    )
    data = edgar_get(f"{EFTS_SEARCH}?{params}")
    if not data:
        return []
    try:
        return json.loads(data).get("hits", {}).get("hits", [])
    except Exception:
        return []


def get_xml_doc_name(cik: str, acc_no: str) -> Optional[str]:
    cik_num = cik.lstrip("0") or "0"
    acc_dash = acc_no.replace("-", "")
    url = f"{EDGAR_BASE}/Archives/edgar/data/{cik_num}/{acc_dash}/{acc_no}-index.json"
    data = edgar_get(url)
    if not data:
        return None
    try:
        items = json.loads(data).get("directory", {}).get("item", [])
        if isinstance(items, dict):
            items = [items]
        for item in items:
            if item.get("type") in ("4", "4/A") and item.get("name", "").endswith(".xml"):
                return item["name"]
    except Exception:
        pass
    return None


def _text(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def parse_form4(xml_content: str) -> Optional[dict]:
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError:
        return None

    company = _text(root.find(".//issuerName"))
    ticker = _text(root.find(".//issuerTradingSymbol")).upper()
    insider = _text(root.find(".//rptOwnerName"))
    is_director = _text(root.find(".//isDirector")) == "1"
    is_officer = _text(root.find(".//isOfficer")) == "1"
    title = _text(root.find(".//officerTitle"))

    purchases = []
    for txn in root.findall(".//nonDerivativeTransaction"):
        code = _text(txn.find(".//transactionCode"))
        adc = _text(txn.find(".//transactionAcquiredDisposedCode/value"))
        if code != "P" or adc != "A":
            continue
        shares_el = txn.find(".//transactionShares/value")
        price_el = txn.find(".//transactionPricePerShare/value")
        date_el = txn.find(".//transactionDate/value")
        try:
            shares = float(_text(shares_el))
            price = float(_text(price_el))
        except (ValueError, TypeError):
            continue
        if shares <= 0 or price <= 0:
            continue
        purchases.append({
            "shares": shares,
            "price": price,
            "total": shares * price,
            "date": _text(date_el),
        })

    if not purchases:
        return None

    return {
        "company": company, "ticker": ticker,
        "insider": insider, "is_director": is_director,
        "is_officer": is_officer, "title": title,
        "purchases": purchases,
    }


def process_filing(hit: dict) -> list:
    src = hit.get("_source", {})
    cik = src.get("entity_id", "")
    acc_no = src.get("accession_no", "")
    filed = src.get("file_date", "")
    if not cik or not acc_no:
        return []

    cik_num = cik.lstrip("0") or "0"
    acc_dash = acc_no.replace("-", "")

    doc_name = get_xml_doc_name(cik, acc_no)
    if not doc_name:
        return []

    xml_url = f"{EDGAR_BASE}/Archives/edgar/data/{cik_num}/{acc_dash}/{doc_name}"
    xml_content = edgar_get(xml_url)
    if not xml_content:
        return []

    parsed = parse_form4(xml_content)
    if not parsed:
        return []

    i_title = (
        parsed["title"] or "Officer" if parsed["is_officer"]
        else "Director" if parsed["is_director"]
        else "Insider"
    )
    filing_url = f"{EDGAR_BASE}/Archives/edgar/data/{cik_num}/{acc_dash}/{acc_no}-index.htm"

    return [
        {
            "companyName": parsed["company"],
            "ticker": parsed["ticker"],
            "insiderName": parsed["insider"],
            "insiderTitle": i_title,
            "shares": p["shares"],
            "pricePerShare": p["price"],
            "totalValue": p["total"],
            "transactionDate": p["date"],
            "filedDate": filed,
            "secFilingUrl": filing_url,
        }
        for p in parsed["purchases"]
    ]


def run(min_value: int, hours_back: int, limit: int) -> list:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=hours_back)
    start_date = cutoff.strftime("%Y-%m-%d")
    end_date = now.strftime("%Y-%m-%d")

    print(f"[EDGAR] Searching Form 4 filings {start_date} → {end_date} …", file=sys.stderr)
    hits = search_filings(start_date, end_date, 200)
    print(f"[EDGAR] {len(hits)} filings found — processing first {min(len(hits), limit)}", file=sys.stderr)

    hits = hits[:limit]
    results = []
    WORKERS = 5  # 5 concurrent × 2 calls each = 10 req/s (SEC limit)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(process_filing, h): h for h in hits}
        done = 0
        for future in as_completed(futures):
            done += 1
            try:
                results.extend(future.result())
            except Exception:
                pass
            if done % 10 == 0 or done == len(hits):
                print(f"[EDGAR] {done}/{len(hits)} processed, {len(results)} purchases found so far", file=sys.stderr)
            # gentle throttle between completions
            time.sleep(0.12)

    filtered = [r for r in results if r["totalValue"] >= min_value]
    filtered.sort(key=lambda x: x["totalValue"], reverse=True)
    return filtered


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-value", type=int, default=100_000)
    parser.add_argument("--hours-back", type=int, default=24)
    parser.add_argument("--limit", type=int, default=60)
    args = parser.parse_args()

    purchases = run(args.min_value, args.hours_back, args.limit)
    print(json.dumps(purchases, indent=2))
