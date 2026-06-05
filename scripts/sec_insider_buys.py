#!/usr/bin/env python3
"""
SEC EDGAR insider purchase scanner.

Fetches Form 4 filings from the last 24 hours via the EDGAR full-text search
API, filters for open-market purchases (transaction code P) above MIN_USD,
and posts a ranked Slack summary via an incoming webhook.

Usage:
    python3 scripts/sec_insider_buys.py
    SLACK_WEBHOOK_URL=https://... python3 scripts/sec_insider_buys.py

Environment variables:
    SLACK_WEBHOOK_URL   Slack incoming webhook URL (required to post)
    MIN_PURCHASE_USD    Minimum purchase value in USD (default: 100000)
    LOOKBACK_HOURS      How many hours back to scan (default: 24)
    DRY_RUN             Set to "1" to print without posting to Slack
"""

import os
import sys
import json
import time
import re
import xml.etree.ElementTree as ET
import requests
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from typing import Optional

# ── Config ────────────────────────────────────────────────────────────────────
HEADERS = {"User-Agent": "TradingJournalPro wilfred.gutierrez@gmail.com"}
SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
MIN_PURCHASE_USD = float(os.environ.get("MIN_PURCHASE_USD", "100000"))
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"
REQUEST_DELAY = 0.12  # seconds between EDGAR calls (rate-limit courtesy)


# ── Data model ────────────────────────────────────────────────────────────────
@dataclass
class InsiderBuy:
    company: str
    ticker: str
    insider_name: str
    insider_title: str
    shares: float
    price_per_share: float
    total_value: float
    transaction_date: str
    filing_url: str


# ── EDGAR fetching ────────────────────────────────────────────────────────────
def fetch_recent_form4_index(since_dt: datetime) -> list[dict]:
    """
    Query the EDGAR EFTS search API for Form 4 filings filed since since_dt.
    Returns a list of dicts with keys: index_url, entity_name, file_date.
    """
    since_str = since_dt.strftime("%Y-%m-%d")
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    url = (
        "https://efts.sec.gov/LATEST/search-index"
        f"?forms=4&dateRange=custom&startdt={since_str}&enddt={today_str}"
        "&from=0&size=200"
    )
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()

    hits = resp.json().get("hits", {}).get("hits", [])
    results = []
    for hit in hits:
        src = hit.get("_source", {})
        entity_id = src.get("entity_id", "")
        accession_no = hit.get("_id", "")
        if not entity_id or not accession_no:
            continue
        acc_clean = accession_no.replace("-", "")
        index_url = (
            f"https://www.sec.gov/Archives/edgar/data/{entity_id}"
            f"/{acc_clean}/{accession_no}-index.htm"
        )
        results.append({
            "index_url": index_url,
            "entity_name": src.get("entity_name", ""),
            "file_date": src.get("file_date", ""),
        })
    return results


def find_xml_in_index(index_url: str) -> Optional[str]:
    """Fetch filing index page and return URL of the Form 4 XML document."""
    resp = requests.get(index_url, headers=HEADERS, timeout=20)
    if resp.status_code != 200:
        return None
    m = re.search(r'href="(/Archives/edgar/data/\d+/\d+/[^"]+\.xml)"', resp.text)
    if m:
        return "https://www.sec.gov" + m.group(1)
    return None


def parse_form4_xml(xml_url: str) -> Optional[InsiderBuy]:
    """
    Parse a Form 4 XML and return an InsiderBuy for qualifying open-market
    purchases (transaction code 'P'), or None if none qualify.
    """
    resp = requests.get(xml_url, headers=HEADERS, timeout=20)
    if resp.status_code != 200:
        return None
    try:
        root = ET.fromstring(resp.content)
    except ET.ParseError:
        return None

    def txt(tag: str) -> str:
        el = root.find(f".//{tag}")
        return el.text.strip() if el is not None and el.text else ""

    issuer_name = txt("issuerName") or "Unknown"
    ticker = txt("issuerTradingSymbol") or "N/A"
    insider_name = txt("rptOwnerName") or "Unknown"
    insider_title = txt("officerTitle") or txt("relationship") or "Director/Officer"

    purchases = []
    for tx in root.findall(".//nonDerivativeTransaction"):
        code_el = tx.find(".//transactionCode")
        if code_el is None or (code_el.text or "").strip() != "P":
            continue
        shares_el = tx.find(".//transactionShares/value")
        price_el = tx.find(".//transactionPricePerShare/value")
        date_el = tx.find(".//transactionDate/value")
        if shares_el is None or price_el is None:
            continue
        try:
            shares = float(shares_el.text)
            price = float(price_el.text)
        except (ValueError, TypeError):
            continue
        value = shares * price
        if value > 0:
            purchases.append({
                "shares": shares,
                "price": price,
                "value": value,
                "date": date_el.text if date_el is not None and date_el.text else "",
            })

    if not purchases:
        return None

    total_value = sum(p["value"] for p in purchases)
    if total_value < MIN_PURCHASE_USD:
        return None

    total_shares = sum(p["shares"] for p in purchases)
    avg_price = total_value / total_shares if total_shares else 0

    return InsiderBuy(
        company=issuer_name,
        ticker=ticker,
        insider_name=insider_name,
        insider_title=insider_title,
        shares=total_shares,
        price_per_share=avg_price,
        total_value=total_value,
        transaction_date=purchases[0]["date"],
        filing_url=xml_url,
    )


