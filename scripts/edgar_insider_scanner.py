#!/usr/bin/env python3
"""
SEC EDGAR Form 4 Insider Purchase Scanner
Scans Form 4 filings from the last 24 hours, filters for purchases >$100k,
ranks by value, and posts a summary to Slack.

Usage:
    SLACK_BOT_TOKEN=xoxb-... python3 scripts/edgar_insider_scanner.py

SEC EDGAR API requires: User-Agent: "AppName contact@email.com"
Rate limit: 10 requests/second
"""

import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests

# ── Configuration ─────────────────────────────────────────────────────────────
EDGAR_EFTS_URL = "https://efts.sec.gov/LATEST/search-index"
EDGAR_ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data"
EDGAR_FILING_INDEX = "https://www.sec.gov/cgi-bin/browse-edgar"
SEC_USER_AGENT = "TradingJournalPro admin@tradingjournal.pro"

SLACK_CHANNEL = os.environ.get("SLACK_CHANNEL", "C0AUARBCPND")  # #sec-form4-insider-scanner
SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN", "")

MIN_PURCHASE_VALUE = 100_000       # $100k threshold
MAX_SLACK_RESULTS = 25             # Top N to display in Slack
REQUEST_DELAY = 0.12               # ~8 req/sec, below 10/sec limit
FETCH_TIMEOUT = 15                 # seconds per HTTP request


# ── HTTP session ──────────────────────────────────────────────────────────────
def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": SEC_USER_AGENT,
        "Accept": "application/json, text/html, */*",
        "Accept-Encoding": "gzip, deflate, br",
    })
    return session


