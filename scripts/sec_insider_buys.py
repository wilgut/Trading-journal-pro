#!/usr/bin/env python3
"""
SEC EDGAR Form 4 insider-purchase scanner.

Fetches Form 4 filings for the last N hours, parses each XML for
open-market purchases (transactionCode=P) by officers and directors,
filters to ≥$100k, ranks by total value, and optionally posts to Slack.

Usage:
    python3 scripts/sec_insider_buys.py [--hours 24] [--slack-channel C0AUARBCPND]

Prerequisites:
    pip install requests  (stdlib urllib also works, requests preferred)

IMPORTANT:
    SEC EDGAR blocks cloud/datacenter IP ranges (AWS, GCP, Azure) with HTTP 403.
    Run from a residential or corporate network / non-cloud server.
    Set SLACK_BOT_TOKEN env var to enable Slack posting.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

try:
    import requests

    def fetch(url: str, **kw) -> bytes:
        headers = {
            "User-Agent": "TradingJournalPro admin@tradingjournalpro.com",
            "Accept": "application/json",
        }
        r = requests.get(url, headers=headers, timeout=15, **kw)
        r.raise_for_status()
        return r.content

except ImportError:
    import urllib.request

    def fetch(url: str, **_) -> bytes:  # type: ignore[misc]
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "TradingJournalPro admin@tradingjournalpro.com",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read()


EDGAR_EFTS = "https://efts.sec.gov/LATEST/search-index"
EDGAR_ARCHIVES = "https://www.sec.gov/Archives/edgar/data"
MIN_VALUE = 100_000
BATCH_SIZE = 5


# ── EDGAR search ──────────────────────────────────────────────────────────────

def search_form4(start_dt: str, end_dt: str) -> list[dict]:
    results: list[dict] = []
    offset = 0
    page = 100

    while True:
        url = (
            f"{EDGAR_EFTS}?forms=4"
            f"&dateRange=custom&startdt={start_dt}&enddt={end_dt}"
            f"&from={offset}&size={page}"
        )
        data = json.loads(fetch(url))
        hits: list[dict] = data.get("hits", {}).get("hits", [])
        if not hits:
            break
        results.extend(hits)
        total_raw = data.get("hits", {}).get("total", 0)
        total = total_raw.get("value", 0) if isinstance(total_raw, dict) else total_raw
        if offset + page >= int(total):
            break
        offset += page
        time.sleep(0.15)

    return results


# ── XML filing fetch ──────────────────────────────────────────────────────────

def fetch_form4_xml(accession: str, cik: str) -> str | None:
    clean = accession.replace("-", "")
    cik_clean = cik.lstrip("0") or "0"

    candidates = [
        f"{EDGAR_ARCHIVES}/{cik_clean}/{clean}/{accession}.xml",
        f"{EDGAR_ARCHIVES}/{cik_clean}/{clean}/form4.xml",
        f"{EDGAR_ARCHIVES}/{cik_clean}/{clean}/wf-form4.xml",
    ]
    for url in candidates:
        try:
            return fetch(url).decode("utf-8", errors="replace")
        except Exception:
            continue

    # Fallback: index
    try:
        idx_url = f"{EDGAR_ARCHIVES}/{cik_clean}/{clean}/{accession}-index.json"
        idx = json.loads(fetch(idx_url))
        for item in idx.get("directory", {}).get("item", []):
            name = item.get("name", "")
            if name.endswith(".xml") and "label" not in name and "pre" not in name:
                xml_url = f"{EDGAR_ARCHIVES}/{cik_clean}/{clean}/{name}"
                try:
                    return fetch(xml_url).decode("utf-8", errors="replace")
                except Exception:
                    continue
    except Exception:
        pass

    return None


# ── Form 4 XML parser ─────────────────────────────────────────────────────────

def _tag(xml: str, tag: str) -> str:
    m = re.search(rf"<{tag}[^>]*>([^<]*)</{tag}>", xml, re.IGNORECASE)
    return m.group(1).strip() if m else ""


def parse_purchases(xml: str, filing: dict) -> list[dict]:
    purchases: list[dict] = []

    insider = _tag(xml, "rptOwnerName")
    is_dir = _tag(xml, "isDirector") == "1"
    is_off = _tag(xml, "isOfficer") == "1"
    title = _tag(xml, "officerTitle")

    if not (is_dir or is_off):
        return purchases

    for block in re.findall(
        r"<nonDerivativeTransaction>([\s\S]*?)</nonDerivativeTransaction>",
        xml,
        re.IGNORECASE,
    ):
        if _tag(block, "transactionCode") != "P":
            continue
        try:
            shares = float(_tag(block, "transactionShares") or "0")
            price = float(_tag(block, "transactionPricePerShare") or "0")
            total = shares * price
        except ValueError:
            continue
        if total < MIN_VALUE:
            continue

        purchases.append({
            "company": filing["entity_name"],
            "cik": filing["cik"],
            "accession": filing["accession"],
            "file_date": filing["file_date"],
            "insider_name": insider,
            "title": title or ("Director" if is_dir else "Officer"),
            "is_director": is_dir,
            "is_officer": is_off,
            "security": _tag(block, "securityTitle") or "Common Stock",
            "txn_date": _tag(block, "transactionDate") or filing["file_date"],
            "shares": shares,
            "price": price,
            "total_value": total,
            "edgar_url": (
                f"https://www.sec.gov/cgi-bin/browse-edgar"
                f"?action=getcompany&CIK={filing['cik']}&type=4"
            ),
        })

    return purchases


# ── Scan ──────────────────────────────────────────────────────────────────────

def scan(hours: int = 24) -> dict:
    now = datetime.datetime.utcnow()
    start = now - datetime.timedelta(hours=hours)
    start_dt = start.strftime("%Y-%m-%d")
    end_dt = now.strftime("%Y-%m-%d")

    print(f"[edgar] Searching Form 4 filings {start_dt} → {end_dt} …", file=sys.stderr)
    raw_filings = search_form4(start_dt, end_dt)
    print(f"[edgar] {len(raw_filings)} filings found. Parsing …", file=sys.stderr)

    filings = [
        {
            "accession": h["_id"],
            "cik": h["_id"].split("-")[0].lstrip("0") or "0",
            "entity_name": h.get("_source", {}).get("entity_name", ""),
            "file_date": h.get("_source", {}).get("file_date", ""),
        }
        for h in raw_filings
    ]

    all_purchases: list[dict] = []

    def process(filing: dict) -> list[dict]:
        xml = fetch_form4_xml(filing["accession"], filing["cik"])
        if not xml:
            return []
        return parse_purchases(xml, filing)

    with ThreadPoolExecutor(max_workers=BATCH_SIZE) as pool:
        futures = {pool.submit(process, f): f for f in filings}
        done = 0
        for fut in as_completed(futures):
            done += 1
            try:
                all_purchases.extend(fut.result())
            except Exception:
                pass
            if done % 100 == 0:
                print(f"[edgar]   {done}/{len(filings)} parsed …", file=sys.stderr)

    all_purchases.sort(key=lambda x: x["total_value"], reverse=True)
    print(
        f"[edgar] Done. {len(all_purchases)} qualifying purchase(s) found.",
        file=sys.stderr,
    )

    return {
        "purchases": all_purchases,
        "filings_scanned": len(filings),
        "start_dt": start_dt,
        "end_dt": end_dt,
        "generated_at": now.isoformat() + "Z",
    }


# ── Slack message formatter ───────────────────────────────────────────────────

def _usd(n: float) -> str:
    if n >= 1_000_000:
        return f"${n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"${n / 1_000:.0f}K"
    return f"${n:.0f}"


def build_slack_message(result: dict) -> str:
    p = result["purchases"]
    scanned = result["filings_scanned"]
    start_dt = result["start_dt"]
    end_dt = result["end_dt"]

    header = (
        f":sleuth_or_spy: _SEC Insider Purchase Alert_\n"
        f"> Open-market buys by executives & directors  |  Threshold: _>$100K_\n"
        f"> Period: _{start_dt}_ → _{end_dt}_  |  Form 4 filings scanned: _{scanned}_"
    )

    if not p:
        return f"{header}\n_No qualifying purchases found._"

    medals = {1: ":first_place_medal:", 2: ":second_place_medal:", 3: ":third_place_medal:"}
    rows: list[str] = []
    for i, t in enumerate(p[:20], 1):
        rank = medals.get(i, f"_{i}._")
        role = (
            "[Officer & Director]" if t["is_officer"] and t["is_director"]
            else "[Officer]" if t["is_officer"] else "[Director]"
        )
        rows.append(
            f"{rank}  _{_usd(t['total_value'])}_  |  _{t['company']}_\n"
            f"{t['insider_name']} — _{t['title']}_  {role}\n"
            f"{t['shares']:,.0f} shares @ ${t['price']:.2f}  "
            f"|  <{t['edgar_url']}|SEC Filing>"
        )

    top3 = "\n".join(
        f"• _{t['company']}_ {_usd(t['total_value'])} by {t['insider_name']}"
        for t in p[:3]
    )

    generated = result["generated_at"][:16].replace("T", " ")
    return (
        f"{header}\n"
        f"_{len(p)} significant purchases found — ranked by value:_\n"
        + "\n".join(rows)
        + f"\n{'─' * 37}\n"
        f"_Top 3 by value:_\n{top3}\n"
        f"_Generated {generated}Z  |  Data: SEC EDGAR Form 4_"
    )


# ── Slack API sender ──────────────────────────────────────────────────────────

def post_to_slack(channel: str, message: str) -> None:
    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        print("[slack] SLACK_BOT_TOKEN not set — skipping post.", file=sys.stderr)
        return

    try:
        import requests as req_lib
        r = req_lib.post(
            "https://slack.com/api/chat.postMessage",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"channel": channel, "text": message},
            timeout=15,
        )
        data = r.json()
        if data.get("ok"):
            print(f"[slack] Posted to {channel}.", file=sys.stderr)
        else:
            print(f"[slack] Error: {data.get('error')}", file=sys.stderr)
    except Exception as e:
        print(f"[slack] Exception: {e}", file=sys.stderr)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hours", type=int, default=24, help="Lookback window in hours (default: 24)")
    parser.add_argument("--slack-channel", default="C0AUARBCPND", help="Slack channel ID to post to")
    parser.add_argument("--json-out", help="Write result JSON to this file path")
    args = parser.parse_args()

    result = scan(hours=args.hours)
    msg = build_slack_message(result)

    print("\n" + "=" * 70)
    print(msg)
    print("=" * 70 + "\n")

    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump(result, f, indent=2)
        print(f"[output] JSON written to {args.json_out}", file=sys.stderr)

    post_to_slack(args.slack_channel, msg)


if __name__ == "__main__":
    main()