# ── Main scan ─────────────────────────────────────────────────────────────────
def scan(since_dt: datetime) -> list[InsiderBuy]:
    print(f"Scanning Form 4 filings since {since_dt.strftime('%Y-%m-%d %H:%M UTC')}")
    index_entries = fetch_recent_form4_index(since_dt)
    print(f"Found {len(index_entries)} Form 4 filings to inspect")

    buys: list[InsiderBuy] = []
    errors = 0
    for entry in index_entries:
        try:
            xml_url = find_xml_in_index(entry["index_url"])
            if not xml_url:
                continue
            buy = parse_form4_xml(xml_url)
            if buy:
                buys.append(buy)
                print(f"  ✓ {buy.company} ({buy.ticker}): {buy.insider_name} — ${buy.total_value:,.0f}")
            time.sleep(REQUEST_DELAY)
        except Exception as e:
            errors += 1
            if errors <= 3:
                print(f"  ! Error on {entry.get('index_url', '')[:80]}: {e}")

    print(f"Done — {len(buys)} qualifying purchases (errors: {errors})")
    return buys


# ── Slack formatting ──────────────────────────────────────────────────────────
MEDALS = {1: ":first_place_medal:", 2: ":second_place_medal:", 3: ":third_place_medal:"}


def build_slack_message(buys: list[InsiderBuy]) -> str:
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    header = (
        f"*SEC EDGAR — Insider Open-Market Purchases (Last {LOOKBACK_HOURS}h)*\n"
        f"_{now_str} | Minimum: ${MIN_PURCHASE_USD:,.0f} | Transaction code P only_\n"
    )
    if not buys:
        return header + "\n_No qualifying purchases found._"

    ranked = sorted(buys, key=lambda b: b.total_value, reverse=True)
    lines = []
    for i, b in enumerate(ranked, 1):
        badge = MEDALS.get(i, f"*#{i}*")
        value_str = f"${b.total_value:,.0f}"
        detail = f"{b.shares:,.0f} sh @ ${b.price_per_share:.2f} | {b.transaction_date}"
        lines.append(
            f"{badge} *{b.company}* (`{b.ticker}`) — *{value_str}*\n"
            f"   _{b.insider_name}_, {b.insider_title}\n"
            f"   {detail}"
        )

    edgar_link = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4"
    footer = (
        f"\n_<{edgar_link}|Source: SEC EDGAR Form 4> | "
        f"{len(ranked)} purchase{'s' if len(ranked) != 1 else ''} above ${MIN_PURCHASE_USD:,.0f}_"
    )
    return header + "\n\n" + "\n\n".join(lines) + "\n" + footer


def post_to_slack(message: str) -> None:
    if DRY_RUN or not SLACK_WEBHOOK_URL:
        print("\n── Slack message (dry run / no webhook set) ──────────────────")
        print(message)
        print("──────────────────────────────────────────────────────────────")
        return
    resp = requests.post(
        SLACK_WEBHOOK_URL,
        headers={"Content-Type": "application/json"},
        data=json.dumps({"text": message}),
        timeout=15,
    )
    if resp.status_code == 200:
        print("Posted to Slack.")
    else:
        print(f"Slack post failed: {resp.status_code} {resp.text}", file=sys.stderr)
        sys.exit(1)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    since_dt = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
    buys = scan(since_dt)
    message = build_slack_message(buys)
    post_to_slack(message)
