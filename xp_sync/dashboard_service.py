import datetime as dt
from typing import Dict, List

import requests

from xp_sync import supabase_client


def _get_rows(table: str, params: dict) -> list:
    return supabase_client._get(table, params)


def _fetch_positions() -> List[dict]:
    fiis = _get_rows("fiis_carteira", {"select": "ticker,quantidade,preco_medio", "quantidade": "gt.0"})
    acoes = _get_rows("acoes_carteira", {"select": "ticker,quantidade,preco_medio", "quantidade": "gt.0"})
    rows: List[dict] = []
    for r in fiis + acoes:
        rows.append({
            "symbol": r.get("ticker"),
            "quantity": float(r.get("quantidade") or 0),
            "avg_price": float(r.get("preco_medio") or 0),
        })
    return [r for r in rows if r["symbol"] and r["quantity"] > 0]


def _fetch_yahoo_prices(symbols: List[str]) -> Dict[str, float]:
    if not symbols:
        return {}
    yahoo_symbols = [f"{s}.SA" for s in symbols]
    url = "https://query1.finance.yahoo.com/v7/finance/quote"
    resp = requests.get(url, params={"symbols": ",".join(yahoo_symbols)}, timeout=20)
    resp.raise_for_status()
    data = resp.json()
    out: Dict[str, float] = {}
    for item in data.get("quoteResponse", {}).get("result", []):
        ysymbol = item.get("symbol", "")
        if not ysymbol.endswith(".SA"):
            continue
        base = ysymbol[:-3]
        price = item.get("regularMarketPrice")
        if price is not None:
            out[base] = float(price)
    return out


def _fetch_monthly_income(positions: List[dict]) -> float:
    if not positions:
        return 0.0
    tickers = [p["symbol"] for p in positions]
    in_list = "(" + ",".join([f'"{t}"' for t in tickers]) + ")"
    today = dt.date.today()
    month_start = today.replace(day=1).isoformat()
    month_end = today.isoformat()

    try:
        rows = _get_rows(
            "dividend_events",
            {
                "select": "ticker,value,event_date,status",
                "ticker": f"in.{in_list}",
                "and": f"(event_date.gte.{month_start},event_date.lte.{month_end})",
            },
        )
    except Exception:
        return 0.0

    qty_by_ticker = {p["symbol"]: p["quantity"] for p in positions}
    total = 0.0
    for row in rows:
        ticker = row.get("ticker")
        value = float(row.get("value") or 0)
        total += value * float(qty_by_ticker.get(ticker, 0))
    return total


def get_dashboard() -> dict:
    positions = _fetch_positions()
    prices = _fetch_yahoo_prices([p["symbol"] for p in positions])

    assets = []
    total_value = 0.0
    total_invested = 0.0

    for p in positions:
        symbol = p["symbol"]
        qty = p["quantity"]
        avg = p["avg_price"]
        invested = qty * avg
        current = float(prices.get(symbol, 0.0))
        value = qty * current
        profit = value - invested
        profit_pct = (profit / invested * 100.0) if invested > 0 else 0.0

        assets.append(
            {
                "symbol": symbol,
                "quantity": qty,
                "avg_price": avg,
                "current_price": current,
                "total_value": value,
                "profit": profit,
                "profit_percent": profit_pct,
            }
        )

        total_invested += invested
        total_value += value

    total_profit = total_value - total_invested
    total_profit_pct = (total_profit / total_invested * 100.0) if total_invested > 0 else 0.0

    return {
        "total_value": total_value,
        "total_invested": total_invested,
        "profit": total_profit,
        "profit_percent": total_profit_pct,
        "monthly_income": _fetch_monthly_income(positions),
        "assets": assets,
    }
