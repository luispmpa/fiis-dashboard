// scripts/update-fiis.js
// Roda via GitHub Actions - busca dados da brapi.dev e salva no Supabase

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TICKERS = [
  'MXRF11','HGLG11','KNRI11','XPML11','MCCI11',
  'KNCR11','TRXF11','BTLG11','HGRU11','XPLG11','VISC11'
];

async function fetchBrapi(tickers) {
  const symbols = tickers.join(',');
  const url = `https://brapi.dev/api/quote/${symbols}?modules=dividendsData&fundamental=true&token=${process.env.BRAPI_TOKEN || ''}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });

  if (!res.ok) throw new Error(`brapi erro ${res.status}: ${await res.text()}`);
  return res.json();
}

function getUltimoDividendo(result) {
  try {
    // Tenta dividendsData.cashDividends
    const divs = result?.dividendsData?.cashDividends;
    if (divs && divs.length > 0) {
      const sorted = [...divs].sort((a, b) =>
        new Date(b.paymentDate || b.approvedOn || 0) -
        new Date(a.paymentDate || a.approvedOn || 0)
      );
      return sorted[0].rate ?? sorted[0].amount ?? null;
    }
    // Fallback: summaryProfile
    return result?.summaryProfile?.lastDividendValue ?? null;
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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase erro ${res.status}: ${err}`);
  }
  return res;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Iniciando atualização de ${TICKERS.length} tickers...`);

  let data;
  try {
    data = await fetchBrapi(TICKERS);
  } catch (e) {
    console.error('Erro ao buscar brapi:', e.message);
    process.exit(1);
  }

  const results = data?.results ?? [];
  if (results.length === 0) {
    console.error('Nenhum resultado retornado pela brapi.');
    console.error(JSON.stringify(data).substring(0, 500));
    process.exit(1);
  }

  const rows = results.map(r => {
    const div      = getUltimoDividendo(r);
    const preco    = r.regularMarketPrice ?? null;
    const dyPct    = (div && preco) ? (div / preco) * 100 : null;

    return {
      ticker:       r.symbol,
      preco_atual:  preco,
      var_dia:      r.regularMarketChangePercent ?? null,
      var_semanal:  null, // brapi não retorna diretamente — calcular via histórico se necessário
      ultimo_div:   div,
      dy_percent:   dyPct ? parseFloat(dyPct.toFixed(4)) : null,
      atualizado_em: new Date().toISOString()
    };
  });

  // Var. semanal: busca preço de 5 dias atrás via histórico
  for (const row of rows) {
    try {
      const url = `https://brapi.dev/api/quote/${row.ticker}?range=5d&interval=1d&token=${process.env.BRAPI_TOKEN || ''}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const hist = await res.json();
        const prices = hist?.results?.[0]?.historicalDataPrice;
        if (prices && prices.length >= 2) {
          const oldest = prices[0].close;
          const newest = prices[prices.length - 1].close;
          if (oldest && newest) {
            row.var_semanal = parseFloat((((newest - oldest) / oldest) * 100).toFixed(4));
          }
        }
      }
    } catch { /* mantém null */ }
  }

  console.log('Dados coletados:');
  rows.forEach(r => console.log(`  ${r.ticker}: R$${r.preco_atual} | div: ${r.ultimo_div} | DY: ${r.dy_percent}%`));

  try {
    await upsertSupabase(rows);
    console.log(`✓ ${rows.length} tickers salvos no Supabase`);
  } catch (e) {
    console.error('Erro ao salvar no Supabase:', e.message);
    process.exit(1);
  }
}

main();
