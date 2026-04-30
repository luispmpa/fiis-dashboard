"""
XP trading notes sync — main orchestrator.

Usage:
    python -m xp_sync.main            # process once and exit (GitHub Actions)
    python -m xp_sync.main --daemon   # loop every 30 minutes

Required environment variables:
    GMAIL_TOKEN_JSON   – OAuth2 token JSON (from auth_setup.py)
    SUPABASE_URL       – Supabase project URL
    SUPABASE_KEY       – Supabase anon or service-role key
"""

import argparse
import logging
import sys
import time

from googleapiclient.errors import HttpError

from xp_sync import gmail_reader, supabase_client
from xp_sync.parser import process_pdf

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

_DAEMON_INTERVAL = 3 * 60 * 60  # seconds (3 hours)
_PDF_PASSWORD = "097"


def run_once() -> int:
    """
    Fetch and process all unprocessed XP trading notes from Gmail.
    Returns the number of emails successfully processed.
    Raises on fatal setup errors (auth, missing env vars).
    """
    logger.info("=" * 60)
    logger.info("XP Trading Notes Sync — iniciando")
    logger.info("=" * 60)

    service = gmail_reader.build_gmail_service()
    logger.info("Gmail API autenticado")

    processed_label_id = gmail_reader.get_or_create_label(
        service, gmail_reader.PROCESSED_LABEL
    )

    messages = gmail_reader.get_unprocessed_emails(service, processed_label_id)

    if not messages:
        logger.info("Nenhum e-mail novo para processar")
        return 0

    processed_count = 0
    error_count = 0

    for msg in messages:
        message_id = msg["id"]
        subject = gmail_reader.get_email_subject(service, message_id)
        logger.info(f"\n{'─' * 50}")
        logger.info(f"E-mail: {subject}")
        logger.info(f"ID: {message_id}")

        email_ok = True

        try:
            attachments = gmail_reader.get_pdf_attachments(service, message_id)

            if not attachments:
                logger.warning("Nenhum PDF encontrado neste e-mail")
                gmail_reader.mark_as_processed(service, message_id, processed_label_id)
                processed_count += 1
                continue

            for filename, pdf_bytes in attachments:
                logger.info(f"\nProcessando PDF: {filename}")

                try:
                    negociacoes = process_pdf(pdf_bytes, password=_PDF_PASSWORD)
                except Exception as e:
                    logger.error(f"Erro ao processar PDF '{filename}': {e}", exc_info=True)
                    email_ok = False
                    continue

                if not negociacoes:
                    logger.warning(f"Nenhuma operação encontrada em '{filename}'")
                    continue

                for neg in negociacoes:
                    logger.info(
                        f"Atualizando Supabase: {neg.tipo} {neg.ticker} "
                        f"x{neg.quantidade} @ R${neg.preco:.2f}"
                    )
                    try:
                        if neg.tipo == "C":
                            supabase_client.process_compra(
                                neg.ticker, neg.quantidade, neg.preco
                            )
                        else:
                            supabase_client.process_venda(
                                neg.ticker, neg.quantidade, neg.preco
                            )
                    except Exception as e:
                        logger.error(
                            f"Erro Supabase para {neg.ticker}: {e}", exc_info=True
                        )
                        email_ok = False

        except HttpError as e:
            logger.error(f"Erro Gmail API: {e}")
            email_ok = False
        except Exception as e:
            logger.error(f"Erro inesperado: {e}", exc_info=True)
            email_ok = False

        if email_ok:
            gmail_reader.mark_as_processed(service, message_id, processed_label_id)
            processed_count += 1
            logger.info(f"✓ E-mail {message_id} processado com sucesso")
        else:
            error_count += 1
            logger.error(
                f"✗ E-mail {message_id} com erros — NÃO marcado como processado "
                "(será reprocessado na próxima execução)"
            )

    logger.info(f"\n{'=' * 60}")
    logger.info(
        f"Concluído: {processed_count} e-mail(s) processado(s), "
        f"{error_count} com erro(s)"
    )
    logger.info("=" * 60)
    return processed_count


def run_daemon() -> None:
    """Run as a long-lived process, calling run_once() every 3 hours."""
    logger.info(f"Modo daemon iniciado (intervalo: {_DAEMON_INTERVAL}s)")
    while True:
        try:
            run_once()
        except Exception as e:
            logger.error(f"Erro no ciclo daemon: {e}", exc_info=True)
        logger.info(f"Aguardando {_DAEMON_INTERVAL}s até próxima verificação...")
        time.sleep(_DAEMON_INTERVAL)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sincroniza notas de negociação XP com a carteira no Supabase"
    )
    parser.add_argument(
        "--daemon",
        action="store_true",
        help=f"Executa continuamente a cada {_DAEMON_INTERVAL // 3600} horas",
    )
    args = parser.parse_args()

    if args.daemon:
        run_daemon()
    else:
        try:
            run_once()
        except Exception as e:
            logger.error(f"Erro fatal: {e}", exc_info=True)
            sys.exit(1)


if __name__ == "__main__":
    main()
