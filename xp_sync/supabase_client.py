"""
Supabase REST API client for fiis_carteira and fiis_mercado tables.

Environment variables:
    SUPABASE_URL  – project URL (default: hardcoded project URL)
    SUPABASE_KEY  – anon/service role key
"""

import logging
import os
from typing import Tuple

import requests

logger = logging.getLogger(__name__)

_SUPABASE_URL = os.environ.get(
    "SUPABASE_URL", "https://ityrkysliksvvhpvweft.supabase.co"
)
_SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")


def _headers(prefer: str = "") -> dict:
    h = {
        "apikey": _SUPABASE_KEY,
        "Authorization": f"Bearer {_SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        h["Prefer"] = prefer
    return h


def _get(path: str, params: dict) -> list:
    url = f"{_SUPABASE_URL}/rest/v1/{path}"
    r = requests.get(url, headers=_headers("return=representation"), params=params, timeout=15)
    r.raise_for_status()
    return r.json()


def _post(path: str, payload: dict | list, prefer: str) -> None:
    url = f"{_SUPABASE_URL}/rest/v1/{path}"
    r = requests.post(url, headers=_headers(prefer), json=payload, timeout=15)
    r.raise_for_status()


def _delete(path: str, params: dict) -> None:
    url = f"{_SUPABASE_URL}/rest/v1/{path}"
    r = requests.delete(url, headers=_headers(), params=params, timeout=15)
    r.raise_for_status()


# ── fiis_carteira ─────────────────────────────────────────────────────────────

def get_posicao(ticker: str) -> Tuple[int, float]:
    """Return (quantidade, preco_medio) for ticker, or (0, 0.0) if not found."""
    rows = _get(
        "fiis_carteira",
        {"ticker": f"eq.{ticker}", "select": "quantidade,preco_medio"},
    )
    if not rows:
        logger.debug(f"{ticker}: sem posição atual")
        return 0, 0.0
    row = rows[0]
    qty = int(row.get("quantidade") or 0)
    pm = float(row.get("preco_medio") or 0.0)
    logger.debug(f"{ticker}: posição atual = {qty} cotas @ R${pm:.2f}")
    return qty, pm


def upsert_posicao(ticker: str, quantidade: int, preco_medio: float) -> None:
    """
    Update fiis_carteira for ticker.
    Deletes the row if quantidade <= 0 (position fully sold).
    """
    if quantidade <= 0:
        logger.info(f"{ticker}: posição zerada, removendo da carteira")
        _delete("fiis_carteira", {"ticker": f"eq.{ticker}"})
        return

    payload = {
        "ticker": ticker,
        "quantidade": quantidade,
        "preco_medio": round(preco_medio, 2),
    }
    _post("fiis_carteira", payload, "resolution=merge-duplicates,return=minimal")
    logger.info(f"{ticker}: carteira atualizada → {quantidade} cotas @ R${preco_medio:.2f}")


# ── fiis_mercado ──────────────────────────────────────────────────────────────

def ensure_ticker_in_mercado(ticker: str) -> None:
    """Insert a minimal fiis_mercado row for ticker if it doesn't already exist."""
    rows = _get("fiis_mercado", {"ticker": f"eq.{ticker}", "select": "ticker"})
    if rows:
        logger.debug(f"{ticker}: já existe em fiis_mercado")
        return

    _post("fiis_mercado", {"ticker": ticker}, "return=minimal")
    logger.info(f"{ticker}: inserido em fiis_mercado (dados mínimos)")


# ── fiis_negociacoes ──────────────────────────────────────────────────────────

def insert_negociacao(
    ticker: str, tipo: str, quantidade: int, preco: float, data: str | None = None
) -> None:
    """Record an individual trade in fiis_negociacoes."""
    payload: dict = {
        "ticker": ticker,
        "tipo": tipo,
        "quantidade": quantidade,
        "preco": round(preco, 2),
    }
    if data:
        payload["data_negociacao"] = data
    _post("fiis_negociacoes", payload, "return=minimal")
    logger.debug(f"{ticker}: negociação registrada — {tipo} {quantidade}x @ R${preco:.2f} em {data or 'agora'}")


# ── Business logic ────────────────────────────────────────────────────────────

def process_compra(ticker: str, quantidade: int, preco: float, data: str | None = None) -> None:
    """
    Record a purchase: recalculate weighted average price and add quantity.
    novo_pm = (qtd_atual * pm_atual + qtd_compra * preco_compra) / (qtd_atual + qtd_compra)
    """
    qtd_atual, pm_atual = get_posicao(ticker)

    novo_pm = (
        (qtd_atual * pm_atual + quantidade * preco) / (qtd_atual + quantidade)
        if qtd_atual > 0
        else preco
    )
    nova_qtd = qtd_atual + quantidade

    logger.info(
        f"COMPRA {ticker}: {qtd_atual}+{quantidade} cotas | "
        f"PM: R${pm_atual:.2f} → R${novo_pm:.2f}"
    )

    ensure_ticker_in_mercado(ticker)
    upsert_posicao(ticker, nova_qtd, novo_pm)
    insert_negociacao(ticker, "C", quantidade, preco, data)


def process_venda(ticker: str, quantidade: int, preco: float, data: str | None = None) -> None:
    """
    Record a sale: subtract quantity, preserve average price.
    """
    qtd_atual, pm_atual = get_posicao(ticker)

    if qtd_atual == 0:
        logger.warning(
            f"VENDA {ticker}: posição não encontrada na carteira — ignorando"
        )
        return

    nova_qtd = qtd_atual - quantidade
    logger.info(
        f"VENDA {ticker}: {qtd_atual}−{quantidade} = {nova_qtd} cotas "
        f"@ R${preco:.2f} (PM mantido: R${pm_atual:.2f})"
    )
    upsert_posicao(ticker, nova_qtd, pm_atual)
    insert_negociacao(ticker, "V", quantidade, preco, data)
