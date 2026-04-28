# Carteira FII — Setup

## Estrutura do projeto

```
fiis-dashboard/
├── index.html                        ← painel (GitHub Pages)
├── scripts/
│   └── update-fiis.js                ← script de atualização
└── .github/
    └── workflows/
        └── update.yml                ← GitHub Actions (agendamento diário)
```

---

## 1. Criar repositório no GitHub

1. Acesse github.com → **New repository**
2. Nome: `fiis-dashboard`
3. Visibilidade: **Public** (necessário para GitHub Pages gratuito)
4. Criar sem README

---

## 2. Fazer upload dos arquivos

No repositório criado, suba os arquivos mantendo a estrutura de pastas acima.

---

## 3. Configurar GitHub Pages

1. No repositório → **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` / pasta: `/ (root)`
4. Salvar — em 1-2 minutos seu painel estará em:
   `https://luispmpa.github.io/fiis-dashboard/`

---

## 4. Configurar secrets do GitHub Actions

No repositório → **Settings → Secrets and variables → Actions → New repository secret**

Adicione dois secrets:

| Nome | Valor |
|------|-------|
| `SUPABASE_URL` | `https://ityrkysliksvvhpvweft.supabase.co` |
| `SUPABASE_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` (anon key completa) |

Opcional (aumenta limite de chamadas da brapi):
| `BRAPI_TOKEN` | seu token do brapi.dev (gratuito em brapi.dev/home) |

---

## 5. Testar atualização manual

No repositório → **Actions → Atualizar dados FIIs → Run workflow**

Se tudo correr bem, o log mostrará os preços coletados e "✓ 11 tickers salvos no Supabase".

---

## 6. Agendamento automático

O workflow roda automaticamente **de segunda a sexta às 11h BRT**.
Para alterar o horário, edite a linha `cron` em `.github/workflows/update.yml`.

---

## Uso do painel

- **Cotas**: informe quantas cotas você possui de cada ticker
- **Preço médio**: informe seu preço médio de compra
- Clique em **salvar** — os dados ficam no Supabase e persistem entre sessões
- **Sinal**:
  - `↓ COMPRAR` — preço atual está mais de 3% abaixo do seu preço médio
  - `↑ VENDER`  — preço atual está mais de 5% acima do seu preço médio
  - `→ MANTER`  — dentro da faixa

---

## Dependências

- GitHub (gratuito)
- GitHub Pages (gratuito)
- GitHub Actions (gratuito — 2000 min/mês)
- Supabase projeto "Financeiro" (já configurado)
- brapi.dev — plano gratuito (150 req/dia sem token; ~500/dia com token gratuito)
