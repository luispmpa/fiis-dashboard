// scripts/update-fiis.js — atualiza FIIs e Ações no Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BRAPI_TOKEN  = process.env.BRAPI_TOKEN || '';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getTickers(table) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=ticker&order=ticker`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  if (!res.ok) throw new Error(`Erro ao buscar tickers de ${table}: ${res.status}`);
  return (await res.json()).map(r => r.ticker);
}

async function fetchTicker(ticker) {
  const url = `https://brapi.dev/api/quote/${ticker}?token=${BRAPI_TOKEN}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json?.results?.[0] ?? null;
}

async function fetchWeekly(ticker) {
  try {
    const url = `https://brapi.dev/api/quote/${ticker}?range=5d&interval=1d&token=${BRAPI_TOKEN}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const prices = (await res.json())?.results?.[0]?.historicalDataPrice;
    if (!prices || prices.length < 2) return null;
    const oldest = prices[0].close, newest = prices[prices.length - 1].close;
    if (!oldest || !newest) return null;
    return parseFloat((((newest - oldest) / oldest) * 100).toFixed(4));
  } catch { return null; }
}

// Dividendo para FIIs via FundsExplorer
async function fetchDividendoFE(ticker) {
  try {
    const url = `https://www.fundsexplorer.com.br/funds/${ticker.toUpperCase()}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html', 'Accept-Language': 'pt-BR,pt;q=0.9' }
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

// Dividendo para ações via BraPI (últimos 12 meses)
async function fetchDividendoAcao(ticker) {
  try {
    const url = `https://brapi.dev/api/quote/${ticker}?modules=dividendsData&token=${BRAPI_TOKEN}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { ultimoDiv: null, dyAnual: null };
    const json = await res.json();
    const divs = json?.results?.[0]?.dividendsData?.cashDividends;
    if (!divs || divs.length === 0) return { ultimoDiv: null, dyAnual: null };

    // Ordena por data decrescente
    const sorted = [...divs].sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));
    const ultimoDiv = sorted[0]?.adjustedValue ?? null;

    // DY anual = soma dos dividendos dos últimos 12 meses
    const umAnoAtras = new Date();
    umAnoAtras.setFullYear(umAnoAtras.getFullYear() - 1);
    const soma12m = sorted
      .filter(d => new Date(d.paymentDate) >= umAnoAtras)
      .reduce((acc, d) => acc + (d.adjustedValue ?? 0), 0);

    return { ultimoDiv, dyAnual: soma12m > 0 ? soma12m : null };
  } catch { return { ultimoDiv: null, dyAnual: null }; }
}

