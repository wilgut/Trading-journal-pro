#!/usr/bin/env python3
"""
SEC EDGAR Form 4 insider purchase scanner.

Scans Form 4 filings from the last 24 hours, filters for open-market purchases
by executives and directors exceeding $100 000, ranks by transaction value,
and posts a summary to a Slack channel.

Usage
-----
    # Print summary to stdout only
    python3 sec_insider_scanner.py

    # Also post to Slack (Incoming Webhook)
    SLACK_WEBHOOK_URL=https://hooks.slack.com/... python3 sec_insider_scanner.py

    # Custom look-back window and threshold
    python3 sec_insider_scanner.py --hours 48 --min-value 500000

Environment variables
---------------------
SLACK_WEBHOOK_URL   Slack Incoming Webhook URL (optional)
SLACK_CHANNEL       Override the default channel embedded in the webhook (optional)

SEC EDGAR API notes
-------------------
- Requires a descriptive User-Agent per https://www.sec.gov/privacy.htm#edgaraccess
- Rate limit: ~10 req/s; we stay well below that
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# ── Constants ────────────────────────────────────────────────────────────────

EDGAR_EFTS = "https://efts.sec.gov/LATEST/search-index"
EDGAR_ARCH = "https://www.sec.gov/Archives/edgar/data"
# SEC requires a descriptive User-Agent that includes contact info
USER_AGENT = "TradingJournalPro/1.0 (github.com/wilgut/trading-journal-pro; wilfred.gutierrez@gmail.com)"
HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json, text/xml, */*"}
DEFAULT_MIN_VALUE = 100_000   # $100 k
DEFAULT_HOURS = 24
MAX_FILINGS = 500             # Hard cap to avoid runaway loops
INTER_REQUEST_DELAY = 0.12    # seconds between EDGAR requests (~8 req/s)
TOP_N_SLACK = 25              # Maximum rows in the Slack table


# ── HTTP helpers ─────────────────────────────────────────────────────────────

def http_get(url: str, timeout: int = 20, retries: int = 3) -> bytes:
    for attempt in range(retries):
        try:
            req = Request(url, headers=HEADERS)
            with urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except HTTPError as exc:
            if exc.code == 429:
                wait = 2 ** (attempt + 2)
                print(f"  Rate-limited; sleeping {wait}s …", file=sys.stderr)
                time.sleep(wait)
            elif attempt == retries - 1:
                raise
            else:
                time.sleep(2 ** attempt)
        except URLError:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Failed to fetch {url}")  # unreachable


# ── EDGAR search ─────────────────────────────────────────────────────────────

def search_form4_filings(start: str, end: str) -> list[tuple[str, str]]:
    """
    Return list of (accession_number, cik) for Form 4 filings in [start, end].
    Both dates are ISO-8601 strings (YYYY-MM-DD).
    """
    results: list[tuple[str, str]] = []
    page_size = 100
    offset = 0

    while len(results) < MAX_FILINGS:
        url = (
            f"{EDGAR_EFTS}?forms=4"
            f"&dateRange=custom&startdt={start}&enddt={end}"
            f"&hits.hits.total=true&from={offset}"
        )
        raw = http_get(url)
        data = json.loads(raw)

        hits_block = data.get("hits", {})
        hits = hits_block.get("hits", [])
        if not hits:
            break

        for h in hits:
            acc_no = h.get("_id", "")
            src = h.get("_source", {})
            entity_ids = src.get("entity_id", [])
            if not entity_ids or not acc_no:
                continue
            cik = entity_ids[0] if isinstance(entity_ids, list) else entity_ids
            results.append((acc_no, str(cik)))

        total = hits_block.get("total", {}).get("value", 0)
        offset += page_size
        if offset >= total:
            break

    return results[:MAX_FILINGS]


# ── Filing XML retrieval ──────────────────────────────────────────────────────

def _filing_base_url(acc_no: str, cik: str) -> str:
    acc_clean = acc_no.replace("-", "")
    cik_int = str(int(cik))          # strip leading zeros
    return f"{EDGAR_ARCH}/{cik_int}/{acc_clean}"


def get_primary_xml(acc_no: str, cik: str) -> ET.Element | None:
    """
    Locate and return the root element of the primary Form 4 XML document.
    Tries the filing-index JSON first, then falls back to common name patterns.
    """
    base = _filing_base_url(acc_no, cik)

    # Strategy 1: use the filing index JSON to find the XML document
    try:
        idx = json.loads(http_get(f"{base}/{acc_no}-index.json"))
        for item in idx.get("directory", {}).get("item", []):
            name: str = item.get("name", "")
            # Primary Form 4 XML: ends with .xml, not an R-document, not a schema
            if (
                name.endswith(".xml")
                and not name.startswith("R")
                and "xsd" not in name.lower()
                and "xsl" not in name.lower()
                and "label" not in name.lower()
            ):
                raw = http_get(f"{base}/{name}")
                return ET.fromstring(raw)
    except Exception:
        pass

    # Strategy 2: common naming patterns
    acc_clean = acc_no.replace("-", "")
    for candidate in [f"{acc_clean}.xml", "form4.xml", "doc4.xml", "primaryDoc.xml"]:
        try:
            raw = http_get(f"{base}/{candidate}")
            return ET.fromstring(raw)
        except Exception:
            continue

    return None


# ── Transaction parsing ───────────────────────────────────────────────────────

def parse_purchases(root: ET.Element, min_value: float) -> list[dict]:
    """
    Extract open-market purchases by executives/directors from a Form 4 XML tree.
    Returns a list of purchase dicts sorted by value (highest first).
    """
    issuer_name = (root.findtext("issuer/issuerName") or "").strip()
    ticker = (root.findtext("issuer/issuerTradingSymbol") or "").strip().upper()

    owner_name = (
        root.findtext(".//reportingOwner/reportingOwnerId/rptOwnerName") or ""
    ).strip()

    rel = root.find(".//reportingOwner/reportingOwnerRelationship")
    title = ""
    is_exec_or_dir = False
    if rel is not None:
        title = (rel.findtext("officerTitle") or "").strip()
        is_dir = rel.findtext("isDirector") == "1"
        is_off = rel.findtext("isOfficer") == "1"
        is_exec_or_dir = is_dir or is_off
        if not title:
            if is_dir:
                title = "Director"
            elif is_off:
                title = "Officer"

    if not is_exec_or_dir:
        return []

    purchases: list[dict] = []
    for tx in root.findall(".//nonDerivativeTransaction"):
        # Transaction code "P" = open-market purchase
        code = tx.findtext(".//transactionCoding/transactionCode") or ""
        acq = (
            tx.findtext(".//transactionAmounts/transactionAcquiredDisposedCode/value")
            or ""
        )
        if code != "P" or acq != "A":
            continue

        try:
            shares = float(
                tx.findtext(".//transactionAmounts/transactionShares/value") or 0
            )
            price = float(
                tx.findtext(".//transactionAmounts/transactionPricePerShare/value") or 0
            )
        except (ValueError, TypeError):
            continue

        total_value = shares * price
        if total_value < min_value:
            continue

        tx_date = tx.findtext(".//transactionDate/value") or ""
        purchases.append(
            {
                "issuer": issuer_name,
                "ticker": ticker,
                "owner": owner_name,
                "title": title,
                "date": tx_date,
                "shares": int(shares),
                "price": round(price, 4),
                "value": round(total_value, 2),
            }
        )

    return purchases


# ── Slack formatting ──────────────────────────────────────────────────────────

def _fmt_value(v: float) -> str:
    if v >= 1_000_000:
        return f"${v / 1_000_000:.2f}M"
    return f"${v / 1_000:.0f}K"


def build_slack_message(
    purchases: list[dict], start: str, end: str, min_value: float
) -> str:
    threshold = _fmt_value(min_value)
    lines = [
        f"*:bar_chart: SEC Form 4 — Insider Purchases >{threshold}*",
        f"_Executives & Directors only | {start} → {end} UTC_",
        "",
    ]

    if not purchases:
        lines.append(
            f":white_check_mark: Scan complete — no qualifying purchases "
            f"(>{threshold}) found in this window."
        )
        return "\n".join(lines)

    lines.append(f"*{len(purchases)} purchase{'s' if len(purchases) != 1 else ''} found, ranked by value:*\n")

    shown = purchases[:TOP_N_SLACK]
    for rank, p in enumerate(shown, 1):
        label = p["ticker"] if p["ticker"] else p["issuer"]
        val_str = _fmt_value(p["value"])
        price_str = f"${p['price']:,.2f}"
        lines.append(
            f"*{rank}.* `{label}` — {p['owner']} _{p['title']}_\n"
            f"    {p['shares']:,} sh @ {price_str} = *{val_str}*   📅 {p['date']}"
        )

    if len(purchases) > TOP_N_SLACK:
        lines.append(f"\n_…and {len(purchases) - TOP_N_SLACK} more not shown_")

    lines.append(
        f"\n_Source: SEC EDGAR Form 4 filings · "
        f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4_"
    )
    return "\n".join(lines)


# ── Slack delivery ────────────────────────────────────────────────────────────

def post_to_slack(message: str, webhook_url: str) -> None:
    payload = json.dumps({"text": message}).encode()
    req = Request(
        webhook_url,
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    with urlopen(req, timeout=15) as resp:
        status = resp.status
        body = resp.read().decode()
    if status != 200 or body.strip() != "ok":
        raise RuntimeError(f"Slack responded {status}: {body!r}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours", type=int, default=DEFAULT_HOURS,
                        help="Look-back window in hours (default: 24)")
    parser.add_argument("--min-value", type=float, default=DEFAULT_MIN_VALUE,
                        help="Minimum purchase value in USD (default: 100000)")
    parser.add_argument("--slack-webhook", default=os.getenv("SLACK_WEBHOOK_URL"),
                        help="Slack Incoming Webhook URL (or set SLACK_WEBHOOK_URL)")
    args = parser.parse_args(argv)

    now = datetime.now(timezone.utc)
    end_dt = now.strftime("%Y-%m-%d")
    start_dt = (now - timedelta(hours=args.hours)).strftime("%Y-%m-%d")

    print(
        f"[{now.strftime('%Y-%m-%dT%H:%M:%SZ')}] "
        f"Scanning Form 4 filings {start_dt} → {end_dt} "
        f"(min ${args.min_value:,.0f})",
        file=sys.stderr,
    )

    # ── 1. Search EDGAR ───────────────────────────────────────────────────────
    filings = search_form4_filings(start_dt, end_dt)
    print(f"Found {len(filings)} Form 4 filing(s) to examine", file=sys.stderr)

    # ── 2. Parse each filing ──────────────────────────────────────────────────
    all_purchases: list[dict] = []
    errors = 0

    for idx, (acc_no, cik) in enumerate(filings):
        try:
            root = get_primary_xml(acc_no, cik)
            if root is not None:
                new = parse_purchases(root, args.min_value)
                all_purchases.extend(new)
        except Exception as exc:
            errors += 1
            if errors <= 10:
                print(f"  Error {acc_no}: {exc}", file=sys.stderr)

        if idx % 50 == 0 and idx > 0:
            print(
                f"  {idx}/{len(filings)} processed — "
                f"{len(all_purchases)} qualifying purchases so far",
                file=sys.stderr,
            )

        time.sleep(INTER_REQUEST_DELAY)

    # ── 3. Rank ───────────────────────────────────────────────────────────────
    all_purchases.sort(key=lambda x: x["value"], reverse=True)
    print(
        f"Scan complete: {len(all_purchases)} qualifying purchase(s) "
        f"from {len(filings)} filing(s) ({errors} error(s))",
        file=sys.stderr,
    )

    # ── 4. Format ─────────────────────────────────────────────────────────────
    message = build_slack_message(all_purchases, start_dt, end_dt, args.min_value)
    print(message)

    # ── 5. Send to Slack ──────────────────────────────────────────────────────
    if args.slack_webhook:
        try:
            post_to_slack(message, args.slack_webhook)
            print("Posted to Slack.", file=sys.stderr)
        except Exception as exc:
            print(f"Slack delivery failed: {exc}", file=sys.stderr)
            return 1
    else:
        print(
            "(Set SLACK_WEBHOOK_URL or --slack-webhook to post to Slack)",
            file=sys.stderr,
        )

    # Also emit JSON for programmatic consumers
    json_path = "insider_purchases.json"
    with open(json_path, "w") as fh:
        json.dump(
            {"generated_at": now.isoformat(), "purchases": all_purchases},
            fh,
            indent=2,
        )
    print(f"JSON results written to {json_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
