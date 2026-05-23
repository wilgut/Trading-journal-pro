#!/usr/bin/env python3
"""
SEC EDGAR Insider Buys Scanner
Fetches Form 4 filings from the last 24 hours, filters for purchases > $100k,
ranks by total value, and posts a summary to Slack.

Usage:
    python edgar_insider_buys.py [--demo]    # --demo uses sample data

Requirements:
    pip install requests slack-sdk   (or set SLACK_BOT_TOKEN env var)

SEC EDGAR requires a User-Agent in the format: "Company Name email@domain.com"
Set EDGAR_USER_AGENT env var, or it defaults to a generic value.
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
EDGAR_USER_AGENT = os.getenv(
    "EDGAR_USER_AGENT",
    "Trading-Journal-Pro wilfred.gutierrez@gmail.com",
)
SLACK_BOT_TOKEN = os.getenv("SLACK_BOT_TOKEN", "")
SLACK_CHANNEL = os.getenv("SLACK_CHANNEL", "C0ATEAY4P6H")  # #all-claude-trading
MIN_PURCHASE_VALUE = 100_000  # $100k threshold

EDGAR_SEARCH_URL = (
    "https://efts.sec.gov/LATEST/search-index"
    "?forms=4&dateRange=custom&startdt={start}&enddt={end}"
    "&hits.hits._source.period_of_report=true"
    "&hits.hits._source.entity_name=true"
    "&hits.hits._source.file_date=true"
    "&hits.hits._source.accession_no=true"
    "&hits.hits.total.value=true"
    "&hits.hits.highlight.period_of_report=true"
    "&hits.hits.total.relation=true"
    "&hits.hits._source.form_type=true"
    "&hits.hits.sort=file_date:desc"
    "&hits.hits.size=100"
)

EDGAR_FILING_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/form4.xml"
EDGAR_FILING_INDEX = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=100&search_text=&output=atom"


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------
def _get(url: str, timeout: int = 15) -> Optional[bytes]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": EDGAR_USER_AGENT,
            "Accept": "application/json, application/xml, text/xml, */*",
            "Accept-Encoding": "identity",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        print(f"[EDGAR] HTTP {e.code} for {url[:80]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[EDGAR] Error fetching {url[:80]}: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Fetch recent Form 4 accession numbers via EDGAR EFTS
# ---------------------------------------------------------------------------
def fetch_recent_form4_filings(days_back: int = 1) -> list[dict]:
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=days_back)).strftime("%Y-%m-%d")
    end = now.strftime("%Y-%m-%d")

    url = EDGAR_SEARCH_URL.format(start=start, end=end)
    print(f"[EDGAR] Fetching Form 4 filings {start} → {end} …")

    data = _get(url)
    if not data:
        return []

    try:
        parsed = json.loads(data)
        hits = parsed.get("hits", {}).get("hits", [])
        total = parsed.get("hits", {}).get("total", {}).get("value", 0)
        print(f"[EDGAR] Found {total} total Form 4 filings, processing {len(hits)}")
        return hits
    except json.JSONDecodeError as e:
        print(f"[EDGAR] JSON parse error: {e}", file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# Parse a Form 4 XML to extract purchase transactions
# ---------------------------------------------------------------------------
def parse_form4_xml(xml_bytes: bytes) -> list[dict]:
    """
    Returns a list of purchase transactions with keys:
        issuer_name, issuer_ticker, insider_name, insider_title,
        transaction_date, shares, price_per_share, total_value
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return []

    ns = ""  # Form 4 XML usually has no namespace prefix

    def _text(elem, path: str) -> str:
        node = elem.find(path)
        return node.text.strip() if node is not None and node.text else ""

    issuer_name = _text(root, ".//issuerName")
    issuer_ticker = _text(root, ".//issuerTradingSymbol")
    insider_name = _text(root, ".//rptOwnerName")

    titles = [
        _text(t, "officerTitle")
        for t in root.findall(".//reportingOwner")
        if _text(t, "officerTitle")
    ]
    insider_title = titles[0] if titles else _text(root, ".//isDirector") and "Director"

    transactions = []
    for txn in root.findall(".//nonDerivativeTransaction"):
        # Transaction code: P = open-market purchase
        code = _text(txn, "transactionCoding/transactionCode")
        if code not in ("P",):
            continue

        acq_disp = _text(txn, "transactionAmounts/transactionAcquiredDisposedCode/value")
        if acq_disp == "D":
            continue  # disposition, not acquisition

        try:
            shares = float(_text(txn, "transactionAmounts/transactionShares/value") or "0")
            price = float(_text(txn, "transactionAmounts/transactionPricePerShare/value") or "0")
        except ValueError:
            continue

        total = shares * price
        if total < MIN_PURCHASE_VALUE:
            continue

        txn_date = _text(txn, "transactionDate/value")

        transactions.append(
            {
                "issuer_name": issuer_name,
                "issuer_ticker": issuer_ticker,
                "insider_name": insider_name,
                "insider_title": insider_title or "Executive/Director",
                "transaction_date": txn_date,
                "shares": shares,
                "price_per_share": price,
                "total_value": total,
            }
        )
    return transactions


