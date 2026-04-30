"""
PDF parser for XP Investimentos notas de negociação.

Decrypts password-protected PDFs with pikepdf, then extracts and
parses trading operations with pdfplumber + regex.

Expected PDF text structure (may be fragmented across lines):
    "1-BOVESPA"
    "C VISTA" or "V VISTA"
    "[FII FUND NAME]"
    "TICK11"
    "CI ER"
    "100"       <- quantity (integer)
    "95,05"     <- unit price (Brazilian decimal)
"""

import io
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional

import pikepdf
import pdfplumber

logger = logging.getLogger(__name__)


@dataclass
class Negociacao:
    tipo: str              # 'C' (compra) or 'V' (venda)
    ticker: str            # e.g. 'RZAT11'
    quantidade: int
    preco: float
    data: Optional[str] = field(default=None)  # ISO datetime string from nota


def decrypt_pdf(pdf_bytes: bytes, password: str) -> bytes:
    """Decrypt a password-protected PDF using pikepdf."""
    try:
        with pikepdf.open(io.BytesIO(pdf_bytes), password=password) as pdf:
            output = io.BytesIO()
            pdf.save(output)
            output.seek(0)
            return output.read()
    except pikepdf.PasswordError as e:
        logger.error(f"Senha incorreta para o PDF: {e}")
        raise
    except Exception as e:
        logger.error(f"Falha ao descriptografar PDF: {e}")
        raise


def extract_text(pdf_bytes: bytes) -> str:
    """Extract all text from PDF pages using pdfplumber."""
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            pages_text = []
            for i, page in enumerate(pdf.pages):
                text = page.extract_text() or ""
                logger.debug(f"Página {i + 1}: {len(text)} caracteres extraídos")
                pages_text.append(text)
            return "\n".join(pages_text)
    except Exception as e:
        logger.error(f"Falha ao extrair texto do PDF: {e}")
        raise


def _parse_price(price_str: str) -> float:
    """Convert Brazilian price string to float. '1.234,56' -> 1234.56"""
    return float(price_str.replace(".", "").replace(",", "."))


def extract_trade_date(text: str) -> Optional[str]:
    """
    Extract the trade date ("data pregão") from the nota text.
    Returns an ISO 8601 UTC datetime string, or None if not found.

    Handles patterns like:
        "Data pregão 29/04/2026"
        "Data do Pregão: 29/04/2026"
        "Data Pregão 29/04/2026"
    """
    pattern = re.compile(
        r"[Dd]ata\s+(?:d[eo]\s+)?[Pp]reg[ãa]o\s*:?\s*(\d{2}/\d{2}/\d{4})",
        re.IGNORECASE,
    )
    m = pattern.search(text)
    if m:
        date_str = m.group(1)
        try:
            dt = datetime.strptime(date_str, "%d/%m/%Y").replace(tzinfo=timezone.utc)
            return dt.isoformat()
        except ValueError:
            logger.warning(f"Data encontrada mas inválida: {date_str}")

    # Fallback: first DD/MM/YYYY in document header (first 500 chars)
    fallback = re.search(r"\b(\d{2}/\d{2}/\d{4})\b", text[:500])
    if fallback:
        try:
            dt = datetime.strptime(fallback.group(1), "%d/%m/%Y").replace(tzinfo=timezone.utc)
            logger.info(f"Data extraída via fallback: {fallback.group(1)}")
            return dt.isoformat()
        except ValueError:
            pass

    logger.warning("Data do pregão não encontrada no PDF")
    return None


