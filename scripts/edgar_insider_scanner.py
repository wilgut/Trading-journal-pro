#!/usr/bin/env python3
"""
SEC EDGAR Form 4 Insider Purchase Scanner
Scans the last 24 hours of Form 4 filings for insider purchases > $100k.
Outputs JSON ranked by total purchase value.

Usage:
  python3 edgar_insider_scanner.py              # JSON to stdout
  python3 edgar_insider_scanner.py --slack      # also post to Slack via SLACK_WEBHOOK_URL env var

Requires: SLACK_WEBHOOK_URL environment variable when using --slack flag.
Note: Requires network access to sec.gov and efts.sec.gov.
      In restricted environments, falls back to graceful error with instructions.
"""

import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests

EDGAR_SEARCH = "https://efts.sec.gov/LATEST/search-index"
EDGAR_BASE = "https://www.sec.gov"
HEADERS = {
    "User-Agent": "TradingJournalPro contact@tradingjournal.pro",
    "Accept-Encoding": "gzip, deflate",
}
MIN_VALUE = 100_000
MAX_FILINGS = 400
WORKERS = 8


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def fetch_filing_page(startdt: str, enddt: str, from_: int) -> Optional[dict]:
    url = (
        f"{EDGAR_SEARCH}?forms=4&dateRange=custom"
        f"&startdt={startdt}&enddt={enddt}&from={from_}"
    )
    try:
        r = requests.get(url, headers=HEADERS, timeout=20)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log(f"  Search page error (from={from_}): {e}")
        return None


def cik_from_accession(accession_no: str) -> str:
    """The first 10 digits of the accession number (stripped of dashes) are the filer CIK."""
    digits = accession_no.replace("-", "")
    return str(int(digits[:10]))


def find_text(xml_str: str, tag: str) -> str:
    """Extract text from a tag, handling the <tag><value>TEXT</value></tag> Form 4 pattern."""
    outer = re.search(rf"<{tag}[^>]*>([\s\S]*?)</{tag}>", xml_str, re.IGNORECASE)
    if not outer:
        return ""
    inner = re.search(r"<value[^>]*>([\s\S]*?)</value>", outer.group(1), re.IGNORECASE)
    raw = inner.group(1) if inner else outer.group(1)
    return re.sub(r"<[^>]+>", "", raw).strip()


def parse_form4(xml_str: str, filed_date: str) -> Optional[dict]:
    issuer_name = find_text(xml_str, "issuerName")
    ticker = find_text(xml_str, "issuerTradingSymbol").upper()
    owner_name = find_text(xml_str, "rptOwnerName")
    is_director = find_text(xml_str, "isDirector") == "1"
    is_officer = find_text(xml_str, "isOfficer") == "1"
    officer_title = find_text(xml_str, "officerTitle")

    if not (is_director or is_officer):
        return None

    role = officer_title if (is_officer and officer_title) else "Director"

    txn_blocks = re.findall(
        r"<nonDerivativeTransaction[\s\S]*?</nonDerivativeTransaction>",
        xml_str,
        re.IGNORECASE,
    )

    purchases = []
    for block in txn_blocks:
        code = find_text(block, "transactionCode")
        acq_disp = find_text(block, "transactionAcquiredDisposedCode")
        if code != "P" or acq_disp != "A":
            continue
        try:
            shares = float(find_text(block, "transactionShares"))
            price = float(find_text(block, "transactionPricePerShare"))
        except (ValueError, TypeError):
            continue
        if shares <= 0 or price <= 0:
            continue
        value = shares * price
        purchases.append(
            {
                "security": find_text(block, "securityTitle"),
                "date": find_text(block, "transactionDate"),
                "shares": shares,
                "price": price,
                "value": value,
            }
        )

    if not purchases:
        return None

    total_value = sum(p["value"] for p in purchases)
    if total_value < MIN_VALUE:
        return None

    return {
        "issuer_name": issuer_name,
        "ticker": ticker,
        "owner_name": owner_name,
        "role": role,
        "purchases": purchases,
        "total_value": total_value,
        "filed_date": filed_date,
    }


def fetch_and_parse(accession_no: str, filed_date: str) -> Optional[dict]:
    cik = cik_from_accession(accession_no)
    acc_nodashes = accession_no.replace("-", "")

    # Step 1: fetch filing index to discover the XML filename
    index_url = (
        f"{EDGAR_BASE}/Archives/edgar/data/{cik}"
        f"/{acc_nodashes}/{accession_no}-index.json"
    )
    try:
        idx_r = requests.get(index_url, headers=HEADERS, timeout=10)
        idx_r.raise_for_status()
        idx = idx_r.json()
    except Exception:
        return None

    docs = idx.get("documents", [])
    xml_doc = next(
        (d for d in docs if d.get("type") == "4" and d.get("filename", "").endswith(".xml")),
        next((d for d in docs if d.get("filename", "").endswith(".xml")), None),
    )
    if not xml_doc:
        return None

    # Step 2: fetch the XML
    xml_url = (
        f"{EDGAR_BASE}/Archives/edgar/data/{cik}"
        f"/{acc_nodashes}/{xml_doc['filename']}"
    )
    try:
        xml_r = requests.get(xml_url, headers=HEADERS, timeout=10)
        xml_r.raise_for_status()
    except Exception:
        return None

    return parse_form4(xml_r.text, filed_date)


