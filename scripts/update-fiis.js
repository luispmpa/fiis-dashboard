// scripts/update-fiis.js
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BRAPI_TOKEN  = process.env.BRAPI_TOKEN || '';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Busca tickers dinamicamente do Supabase
async function getTickers() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/fiis_mercado?select=ticker&order=ticker`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Erro ao buscar tickers: ${res.status}`);
  const data = await res.json();
  return data.map(r => r.ticker);
}

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

async function fetchDividendoFE(ticker) {
  try {
    const url = `https://www.fundsexplorer.com.br/funds/${ticker.toUpperCase()}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'pt-BR,pt;q=0.9'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();

    const patterns = [
      /[Úú]ltimo\s+Rendimento[\s\S]{0,300}?<b>\s*([\d]+[.,][\d]{2,4})\s*<\/b>/,
      /[Úú]ltimo\s+Dividendo[\s\S]{0,300}?<b>\s*([\d]+[.,][\d]{2,4})\s*<\/b>/,
      /"lastDividend"\s*:\s*([\d.]+)/,
      /[Úú]ltimo\s+Rendimento[\s\S]{0,500}?R\$\s*<\/small>\s*<b>\s*([\d]+[.,][\d]{2,4})/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const val = parseFloat(match[1].replace(',', '.'));
        if (val > 0 && val < 50) return val;
      }
    }
    return null;
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
  // Lê tickers dinamicamente do Supabase
  const TICKERS = await getTickers();
  console.log(`[${new Date().toISOString()}] Iniciando ${TICKERS.length} tickers: ${TICKERS.join(', ')}`);

  const rows = [];

  for (const ticker of TICKERS) {
    try {
      const r = await fetchTicker(ticker);
      if (!r) { console.log(`  ${ticker}: sem dados brapi`); continue; }

      const preco = r.regularMarketPrice ?? null;

      await sleep(400);
      const varSem = await fetchWeekly(ticker);

      await sleep(600);
      const ultimoDiv = await fetchDividendoFE(ticker);
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
      await sleep(600);
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