async function upsertSupabase(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
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

async function processarFiis(tickers) {
  console.log(`\n── FIIs (${tickers.length}) ──`);
  const rows = [];
  for (const ticker of tickers) {
    try {
      const r = await fetchTicker(ticker);
      if (!r) { console.log(`  ${ticker}: sem dados brapi`); continue; }
      const preco = r.regularMarketPrice ?? null;
      await sleep(400);
      const varSem = await fetchWeekly(ticker);
      await sleep(600);
      const ultimoDiv = await fetchDividendoFE(ticker);
      const dyMensal = (ultimoDiv && preco) ? parseFloat(((ultimoDiv / preco) * 100).toFixed(4)) : null;
      rows.push({ ticker, preco_atual: preco, var_dia: r.regularMarketChangePercent ?? null, var_semanal: varSem, ultimo_div: ultimoDiv, dy_percent: dyMensal, atualizado_em: new Date().toISOString() });
      console.log(`  ${ticker}: R$${preco} | div: ${ultimoDiv} | DY: ${dyMensal}%`);
      await sleep(600);
    } catch (e) { console.error(`  ${ticker}: ERRO — ${e.message}`); }
  }
  if (rows.length > 0) {
    await upsertSupabase('fiis_mercado', rows);
    console.log(`✓ ${rows.length} FIIs salvos`);
  }
}

async function processarAcoes(tickers) {
  console.log(`\n── Ações (${tickers.length}) ──`);
  const rows = [];
  for (const ticker of tickers) {
    try {
      const r = await fetchTicker(ticker);
      if (!r) { console.log(`  ${ticker}: sem dados brapi`); continue; }
      const preco = r.regularMarketPrice ?? null;
      await sleep(400);
      const varSem = await fetchWeekly(ticker);
      await sleep(400);
      const { ultimoDiv, dyAnual } = await fetchDividendoAcao(ticker);
      const dyPercent = (dyAnual && preco) ? parseFloat(((dyAnual / preco) * 100).toFixed(4)) : null;
      // setor vem do BraPI quando disponível
      const setor = r.sector ?? r.industry ?? null;
      rows.push({ ticker, nome: r.longName ?? r.shortName ?? ticker, setor, preco_atual: preco, var_dia: r.regularMarketChangePercent ?? null, var_semanal: varSem, ultimo_div: ultimoDiv, dy_percent: dyPercent, atualizado_em: new Date().toISOString() });
      console.log(`  ${ticker}: R$${preco} | div: ${ultimoDiv} | DY anual: ${dyPercent}%`);
      await sleep(600);
    } catch (e) { console.error(`  ${ticker}: ERRO — ${e.message}`); }
  }
  if (rows.length > 0) {
    await upsertSupabase('acoes_mercado', rows);
    console.log(`✓ ${rows.length} ações salvas`);
  }
}
async function fetchDividendEvents(ticker) {
  try {
    const url = `https://brapi.dev/api/quote/${ticker}?modules=dividendsData&token=${BRAPI_TOKEN}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    const json = await res.json();
    const divs = json?.results?.[0]?.dividendsData?.cashDividends;
    if (!divs?.length) return [];

    const now    = new Date();
    const cutoff = new Date(now);
    cutoff.setFullYear(cutoff.getFullYear() - 1); // só últimos 12 meses + futuros

    const isFii = /^[A-Z]{4}1[1-9]$/.test(ticker);

    return divs
      .filter(d => d.paymentDate && new Date(d.paymentDate) >= cutoff)
      .map(d => {
        const payDate = new Date(d.paymentDate);
        const value   = parseFloat((d.adjustedValue ?? d.rate ?? 0).toFixed(6));
        if (!value || value <= 0) return null;
        const rawType   = (d.type || '').toUpperCase();
        const eventType = rawType.includes('JCP')    ? 'JCP'
                        : rawType.includes('RESULT') ? 'RESULTADO'
                        : 'DIVIDENDO';
        return {
          ticker,
          event_type:  eventType,
          event_date:  payDate.toISOString().slice(0, 10),
          value,
          description: `${isFii ? 'Rendimento' : 'Dividendo'} — ${ticker}`,
          status:      payDate < now ? 'PAID' : 'CONFIRMED',
          source:      'brapi',
        };
      })
      .filter(Boolean);
  } catch { return []; }
}

async function popularDividendEvents(fiiTickers, acaoTickers) {
  console.log('\n── Dividend Events ──');
  const events = [];

  for (const ticker of [...fiiTickers, ...acaoTickers]) {
    try {
      const evs = await fetchDividendEvents(ticker);
      if (evs.length) {
        events.push(...evs);
        console.log(`  ${ticker}: ${evs.length} evento(s)`);
      }
      await sleep(500);
    } catch(e) { console.error(`  ${ticker}: ERRO — ${e.message}`); }
  }

  if (!events.length) { console.log('  Nenhum evento encontrado via BraPI'); return; }

  await upsertSupabase('dividend_events', events);
  console.log(`✓ ${events.length} eventos salvos em dividend_events`);
}
async function main() {
  console.log(`[${new Date().toISOString()}] Iniciando atualização de ativos`);
  const [fiiTickers, acaoTickers] = await Promise.all([
    getTickers('fiis_mercado'),
    getTickers('acoes_mercado'),
  ]);
  console.log(`FIIs: ${fiiTickers.length} | Ações: ${acaoTickers.length}`);

  await processarFiis(fiiTickers);
  await processarAcoes(acaoTickers);
  await popularDividendEvents(fiiTickers, acaoTickers);
  console.log(`\n[${new Date().toISOString()}] Concluído`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