def check_edgar_access() -> bool:
    """Return True if SEC EDGAR is reachable from this environment."""
    probe = f"{EDGAR_SEARCH}?forms=4&dateRange=custom&startdt=2024-01-01&enddt=2024-01-01&from=0"
    try:
        r = requests.get(probe, headers=HEADERS, timeout=8)
        return r.status_code == 200
    except Exception:
        return False


def format_slack_blocks(trades: list[dict], generated_at: str) -> list[dict]:
    """Build Slack Block Kit message for the ranked insider purchase summary."""
    ts = generated_at[:16].replace("T", " ") + " UTC"
    header_text = f":chart_with_upwards_trend: *SEC Form 4 Insider Purchases — Last 24 Hours*\n_{ts}  |  Min value: ${MIN_VALUE:,.0f}  |  Source: SEC EDGAR_"

    blocks: list[dict] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": header_text}},
        {"type": "divider"},
    ]

    if not trades:
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": "_No qualifying insider purchases found in this window._"},
        })
        return blocks

    for rank, t in enumerate(trades, 1):
        ticker = t["ticker"] or t["issuer_name"]
        value_str = f"${t['total_value']:,.0f}"
        shares_str = f"{sum(p['shares'] for p in t['purchases']):,.0f}"
        avg_price = t["total_value"] / max(sum(p["shares"] for p in t["purchases"]), 1)
        medal = {1: ":gold_medal:", 2: ":second_place_medal:", 3: ":third_place_medal:"}.get(rank, f"*{rank}.*")
        text = (
            f"{medal} *{ticker}* — {t['issuer_name']}\n"
            f"  › *{t['owner_name']}* ({t['role']})\n"
            f"  › {shares_str} shares @ avg ${avg_price:,.2f}  →  *{value_str}*\n"
            f"  › Filed: {t['filed_date']}"
        )
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": text}})

    blocks.append({"type": "divider"})
    blocks.append({
        "type": "context",
        "elements": [{"type": "mrkdwn", "text": f"Parsed {len(trades)} qualifying trades from SEC EDGAR Form 4 filings  •  <https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=40|View on EDGAR>"}],
    })
    return blocks


def post_to_slack(webhook_url: str, trades: list[dict], generated_at: str) -> bool:
    blocks = format_slack_blocks(trades, generated_at)
    payload = {"blocks": blocks}
    try:
        r = requests.post(webhook_url, json=payload, timeout=15)
        r.raise_for_status()
        return True
    except Exception as e:
        log(f"Slack post failed: {e}")
        return False


def main() -> list[dict]:
    now = datetime.now(timezone.utc)
    yesterday = now - timedelta(hours=24)
    startdt = yesterday.strftime("%Y-%m-%d")
    enddt = now.strftime("%Y-%m-%d")

    log(f"Scanning Form 4 filings: {startdt} → {enddt}")

    if not check_edgar_access():
        log("ERROR: SEC EDGAR is not reachable from this environment.")
        log("       Ensure outbound HTTPS to sec.gov and efts.sec.gov is allowed.")
        log("       To run locally: python3 edgar_insider_scanner.py")
        return []

    # Collect filing references
    filings: list[dict] = []
    from_ = 0
    page_size = 100

    while len(filings) < MAX_FILINGS:
        data = fetch_filing_page(startdt, enddt, from_)
        if not data:
            break
        hits = data.get("hits", {}).get("hits", [])
        if not hits:
            break
        for hit in hits:
            src = hit.get("_source", {})
            filings.append(
                {
                    "accession_no": src.get("accession_no", hit["_id"]),
                    "filed_date": src.get("file_date", startdt),
                }
            )
        total = data.get("hits", {}).get("total", {}).get("value", 0)
        from_ += page_size
        if from_ >= total:
            break

    log(f"Fetched {len(filings)} Form 4 filings — parsing...")

    results: list[dict] = []
    done = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {
            pool.submit(fetch_and_parse, f["accession_no"], f["filed_date"]): f
            for f in filings
        }
        for future in as_completed(futures):
            done += 1
            if done % 50 == 0:
                log(f"  Processed {done}/{len(filings)} ...")
            try:
                result = future.result()
                if result:
                    results.append(result)
            except Exception:
                pass

    results.sort(key=lambda x: x["total_value"], reverse=True)
    log(f"Found {len(results)} qualifying insider purchases (≥ ${MIN_VALUE:,.0f})")
    return results


if __name__ == "__main__":
    use_slack = "--slack" in sys.argv
    trades = main()
    generated_at = datetime.now(timezone.utc).isoformat()

    if use_slack:
        webhook = os.environ.get("SLACK_WEBHOOK_URL", "")
        if not webhook:
            log("ERROR: SLACK_WEBHOOK_URL env var not set — skipping Slack post.")
        else:
            ok = post_to_slack(webhook, trades, generated_at)
            log(f"Slack post: {'OK' if ok else 'FAILED'}")

    print(json.dumps({"generated_at": generated_at, "count": len(trades), "trades": trades}, indent=2))
