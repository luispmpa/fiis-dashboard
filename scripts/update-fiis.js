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

    // Log diagnóstico para HGLG11 e MCCI11
    if (ticker === 'HGLG11' || ticker === 'MCCI11' || ticker === 'KNRI11') {
      // Mostra todos os trechos com valores monetários próximos a "ltimo"
      const idx = html.toLowerCase().indexOf('ltimo');
      if (idx > 0) {
        console.log(`[DIAG ${ticker}] trecho "último": ${html.substring(idx - 20, idx + 400).replace(/\s+/g, ' ')}`);
      }
      // Mostra também todos os números R$ no HTML
      const matches = [...html.matchAll(/R\$\s*([\d]+[.,][\d]+)/g)].slice(0, 10);
      console.log(`[DIAG ${ticker}] valores R$ encontrados: ${matches.map(m => m[1]).join(', ')}`);
    }

    // Padrão: procura especificamente na estrutura de dados do FundsExplorer
    // Tenta JSON embutido no HTML (Next.js / __NEXT_DATA__)
    const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextData) {
      try {
        const data = JSON.parse(nextData[1]);
        const str = JSON.stringify(data);
        // Procura lastDividend ou similar no JSON
        const m = str.match(/"lastDividend[^"]*"\s*:\s*([\d.]+)/)
               || str.match(/"dividendValue"\s*:\s*([\d.]+)/)
               || str.match(/"lastPayment"\s*:\s*([\d.]+)/);
        if (m) {
          const val = parseFloat(m[1]);
          if (val > 0 && val < 50) return val;
        }
      } catch {}
    }

    // Fallback: regex no HTML buscando valor após "Último Rendimento" ou similar
    const patterns = [
      /[Úú]ltimo\s+[Rr]endimento[\s\S]{0,500}?([\d]+[.,][\d]{2,4})/,
      /[Úú]ltimo\s+[Dd]ividendo[\s\S]{0,500}?([\d]+[.,][\d]{2,4})/,
      /"lastDividend"\s*:\s*([\d.]+)/,
      /dividend[^"]{0,50}?([\d]+[.,][\d]{2,4})/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const val = parseFloat(match[1].replace(',', '.'));
        if (val > 0 && val < 50) {
          return val;
        }
      }
    }

    return null;
  } catch (e) {
    console.log(`  [FE] ${ticker}: ERRO — ${e.message}`);
    return null;
  }
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
