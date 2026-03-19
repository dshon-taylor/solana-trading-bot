#!/usr/bin/env python3
import time, math, sys
import requests
from datetime import datetime, timezone, timedelta

GECKO = 'https://api.geckoterminal.com/api/v2'
RUG = 'https://api.rugcheck.xyz/v1/tokens/{mint}/report'

# Current bot filters (mirror what Candle Carl uses; adjust if you changed them)
MIN_MCAP_USD = 250_000          # you just lowered to 250k
LIQ_FLOOR_USD = 40_000          # floor
LIQ_RATIO = 0.15                # ratio * mcap
MIN_AGE_HOURS = 12
RUG_MIN_SCORE = 60              # current code: score_normalised >= 60
REJECT_IF_MINT_AUTH = True
REJECT_IF_FREEZE_AUTH = True

MAX_POOLS = 600                 # cap for runtime (keep low to avoid rate limits)
SLEEP = 1.0

session = requests.Session()
session.headers['user-agent'] = 'CandleCarlFilterAudit/0.1'

def iso_to_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace('Z','+00:00'))
    except Exception:
        return None

def fetch_new_pools(page=1, retries=6):
    url = f"{GECKO}/networks/solana/new_pools"
    for a in range(retries + 1):
        r = session.get(url, params={'page': page}, timeout=20)
        if r.status_code == 429:
            time.sleep(1.5 + a * 1.5)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError(f'GeckoTerminal rate-limited on page {page}')

def rug_report(mint):
    r = session.get(RUG.format(mint=mint), timeout=20)
    if r.status_code != 200:
        return None
    return r.json()

def passes_rug(rep):
    if rep is None:
        return False, 'rugcheckFetch'
    if rep.get('rugged') is True:
        return False, 'rugged'
    if REJECT_IF_MINT_AUTH and rep.get('mintAuthority'):
        return False, 'mintAuthority'
    if REJECT_IF_FREEZE_AUTH and rep.get('freezeAuthority'):
        return False, 'freezeAuthority'
    score = rep.get('score_normalised')
    if not isinstance(score, (int, float)):
        return False, 'noScore'
    if score < RUG_MIN_SCORE:
        return False, f'score<{RUG_MIN_SCORE}'
    return True, 'ok'

def main():
    cutoff = datetime.now(timezone.utc) - timedelta(days=90)

    counts = {
        'pools_seen': 0,
        'too_new': 0,
        'no_mint': 0,
        'no_liq': 0,
        'age_fail': 0,
        'liq_floor_fail': 0,
        'mcap_fail': 0,
        'liq_ratio_fail': 0,
        'rug_fail': 0,
        'pass_all': 0,
    }

    sample_pass = []
    sample_fail = []

    page = 1
    while True:
        # GeckoTerminal may start returning 401 after several pages from a single client.
        # Treat this as an endpoint block and stop with partial results.
        try:
            data = fetch_new_pools(page)
        except Exception as e:
            print(f"Stopped early on page {page}: {e}")
            print_summary(counts, sample_pass, sample_fail)
            return
        time.sleep(2.0)
        pools = data.get('data') or []
        if not pools:
            break

        for p in pools:
            if counts['pools_seen'] >= MAX_POOLS:
                break

            attr = (p.get('attributes') or {})
            created = iso_to_dt(attr.get('pool_created_at') or attr.get('created_at'))
            if created is None:
                # If no timestamp, still count but skip age logic
                counts['too_new'] += 1
                continue
            if created < cutoff:
                # new_pools is sorted newest-first; once we go past cutoff, we can stop.
                print(f"Reached cutoff on page {page}")
                print_summary(counts, sample_pass, sample_fail)
                return

            counts['pools_seen'] += 1

            base = (attr.get('base_token') or {})
            mint = base.get('address')
            if not mint:
                counts['no_mint'] += 1
                continue

            age_h = (datetime.now(timezone.utc) - created).total_seconds() / 3600
            if age_h < MIN_AGE_HOURS:
                counts['age_fail'] += 1
                if len(sample_fail) < 10:
                    sample_fail.append((base.get('symbol'), mint, f"age<{MIN_AGE_HOURS}h", attr.get('reserve_in_usd'), attr.get('fdv_usd')))
                continue

            liq = attr.get('reserve_in_usd')
            try:
                liq = float(liq)
            except Exception:
                counts['no_liq'] += 1
                continue

            if liq < LIQ_FLOOR_USD:
                counts['liq_floor_fail'] += 1
                continue

            # Use fdv_usd as market cap proxy when available.
            mcap = attr.get('fdv_usd')
            try:
                mcap = float(mcap)
            except Exception:
                # if missing, treat as fail for our bot
                counts['mcap_fail'] += 1
                continue

            if mcap < MIN_MCAP_USD:
                counts['mcap_fail'] += 1
                continue

            req_liq = max(LIQ_FLOOR_USD, LIQ_RATIO * mcap)
            if liq < req_liq:
                counts['liq_ratio_fail'] += 1
                continue

            rep = rug_report(mint)
            ok, reason = passes_rug(rep)
            if not ok:
                counts['rug_fail'] += 1
                if len(sample_fail) < 10:
                    sample_fail.append((base.get('symbol'), mint, f"rug:{reason}", liq, mcap))
                time.sleep(SLEEP)
                continue

            counts['pass_all'] += 1
            if len(sample_pass) < 10:
                sample_pass.append((base.get('symbol'), mint, 'PASS', liq, mcap))

            time.sleep(SLEEP)

        if counts['pools_seen'] >= MAX_POOLS:
            break
        page += 1
        time.sleep(SLEEP)

    print_summary(counts, sample_pass, sample_fail)


def print_summary(counts, sample_pass, sample_fail):
    seen = counts['pools_seen']
    def pct(x):
        return 0 if seen == 0 else (100.0 * x / seen)

    print('--- Candle Carl filter feasibility (last ~90d new pools via GeckoTerminal) ---')
    print(f"Evaluated pools: {seen} (cap {MAX_POOLS})")
    for k in ['age_fail','liq_floor_fail','mcap_fail','liq_ratio_fail','rug_fail','pass_all']:
        print(f"{k}: {counts[k]} ({pct(counts[k]):.1f}%)")

    if sample_pass:
        print('\nSample PASS (symbol, mint, liq, mcap):')
        for s,m,_,liq,mcap in sample_pass:
            print(f"- {s} {m} liq=${liq:,.0f} mcap~${mcap:,.0f}")

    if sample_fail:
        print('\nSample FAIL:')
        for s,m,reason,liq,mcap in sample_fail:
            liq_s = '?' if liq is None else f"${float(liq):,.0f}"
            mcap_s = '?' if mcap is None else f"${float(mcap):,.0f}"
            print(f"- {s} {m} {reason} liq={liq_s} mcap={mcap_s}")

if __name__ == '__main__':
    main()
