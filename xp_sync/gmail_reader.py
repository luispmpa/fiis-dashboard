"""
Gmail reader for XP trading note emails.

Searches for unprocessed emails from no-reply@xpi.com.br with PDF
attachments, downloads them, and marks them processed via label.

Authentication: loads OAuth2 credentials from GMAIL_TOKEN_JSON env var
(JSON produced by auth_setup.py). Token refresh is handled automatically.
"""

import base64
import json
import logging
import os
from typing import List, Tuple

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logger = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
XP_SENDER = "no-reply@xpi.com.br"
PROCESSED_LABEL = "xp-processado"


def get_credentials() -> Credentials:
    """Load Gmail OAuth2 credentials from GMAIL_TOKEN_JSON environment variable."""
    token_json = os.environ.get("GMAIL_TOKEN_JSON")
    if not token_json:
        raise ValueError(
            "Variável de ambiente GMAIL_TOKEN_JSON não definida. "
            "Execute xp_sync/auth_setup.py para gerar o token."
        )

    token_data = json.loads(token_json)

    creds = Credentials(
        token=token_data.get("token"),
        refresh_token=token_data.get("refresh_token"),
        token_uri=token_data.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=token_data.get("client_id"),
        client_secret=token_data.get("client_secret"),
        scopes=token_data.get("scopes", SCOPES),
    )

    if creds.expired and creds.refresh_token:
        logger.info("Credenciais expiradas — renovando token...")
        creds.refresh(Request())
        logger.info("Token renovado com sucesso")

    return creds


def build_gmail_service():
    """Build and return an authenticated Gmail API service."""
    creds = get_credentials()
    return build("gmail", "v1", credentials=creds)


def get_or_create_label(service, label_name: str) -> str:
    """Return label ID for label_name, creating the label if it doesn't exist."""
    result = service.users().labels().list(userId="me").execute()
    for label in result.get("labels", []):
        if label["name"].lower() == label_name.lower():
            logger.debug(f"Label encontrada: {label_name} (id={label['id']})")
            return label["id"]

    created = service.users().labels().create(
        userId="me",
        body={
            "name": label_name,
            "labelListVisibility": "labelShow",
            "messageListVisibility": "show",
        },
    ).execute()
    logger.info(f"Label criada: {label_name} (id={created['id']})")
    return created["id"]


def get_unprocessed_emails(service, processed_label_id: str) -> List[dict]:
    """
    Return messages from XP_SENDER with PDF attachments not yet labeled
    as PROCESSED_LABEL.
    """
    query = (
        f"from:{XP_SENDER} has:attachment filename:pdf "
        f"-label:{PROCESSED_LABEL}"
    )
    logger.info(f"Buscando e-mails no Gmail: {query}")

    results = service.users().messages().list(
        userId="me", q=query, maxResults=50
    ).execute()

    messages = results.get("messages", [])
    logger.info(f"{len(messages)} e-mail(s) não processado(s) encontrado(s)")
    return messages


def get_email_subject(service, message_id: str) -> str:
    """Fetch Subject header for logging purposes."""
    try:
        msg = service.users().messages().get(
            userId="me",
            id=message_id,
            format="metadata",
            metadataHeaders=["Subject", "Date"],
        ).execute()
        for h in msg.get("payload", {}).get("headers", []):
            if h["name"] == "Subject":
                return h["value"]
    except HttpError:
        pass
    return f"(id={message_id})"


def get_pdf_attachments(service, message_id: str) -> List[Tuple[str, bytes]]:
    """
    Download all PDF attachments from a message.
    Returns list of (filename, pdf_bytes) tuples.
    """
    msg = service.users().messages().get(
        userId="me", id=message_id, format="full"
    ).execute()

    attachments: List[Tuple[str, bytes]] = []

    def process_parts(parts: list) -> None:
        for part in parts:
            if part.get("parts"):
                process_parts(part["parts"])
                continue

            filename = part.get("filename", "")
            mime_type = part.get("mimeType", "")

            if not (filename.lower().endswith(".pdf") or "pdf" in mime_type.lower()):
                continue

            body = part.get("body", {})
            attachment_id = body.get("attachmentId")
            data = body.get("data")

            if attachment_id:
                att = service.users().messages().attachments().get(
                    userId="me", messageId=message_id, id=attachment_id
                ).execute()
                data = att.get("data", "")

            if data:
                pdf_bytes = base64.urlsafe_b64decode(data)
                name = filename or "nota.pdf"
                logger.info(f"Anexo PDF: {name} ({len(pdf_bytes):,} bytes)")
                attachments.append((name, pdf_bytes))

    payload = msg.get("payload", {})
    parts = payload.get("parts", [])
    if parts:
        process_parts(parts)
    elif payload.get("body", {}).get("data"):
        # Single-part message (unusual for PDFs, but handle it)
        data = payload["body"]["data"]
        pdf_bytes = base64.urlsafe_b64decode(data)
        attachments.append(("nota.pdf", pdf_bytes))

    return attachments


def mark_as_processed(service, message_id: str, processed_label_id: str) -> None:
    """Apply the PROCESSED_LABEL label to a message (idempotent)."""
    service.users().messages().modify(
        userId="me",
        id=message_id,
        body={"addLabelIds": [processed_label_id]},
    ).execute()
    logger.info(f"E-mail {message_id} marcado como processado")
