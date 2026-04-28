// scripts/update-fiis.js
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BRAPI_TOKEN  = process.env.BRAPI_TOKEN || '';

const TICKERS = [
  'MXRF11','HGLG11','KNRI11','XPML11','MCCI11',
  'KNCR11','TRXF11','BTLG11','HGRU11','XPLG11','VISC11'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchTicker(ticker) {
  const url = `https://brapi.dev/api/quote/${ticker}?token=${BRAPI_TOKEN}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json?.results?.[0] ?? null;
}

async function fetchWeekly(ticker) {
  try {
    const url = `https://brapi.dev/api/quote/${ticker}?range=5d&interval=1d&token=${BRAPI_TOKEN}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json();
    const prices = json?.results?.[0]?.historicalDataPrice;
    if (!prices || prices.length < 2) return null;
    const oldest = prices[0].close;
    const newest = prices[prices.length - 1].close;
    if (!oldest || !newest) return null;
    return parseFloat((((newest - oldest) / oldest) * 100).toFixed(4));
  } catch { return null; }
}

// mfinance retorna dividendYield como DY% anual
// último dividendo mensal estimado = (dyAnual% / 100 / 12) * preço
async function fetchDividendo(ticker, preco) {
  try {
    const url = `https://mfinance.com.br/api/v1/fiis/${ticker}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    const json = await res.json();
    const dyAnual = json?.dividendYield ?? null;
    if (!dyAnual || !preco) return null;
    return parseFloat(((dyAnual / 100 / 12) * preco).toFixed(4));
  } catch { return null; }
}

async function upsertSupabase(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/fiis_mercado`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

async function main() {
  console.log(`[${new Date().toISOString()}] Iniciando ${TICKERS.length} tickers...`);

  const rows = [];

  for (const ticker of TICKERS) {
    try {
      const r = await fetchTicker(ticker);
      if (!r) { console.log(`  ${ticker}: sem dados`); continue; }

      const preco = r.regularMarketPrice ?? null;

      await sleep(400);
      const varSem = await fetchWeekly(ticker);

      await sleep(400);
      const ultimoDiv = await fetchDividendo(ticker, preco);
      const dyMensal = (ultimoDiv && preco)
        ? parseFloat(((ultimoDiv / preco) * 100).toFixed(4))
        : null;

      rows.push({
        ticker,
        preco_atual:   preco,
        var_dia:       r.regularMarketChangePercent ?? null,
        var_semanal:   varSem,
        ultimo_div:    ultimoDiv,
        dy_percent:    dyMensal,
        atualizado_em: new Date().toISOString()
      });

      console.log(`  ${ticker}: R$${preco} | div: ${ultimoDiv} | DY: ${dyMensal}%`);
      await sleep(400);
    } catch (e) {
      console.error(`  ${ticker}: ERRO — ${e.message}`);
    }
  }

  if (rows.length === 0) {
    console.error('Nenhum dado coletado.');
    process.exit(1);
  }

  try {
    await upsertSupabase(rows);
    console.log(`\n✓ ${rows.length} tickers salvos no Supabase`);
  } catch (e) {
    console.error('Erro Supabase:', e.message);
    process.exit(1);
  }
}

main();