def parse_negociacoes(text: str) -> List[Negociacao]:
    """
    Parse trading operations from XP nota de negociação text.

    Tries two strategies:
    1. Normalize to single line and apply a comprehensive regex.
    2. Line-by-line state machine that follows the fragmented structure.

    Deduplicates by (tipo, ticker, quantidade, preco) to avoid counting
    operations that appear in both the detail and summary sections.
    """
    negociacoes: List[Negociacao] = []
    seen: set = set()
    trade_date = extract_trade_date(text)
    if trade_date:
        logger.info(f"Data do pregão: {trade_date}")

    def emit(tipo: str, ticker: str, quantidade: int, preco: float) -> None:
        key = (tipo, ticker, quantidade, preco)
        if key not in seen:
            seen.add(key)
            negociacoes.append(Negociacao(tipo, ticker, quantidade, preco, data=trade_date))
            logger.info(f"Operação: {tipo} {ticker} x{quantidade} @ R${preco:.2f}")
        else:
            logger.debug(f"Duplicata ignorada: {tipo} {ticker} x{quantidade} @ R${preco:.2f}")

    # ── Strategy 1: single-line regex ────────────────────────────────────────
    single = re.sub(r"\s+", " ", text).strip()

    primary = re.compile(
        r"\d-BOVESPA\s+(C|V)\s+VISTA\s+"   # mercado + direção
        r"(?:FII\s+)?"                       # opcional "FII"
        r"(?:.*?)"                           # nome do fundo (não-guloso)
        r"([A-Z]{4}\d{2})\b"                # ticker: 4 letras + 2 dígitos
        r"(?:\s+[A-Z]+)*\s+"                # códigos opcionais (CI, ER…)
        r"(\d{1,6})\s+"                     # quantidade (inteiro)
        r"(\d{1,3}(?:\.\d{3})*,\d{2})",    # preço formato brasileiro
        re.IGNORECASE,
    )

    for m in primary.finditer(single):
        tipo = m.group(1).upper()
        ticker = m.group(2).upper()
        qty = int(m.group(3))
        preco = _parse_price(m.group(4))
        emit(tipo, ticker, qty, preco)

    if negociacoes:
        logger.info(f"Estratégia 1 encontrou {len(negociacoes)} operação(ões)")
        return negociacoes

    # ── Strategy 2: line-by-line state machine ────────────────────────────────
    logger.info("Estratégia 1 sem resultados — usando máquina de estados por linha")
    lines = [l.strip() for l in text.split("\n") if l.strip()]

    i = 0
    while i < len(lines):
        line = lines[i]

        if not re.search(r"\d-BOVESPA", line):
            i += 1
            continue

        # Found BOVESPA marker — locate C/V VISTA (same line or next few)
        tipo = None
        cv_line = i

        for j in range(i, min(i + 5, len(lines))):
            cv_m = re.search(r"\b(C|V)\s+VISTA\b", lines[j], re.IGNORECASE)
            if cv_m:
                tipo = cv_m.group(1).upper()
                cv_line = j
                break
            # Handle "C" or "V" alone on a line
            if re.fullmatch(r"(C|V)", lines[j].strip(), re.IGNORECASE):
                tipo = lines[j].strip().upper()
                cv_line = j
                break

        if tipo is None:
            i += 1
            continue

        # Locate ticker: 4 uppercase letters + 2 digits
        ticker = None
        ticker_idx = None
        for j in range(cv_line, min(cv_line + 12, len(lines))):
            tm = re.search(r"\b([A-Z]{4}\d{2})\b", lines[j])
            if tm:
                ticker = tm.group(1).upper()
                ticker_idx = j
                break

        if ticker is None:
            i += 1
            continue

        # Build context starting from the remainder of the ticker line
        ticker_line = lines[ticker_idx]
        ticker_pos = ticker_line.find(ticker)
        remainder = ticker_line[ticker_pos + len(ticker):] if ticker_pos >= 0 else ""
        context_lines = [remainder] + lines[ticker_idx + 1 : ticker_idx + 10]
        context = " ".join(l.strip() for l in context_lines if l.strip())

        # Token-by-token extraction: skip letter-only codes, first int = qty,
        # first comma-decimal after qty = unit price
        qty = None
        preco = None
        for token in context.split():
            if re.fullmatch(r"[A-Za-z]+", token):
                continue
            if qty is None and re.fullmatch(r"\d{1,6}", token):
                qty = int(token)
                continue
            if qty is not None and preco is None and re.fullmatch(
                r"\d{1,3}(?:\.\d{3})*,\d{2}", token
            ):
                preco = _parse_price(token)
                break

        if qty and preco:
            emit(tipo, ticker, qty, preco)
            i = ticker_idx + 1
        else:
            logger.warning(
                f"Não foi possível extrair qty/preço para {ticker} perto da linha {ticker_idx}"
            )
            i += 1

    if not negociacoes:
        logger.warning("Nenhuma operação encontrada no texto do PDF")
        logger.debug(f"Texto completo extraído:\n{text[:2000]}")

    return negociacoes


def process_pdf(pdf_bytes: bytes, password: str = "097") -> List[Negociacao]:
    """
    Full pipeline: decrypt → extract text → parse operations.
    Returns list of Negociacao found in the nota de negociação.
    """
    logger.info("Passo 1/3: Descriptografando PDF...")
    decrypted = decrypt_pdf(pdf_bytes, password)
    logger.info(f"PDF descriptografado: {len(decrypted)} bytes")

    logger.info("Passo 2/3: Extraindo texto...")
    text = extract_text(decrypted)
    logger.info(f"Texto extraído: {len(text)} caracteres")

    if not text.strip():
        logger.error("Texto extraído vazio — impossível fazer parsing")
        return []

    logger.info("Passo 3/3: Fazendo parsing das operações...")
    ops = parse_negociacoes(text)
    logger.info(f"Total: {len(ops)} operação(ões) encontrada(s)")
    return ops