# ---------------------------------------------------------------------------
# Full pipeline: search → fetch XMLs → parse → filter
# ---------------------------------------------------------------------------
def get_insider_buys(days_back: int = 1) -> list[dict]:
    hits = fetch_recent_form4_filings(days_back)
    if not hits:
        return []

    all_buys = []
    for hit in hits:
        src = hit.get("_source", {})
        accession_raw = src.get("accession_no", "")
        cik = src.get("ciks", [""])[0] if src.get("ciks") else ""

        # Build XML URL from accession number
        accession = accession_raw.replace("-", "")
        xml_url = EDGAR_FILING_URL.format(cik=cik, accession=accession)

        xml_bytes = _get(xml_url)
        if xml_bytes:
            buys = parse_form4_xml(xml_bytes)
            all_buys.extend(buys)

        time.sleep(0.1)  # Be polite to EDGAR servers

    # Sort by total_value descending
    all_buys.sort(key=lambda x: x["total_value"], reverse=True)
    return all_buys


# ---------------------------------------------------------------------------
# Demo / sample data for testing without live EDGAR access
# ---------------------------------------------------------------------------
DEMO_BUYS = [
    {
        "issuer_name": "NVIDIA Corporation",
        "issuer_ticker": "NVDA",
        "insider_name": "Jensen Huang",
        "insider_title": "President and CEO",
        "transaction_date": (datetime.now() - timedelta(hours=6)).strftime("%Y-%m-%d"),
        "shares": 25000,
        "price_per_share": 887.50,
        "total_value": 22_187_500,
    },
    {
        "issuer_name": "Meta Platforms Inc.",
        "issuer_ticker": "META",
        "insider_name": "Mark Zuckerberg",
        "insider_title": "Chairman and CEO",
        "transaction_date": (datetime.now() - timedelta(hours=10)).strftime("%Y-%m-%d"),
        "shares": 15000,
        "price_per_share": 512.30,
        "total_value": 7_684_500,
    },
    {
        "issuer_name": "Palantir Technologies Inc.",
        "issuer_ticker": "PLTR",
        "insider_name": "Alex Karp",
        "insider_title": "Chief Executive Officer",
        "transaction_date": (datetime.now() - timedelta(hours=14)).strftime("%Y-%m-%d"),
        "shares": 200000,
        "price_per_share": 24.75,
        "total_value": 4_950_000,
    },
    {
        "issuer_name": "Shopify Inc.",
        "issuer_ticker": "SHOP",
        "insider_name": "Harley Finkelstein",
        "insider_title": "President",
        "transaction_date": (datetime.now() - timedelta(hours=18)).strftime("%Y-%m-%d"),
        "shares": 50000,
        "price_per_share": 78.42,
        "total_value": 3_921_000,
    },
    {
        "issuer_name": "CrowdStrike Holdings",
        "issuer_ticker": "CRWD",
        "insider_name": "George Kurtz",
        "insider_title": "President, CEO",
        "transaction_date": (datetime.now() - timedelta(hours=20)).strftime("%Y-%m-%d"),
        "shares": 8000,
        "price_per_share": 312.90,
        "total_value": 2_503_200,
    },
    {
        "issuer_name": "Duolingo Inc.",
        "issuer_ticker": "DUOL",
        "insider_name": "Luis von Ahn",
        "insider_title": "Chief Executive Officer",
        "transaction_date": (datetime.now() - timedelta(hours=22)).strftime("%Y-%m-%d"),
        "shares": 12000,
        "price_per_share": 189.55,
        "total_value": 2_274_600,
    },
    {
        "issuer_name": "Samsara Inc.",
        "issuer_ticker": "IOT",
        "insider_name": "Sanjit Biswas",
        "insider_title": "Co-Founder and CEO",
        "transaction_date": (datetime.now() - timedelta(hours=23)).strftime("%Y-%m-%d"),
        "shares": 85000,
        "price_per_share": 25.10,
        "total_value": 2_133_500,
    },
    {
        "issuer_name": "Axon Enterprise",
        "issuer_ticker": "AXON",
        "insider_name": "Rick Smith",
        "insider_title": "CEO and Founder",
        "transaction_date": (datetime.now() - timedelta(hours=21)).strftime("%Y-%m-%d"),
        "shares": 9500,
        "price_per_share": 185.00,
        "total_value": 1_757_500,
    },
    {
        "issuer_name": "Sprouts Farmers Market",
        "issuer_ticker": "SFM",
        "insider_name": "Jack Sinclair",
        "insider_title": "Director",
        "transaction_date": (datetime.now() - timedelta(hours=16)).strftime("%Y-%m-%d"),
        "shares": 22000,
        "price_per_share": 68.90,
        "total_value": 1_515_800,
    },
    {
        "issuer_name": "Wingstop Inc.",
        "issuer_ticker": "WING",
        "insider_name": "Michael Skipworth",
        "insider_title": "President & CEO",
        "transaction_date": (datetime.now() - timedelta(hours=8)).strftime("%Y-%m-%d"),
        "shares": 7000,
        "price_per_share": 195.40,
        "total_value": 1_367_800,
    },
]


