"""
One-time Gmail OAuth2 setup script.

Run this LOCALLY once to authorise the application and generate the
token that gets stored as the GMAIL_TOKEN_JSON GitHub Actions secret.

Prerequisites:
    1. Create a Google Cloud project at https://console.cloud.google.com
    2. Enable the Gmail API
    3. Create OAuth 2.0 credentials (Desktop app type)
    4. Download the credentials file as  credentials.json  in this directory
    5. pip install google-auth-oauthlib

Usage:
    python xp_sync/auth_setup.py

After running:
    - Copy the printed JSON and add it as GitHub secret  GMAIL_TOKEN_JSON
    - Also set secrets  SUPABASE_URL  and  SUPABASE_KEY
"""

import json
import sys

try:
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError:
    print("Instale: pip install google-auth-oauthlib")
    sys.exit(1)

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
CREDENTIALS_FILE = "credentials.json"


def main() -> None:
    print("Iniciando configuração OAuth2 do Gmail...")
    print("Uma janela do navegador será aberta — autorize o aplicativo.\n")

    try:
        flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
    except FileNotFoundError:
        print(f"Arquivo '{CREDENTIALS_FILE}' não encontrado.")
        print("Baixe as credenciais OAuth2 do Google Cloud Console e salve como credentials.json")
        sys.exit(1)

    creds = flow.run_local_server(port=0)

    token_data = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes) if creds.scopes else SCOPES,
    }

    token_json = json.dumps(token_data, indent=2)

    with open("token.json", "w") as f:
        f.write(token_json)

    print("\n✓ Token salvo em token.json")
    print("\n" + "─" * 60)
    print("Adicione o conteúdo abaixo como secret GMAIL_TOKEN_JSON no GitHub:")
    print("  Settings → Secrets and variables → Actions → New repository secret")
    print("─" * 60)
    print(token_json)
    print("─" * 60)
    print("\nTambém configure estes secrets no GitHub Actions:")
    print("  SUPABASE_URL = https://ityrkysliksvvhpvweft.supabase.co")
    print("  SUPABASE_KEY = <sua anon key do Supabase>")


if __name__ == "__main__":
    main()