# ── Date helpers ──────────────────────────────────────────────────────────────
def last_24h_range() -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    return (now - timedelta(hours=24)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")


# ── EDGAR filing discovery ────────────────────────────────────────────────────
def fetch_form4_index(session: requests.Session, start: str, end: str) -> list[dict]:
    """
    Pull a paginated list of Form 4 filings from the EDGAR full-text search.
    Returns a flat list of hit dicts with _id (accession) and _source fields.
    """
    all_hits: list[dict] = []
    from_idx = 0
    page_size = 50

    while True:
        params = {
            "forms": "4",
            "dateRange": "custom",
            "startdt": start,
            "enddt": end,
            "from": from_idx,
            "size": page_size,
        }
        try:
            resp = session.get(EDGAR_EFTS_URL, params=params, timeout=FETCH_TIMEOUT)
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            print(f"[WARN] EFTS request failed (from={from_idx}): {exc}", file=sys.stderr)
            break

        hits = data.get("hits", {}).get("hits", [])
        total = data.get("hits", {}).get("total", {}).get("value", 0)
        all_hits.extend(hits)

        from_idx += page_size
        if from_idx >= total or not hits:
            break

        time.sleep(REQUEST_DELAY)

    print(f"[INFO] Retrieved {len(all_hits)} Form 4 filings from EDGAR index")
    return all_hits


# ── XML filing fetcher ────────────────────────────────────────────────────────
def _accession_parts(raw: str) -> tuple[str, str]:
    """Return (clean_no_dashes, dashed) accession number formats."""
    clean = raw.replace("-", "")
    dashed = f"{clean[:10]}-{clean[10:12]}-{clean[12:]}"
    return clean, dashed


def fetch_form4_xml(session: requests.Session, accession_raw: str, cik: str) -> Optional[str]:
    """
    Fetch the primary XML document for a Form 4 filing.
    Tries the filing index page to locate the .xml file, then fetches it.
    """
    clean, dashed = _accession_parts(accession_raw)
    index_url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{clean}/{dashed}-index.htm"

    try:
        resp = session.get(index_url, timeout=FETCH_TIMEOUT)
        resp.raise_for_status()
        # Find the primary XML document link in the HTML index
        match = re.search(r'href="(/Archives/edgar/data/[^"]+\.xml)"', resp.text, re.IGNORECASE)
        if not match:
            return None
        xml_url = "https://www.sec.gov" + match.group(1)
        time.sleep(REQUEST_DELAY)
        xml_resp = session.get(xml_url, timeout=FETCH_TIMEOUT)
        xml_resp.raise_for_status()
        return xml_resp.text
    except Exception as exc:
        print(f"[WARN] Could not fetch XML for {accession_raw}: {exc}", file=sys.stderr)
        return None


# ── Form 4 XML parser ─────────────────────────────────────────────────────────
def parse_purchases(xml_text: str, file_date: str) -> list[dict]:
    """
    Parse a Form 4 XML document and return a list of purchase transactions.
    Filters to transactionCode == 'P' (open-market purchase).
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    # Issuer
    issuer = root.find(".//issuer")
    company = (issuer.findtext("issuerName") or "").strip() if issuer is not None else ""
    ticker = (issuer.findtext("issuerTradingSymbol") or "").strip() if issuer is not None else ""

    # Reporting owner
    owner = root.find(".//reportingOwner")
    insider_name, role = "", ""
    if owner is not None:
        oid = owner.find("reportingOwnerId")
        insider_name = (oid.findtext("rptOwnerName") or "").strip() if oid is not None else ""

        rel = owner.find("reportingOwnerRelationship")
        if rel is not None:
            if rel.findtext("isDirector") == "1":
                role = "Director"
            elif rel.findtext("isOfficer") == "1":
                role = (rel.findtext("officerTitle") or "Officer").strip()
            elif rel.findtext("isTenPercentOwner") == "1":
                role = "10% Owner"
            else:
                role = "Other"

    purchases = []
    for tx in root.findall(".//nonDerivativeTransaction"):
        # Must be a purchase
        code_el = tx.find(".//transactionCoding/transactionCode")
        if code_el is None or code_el.text != "P":
            continue

        # Must be acquired (not disposed)
        adc = tx.find(".//transactionAmounts/transactionAcquiredDisposedCode/value")
        if adc is not None and adc.text == "D":
            continue

        shares_el = tx.find(".//transactionAmounts/transactionShares/value")
        price_el = tx.find(".//transactionAmounts/transactionPricePerShare/value")
        date_el = tx.find(".//transactionDate/value")

        try:
            shares = float(shares_el.text) if shares_el is not None else 0.0
            price = float(price_el.text) if price_el is not None else 0.0
            trade_date = date_el.text.strip() if date_el is not None else file_date
        except (ValueError, TypeError, AttributeError):
            continue

        total_value = shares * price
        if total_value > 0:
            purchases.append({
                "company": company,
                "ticker": ticker or "N/A",
                "insider": insider_name,
                "role": role or "Insider",
                "shares": shares,
                "price": price,
                "value": total_value,
                "trade_date": trade_date,
                "file_date": file_date,
            })

    return purchases


# ── Slack formatting ──────────────────────────────────────────────────────────
def _fmt_usd(n: float) -> str:
    if n >= 1_000_000:
        return f"${n/1_000_000:.2f}M"
    if n >= 1_000:
        return f"${n/1_000:.1f}K"
    return f"${n:.0f}"


def build_slack_blocks(purchases: list[dict], start: str, end: str) -> list[dict]:
    """Build Slack Block Kit message for the ranked insider purchase summary."""
    run_ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    shown = purchases[:MAX_SLACK_RESULTS]

    # Header
    blocks: list[dict] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "🏦 SEC Form 4 — Insider Purchases >$100K"},
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": f"*Period:* {start} → {end}  |  *Scanned:* {run_ts}  |  *Source:* SEC EDGAR Form 4",
                }
            ],
        },
        {"type": "divider"},
    ]

    if not purchases:
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": "_No insider purchases over $100,000 found in the last 24 hours._"},
        })
        return blocks

    # Summary stat
    total_deployed = sum(p["value"] for p in purchases)
    blocks.append({
        "type": "section",
        "fields": [
            {"type": "mrkdwn", "text": f"*Qualifying purchases:*\n{len(purchases)}"},
            {"type": "mrkdwn", "text": f"*Total capital deployed:*\n{_fmt_usd(total_deployed)}"},
        ],
    })
    blocks.append({"type": "divider"})

    # Ranked table (top 25)
    rows = ["```", f"{'#':<3} {'Ticker':<7} {'Value':>9}  {'Insider':<22} {'Role':<18} {'Company'}", "─" * 95]
    for i, p in enumerate(shown, 1):
        company_s = p["company"][:30] + "…" if len(p["company"]) > 31 else p["company"]
        insider_s = p["insider"][:20] + "…" if len(p["insider"]) > 21 else p["insider"]
        role_s = p["role"][:16] + "…" if len(p["role"]) > 17 else p["role"]
        rows.append(
            f"{i:<3} {p['ticker']:<7} {_fmt_usd(p['value']):>9}  {insider_s:<22} {role_s:<18} {company_s}"
        )
    rows.append("```")

    blocks.append({
        "type": "section",
        "text": {"type": "mrkdwn", "text": "\n".join(rows)},
    })

    # Top 3 spotlight
    blocks.append({"type": "divider"})
    blocks.append({
        "type": "section",
        "text": {"type": "mrkdwn", "text": "*🔍 Top 3 Spotlight*"},
    })
    for i, p in enumerate(shown[:3], 1):
        medal = ["🥇", "🥈", "🥉"][i - 1]
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"{medal} *{p['ticker']}* — {p['company']}\n"
                    f"> *{p['insider']}* ({p['role']}) bought "
                    f"*{p['shares']:,.0f} shares* @ *${p['price']:.2f}* = *{_fmt_usd(p['value'])}*\n"
                    f"> Trade date: {p['trade_date']}"
                ),
            },
        })

    blocks.append({"type": "divider"})
    blocks.append({
        "type": "context",
        "elements": [
            {
                "type": "mrkdwn",
                "text": (
                    f"Showing top {len(shown)} of {len(purchases)} qualifying purchases. "
                    "Insider buying is not investment advice. Always verify on SEC EDGAR."
                ),
            }
        ],
    })

    return blocks


def post_to_slack(blocks: list[dict], fallback_text: str) -> bool:
    if not SLACK_BOT_TOKEN:
        print("[ERROR] SLACK_BOT_TOKEN environment variable is not set.")
        return False

    resp = requests.post(
        "https://slack.com/api/chat.postMessage",
        headers={"Authorization": f"Bearer {SLACK_BOT_TOKEN}"},
        json={
            "channel": SLACK_CHANNEL,
            "text": fallback_text,
            "blocks": blocks,
        },
        timeout=15,
    )
    data = resp.json()
    if not data.get("ok"):
        print(f"[ERROR] Slack API error: {data.get('error')}", file=sys.stderr)
        return False
    return True


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    start_date, end_date = last_24h_range()
    print(f"[INFO] Scanning Form 4 filings: {start_date} → {end_date}")

    session = make_session()

    # 1. Get the list of recent Form 4 filings
    filing_index = fetch_form4_index(session, start_date, end_date)
    if not filing_index:
        print("[WARN] No filings returned. Check EDGAR connectivity and User-Agent.")

    # 2. For each filing, fetch the XML and extract purchases
    all_purchases: list[dict] = []
    for idx, hit in enumerate(filing_index):
        src = hit.get("_source", {})
        accession = hit.get("_id", "")
        file_date = src.get("file_date", end_date)

        # EDGAR stores CIK in entity_id or we extract from the accession path
        cik = str(src.get("entity_id", "")).lstrip("0") or ""
        if not cik or not accession:
            continue

        xml_text = fetch_form4_xml(session, accession, cik)
        if xml_text:
            purchases = parse_purchases(xml_text, file_date)
            all_purchases.extend(purchases)

        time.sleep(REQUEST_DELAY)
        if (idx + 1) % 50 == 0:
            print(f"[INFO] Processed {idx + 1}/{len(filing_index)} filings …")

    # 3. Filter and rank
    qualifying = sorted(
        [p for p in all_purchases if p["value"] >= MIN_PURCHASE_VALUE],
        key=lambda x: x["value"],
        reverse=True,
    )

    print(f"[INFO] {len(all_purchases)} total purchase transactions → {len(qualifying)} ≥ $100K")

    # 4. Build Slack message and post
    blocks = build_slack_blocks(qualifying, start_date, end_date)
    fallback = (
        f"SEC Form 4 Insider Scan ({start_date}→{end_date}): "
        f"{len(qualifying)} purchases >$100K. "
        + (f"Top: {qualifying[0]['ticker']} {_fmt_usd(qualifying[0]['value'])}" if qualifying else "None found.")
    )

    success = post_to_slack(blocks, fallback)
    if success:
        print("[INFO] ✓ Slack message posted successfully.")
    else:
        print("[INFO] Slack post failed — printing message JSON to stdout:")
        print(json.dumps({"blocks": blocks, "text": fallback}, indent=2))


if __name__ == "__main__":
    main()