# ---------------------------------------------------------------------------
# Format the Slack message
# ---------------------------------------------------------------------------
def format_slack_message(buys: list[dict], is_demo: bool = False) -> str:
    now_str = datetime.now(timezone.utc).strftime("%b %d, %Y %H:%M UTC")
    since_str = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime("%b %d %H:%M UTC")
    total_capital = sum(b["total_value"] for b in buys)

    demo_banner = "\n> :test_tube: *Demo mode* — live EDGAR data unavailable in this environment\n" if is_demo else ""

    header = (
        f"*:mag: SEC EDGAR Insider Buys — Last 24 Hours*{demo_banner}\n"
        f"_{since_str} → {now_str}_\n"
        f"Showing **{len(buys)} meaningful purchases** (>{format_dollars(MIN_PURCHASE_VALUE)} each) "
        f"• Total capital deployed: **{format_dollars(total_capital)}**\n"
        f"{'─' * 48}"
    )

    rows = []
    medals = {1: ":first_place_medal:", 2: ":second_place_medal:", 3: ":third_place_medal:"}

    for i, b in enumerate(buys, start=1):
        rank = medals.get(i, f"*#{i}*")
        ticker = f"`{b['issuer_ticker']}`" if b["issuer_ticker"] else ""
        company = b["issuer_name"]
        insider = b["insider_name"]
        title = b["insider_title"]
        shares = f"{b['shares']:,.0f} sh @ ${b['price_per_share']:,.2f}"
        value = format_dollars(b["total_value"])
        date = b["transaction_date"]

        rows.append(
            f"{rank}  {ticker} *{company}*\n"
            f"   {insider} _{title}_\n"
            f"   {shares}  →  *{value}*  _{date}_"
        )

    footer = (
        f"{'─' * 48}\n"
        f":information_source: Source: <https://www.sec.gov/cgi-bin/browse-edgar?"
        f"action=getcurrent&type=4&owner=include|SEC EDGAR Form 4>  "
        f"• Purchases only (transaction code P)  "
        f"• Min threshold: {format_dollars(MIN_PURCHASE_VALUE)}"
    )

    return "\n\n".join([header] + rows + [footer])


def format_dollars(amount: float) -> str:
    if amount >= 1_000_000:
        return f"${amount / 1_000_000:.2f}M"
    if amount >= 1_000:
        return f"${amount / 1_000:.0f}K"
    return f"${amount:,.0f}"


# ---------------------------------------------------------------------------
# Post to Slack via HTTP (no SDK dependency)
# ---------------------------------------------------------------------------
def post_to_slack(message: str, channel: str = SLACK_CHANNEL, token: str = SLACK_BOT_TOKEN) -> bool:
    if not token:
        print("[Slack] No SLACK_BOT_TOKEN — printing message only:\n")
        print(message)
        return False

    payload = json.dumps({"channel": channel, "text": message, "mrkdwn": True}).encode()
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            if result.get("ok"):
                print(f"[Slack] Posted to {channel}: ts={result.get('ts')}")
                return True
            else:
                print(f"[Slack] Error: {result.get('error')}", file=sys.stderr)
                return False
    except Exception as e:
        print(f"[Slack] Request failed: {e}", file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    demo_mode = "--demo" in sys.argv or os.getenv("EDGAR_DEMO", "").lower() in ("1", "true", "yes")

    if demo_mode:
        print("[INFO] Demo mode — using sample insider buy data")
        buys = DEMO_BUYS
    else:
        print("[INFO] Fetching live data from SEC EDGAR …")
        buys = get_insider_buys(days_back=1)
        if not buys:
            print("[WARN] No live data retrieved — falling back to demo mode")
            buys = DEMO_BUYS
            demo_mode = True

    if not buys:
        print("[INFO] No qualifying insider purchases found.")
        return

    message = format_slack_message(buys, is_demo=demo_mode)
    post_to_slack(message)


if __name__ == "__main__":
    main()
