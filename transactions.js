// ── Constantes IR Brasileiras ──
const IR_FII_TX      = 0.20;
const IR_ACAO_SWING  = 0.15;
const IR_ACAO_DT     = 0.20;
const ISENTO_MAX     = 20000;
const IRRF_SWING_TX  = 0.00005; // 0,005% sobre venda bruta
const IRRF_DT_TX     = 0.01;    // 1% sobre ganho líquido DT

// ── Estado dos modais ──
let _opTicker = null, _opCat = null;

async function _upsertCarteiraRow(cartTable, ticker, qty, pm) {
  await fetch(SUPA_URL + '/rest/v1/' + cartTable, {
    method: 'POST',
    headers: { ...H, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ ticker, quantidade: qty, preco_medio: pm }])
  });
}

// ════════════════════════════════════
//  MODAL COMPRA
// ════════════════════════════════════
function abrirCompra(ticker, cat) {
  _opTicker = ticker; _opCat = cat;
  document.getElementById('mc-ticker').value = ticker;
  document.getElementById('mc-data').value   = new Date().toISOString().slice(0, 10);
  document.getElementById('mc-qty').value    = '';
  document.getElementById('mc-preco').value  = '';
  document.getElementById('mc-taxas').value  = '0';
  document.getElementById('mc-result').classList.remove('show');
  document.getElementById('modal-compra').classList.add('open');
  document.getElementById('mc-qty').focus();
}

function fecharCompra() {
  document.getElementById('modal-compra').classList.remove('open');
  _opTicker = null; _opCat = null;
}

async function confirmarCompra() {
  const ticker = _opTicker, cat = _opCat;
  const data  = document.getElementById('mc-data').value;
  const qty   = Number(document.getElementById('mc-qty').value)   || 0;
  const preco = Number(document.getElementById('mc-preco').value) || 0;
  const taxas = Number(document.getElementById('mc-taxas').value) || 0;
  if (!data || qty <= 0 || preco <= 0) return;
  const btn = document.getElementById('mc-btn-confirm');
  btn.disabled = true; btn.textContent = 'salvando…';
  try {
    const table = cat === 'acao' ? 'acoes_negociacoes' : 'fiis_negociacoes';
    await fetch(SUPA_URL + '/rest/v1/' + table, {
      method: 'POST',
      headers: { ...H, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ ticker, tipo: 'C', quantidade: qty, preco_unitario: preco, data_negociacao: data, taxas })
    });
    fecharCompra();
    await _recalcularPM(ticker, cat);
  } catch (e) { console.error('confirmarCompra:', e); }
  btn.disabled = false; btn.textContent = 'Confirmar';
}

// ════════════════════════════════════
//  MODAL VENDA
// ════════════════════════════════════
function abrirVenda(ticker, cat) {
  _opTicker = ticker; _opCat = cat;
  document.getElementById('mv-ticker').value = ticker;
  document.getElementById('mv-data').value   = new Date().toISOString().slice(0, 10);
  document.getElementById('mv-qty').value    = '';
  document.getElementById('mv-preco').value  = '';
  document.getElementById('mv-taxas').value  = '0';
  document.getElementById('mv-result').classList.remove('show');
  document.getElementById('modal-venda').classList.add('open');
  document.getElementById('mv-qty').focus();
}

function fecharVenda() {
  document.getElementById('modal-venda').classList.remove('open');
  _opTicker = null; _opCat = null;
}

function _previewVenda() {
  const ticker = _opTicker, cat = _opCat;
  if (!ticker) return;
  const cart  = cat === 'acao' ? acoesCart : fiisCart;
  const pm    = Number(cart[ticker]?.preco_medio) || 0;
  const qty   = Number(document.getElementById('mv-qty').value)   || 0;
  const preco = Number(document.getElementById('mv-preco').value) || 0;
  const taxas = Number(document.getElementById('mv-taxas').value) || 0;
  const el = document.getElementById('mv-result');
  if (qty <= 0 || preco <= 0) { el.classList.remove('show'); return; }
  const receita = qty * preco - taxas;
  const custo   = qty * (pm || 0);
  const lucro   = pm > 0 ? receita - custo : null;
  document.getElementById('mv-pm').textContent    = pm > 0 ? fmtR(pm) : '—';
  document.getElementById('mv-custo').textContent = pm > 0 ? fmtR(custo) : '—';
  const lucroEl = document.getElementById('mv-lucro');
  if (lucro !== null) {
    lucroEl.textContent = fmtR(lucro);
    lucroEl.className   = 'op-result-val ' + (lucro >= 0 ? 'pl-pos' : 'pl-neg');
  } else {
    lucroEl.textContent = '—';
    lucroEl.className   = 'op-result-val';
  }
  el.classList.add('show');
}

async function confirmarVenda() {
  const ticker = _opTicker, cat = _opCat;
  const data  = document.getElementById('mv-data').value;
  const qty   = Number(document.getElementById('mv-qty').value)   || 0;
  const preco = Number(document.getElementById('mv-preco').value) || 0;
  const taxas = Number(document.getElementById('mv-taxas').value) || 0;
  if (!data || qty <= 0 || preco <= 0) return;
  const btn = document.getElementById('mv-btn-confirm');
  btn.disabled = true; btn.textContent = 'salvando…';
  try {
    const table     = cat === 'acao' ? 'acoes_negociacoes' : 'fiis_negociacoes';
    const cartTable = cat === 'acao' ? 'acoes_carteira'    : 'fiis_carteira';
    const cart      = cat === 'acao' ? acoesCart           : fiisCart;
    await fetch(SUPA_URL + '/rest/v1/' + table, {
      method: 'POST',
      headers: { ...H, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ ticker, tipo: 'V', quantidade: qty, preco_unitario: preco, data_negociacao: data, taxas })
    });
    const newQty = Math.max(0, (Number(cart[ticker]?.quantidade) || 0) - qty);
    const pm     = Number(cart[ticker]?.preco_medio) || 0;
    await _upsertCarteiraRow(cartTable, ticker, newQty, pm);
    cart[ticker] = { ...cart[ticker], quantidade: newQty };
    fecharVenda();
    render();
    updateSummary();
    if (typeof loadAtividade === 'function') await loadAtividade();
  } catch (e) { console.error('confirmarVenda:', e); }
  btn.disabled = false; btn.textContent = 'Confirmar';
}

// ════════════════════════════════════
//  RECALCULAR PREÇO MÉDIO
// ════════════════════════════════════
async function _recalcularPM(ticker, cat) {
  const table     = cat === 'acao' ? 'acoes_negociacoes' : 'fiis_negociacoes';
  const cartTable = cat === 'acao' ? 'acoes_carteira'    : 'fiis_carteira';
  const cart      = cat === 'acao' ? acoesCart           : fiisCart;
  const negs = await fetch(
    SUPA_URL + '/rest/v1/' + table + '?ticker=eq.' + ticker + '&order=data_negociacao.asc',
    { headers: H }
  ).then(r => r.json()).catch(() => []);
  let qty = 0, totalCost = 0;
  for (const n of (Array.isArray(negs) ? negs : [])) {
    const q = Number(n.quantidade)     || 0;
    const p = Number(n.preco_unitario) || 0;
    const x = Number(n.taxas)          || 0;
    const t = (n.tipo || '').toLowerCase();
    if (t === 'c' || t === 'compra') {
      totalCost += q * p + x;
      qty       += q;
    } else if (t === 'v' || t === 'venda') {
      const pm = qty > 0 ? totalCost / qty : 0;
      qty = Math.max(0, qty - q);
      totalCost = qty * pm;
    }
  }
  const pm = qty > 0 ? totalCost / qty : 0;
  await _upsertCarteiraRow(cartTable, ticker, qty, pm);
  cart[ticker] = { ...cart[ticker], quantidade: qty, preco_medio: pm };
  render();
  updateSummary();
  if (typeof loadAtividade === 'function') await loadAtividade();
}

// ════════════════════════════════════
//  DETECÇÃO DE DAY TRADE
// ════════════════════════════════════
function _detectarDayTradeDates(negs, ticker) {
  const byDate = {};
  for (const n of negs) {
    if (n.ticker !== ticker) continue;
    const d = (n.data_negociacao || '').slice(0, 10);
    if (!byDate[d]) byDate[d] = { c: false, v: false };
    const t = (n.tipo || '').toLowerCase();
    if (t === 'c' || t === 'compra') byDate[d].c = true;
    else if (t === 'v' || t === 'venda') byDate[d].v = true;
  }
  const dtDates = new Set();
  for (const [d, ops] of Object.entries(byDate)) {
    if (ops.c && ops.v) dtDates.add(d);
  }
  return dtDates;
}

// ════════════════════════════════════
//  CÁLCULO IR MENSAL — LEGISLAÇÃO BR
// ════════════════════════════════════
function calcularIRMensalBR(fiiNegs, acNegs, fiiLoss0, acSwingLoss0, acDtLoss0) {
  const months = {};
  const _m = ym => {
    if (!months[ym]) months[ym] = {
      fii:     { vendas: 0, custo: 0, ganho: 0, prejComp: 0, base: 0, ir: 0, irrf: 0, ops: [] },
      acSwing: { vendas: 0, custo: 0, ganho: 0, isento: false, prejComp: 0, base: 0, ir: 0, irrf: 0, ops: [] },
      acDt:    { vendas: 0, custo: 0, ganho: 0, prejComp: 0, base: 0, ir: 0, irrf: 0, ops: [] },
    };
    return months[ym];
  };

  // FIIs
  const fiiBook = {};
  for (const n of fiiNegs) {
    const t     = n.ticker;
    if (!fiiBook[t]) fiiBook[t] = { qty: 0, totalCost: 0 };
    const qty   = Number(n.quantidade    ?? 0);
    const preco = Number(n.preco_unitario ?? 0);
    const taxas = Number(n.taxas          ?? 0);
    const tipo  = (n.tipo || '').toLowerCase();
    if (tipo === 'c' || tipo === 'compra') {
      fiiBook[t].totalCost += qty * preco + taxas;
      fiiBook[t].qty       += qty;
    } else if (tipo === 'v' || tipo === 'venda') {
      const pm      = fiiBook[t].qty > 0 ? fiiBook[t].totalCost / fiiBook[t].qty : 0;
      const custo   = pm * qty;
      const receita = preco * qty - taxas;
      const date    = (n.data_negociacao ?? '').slice(0, 10);
      const ym      = date.slice(0, 7);
      const m       = _m(ym);
      m.fii.vendas += preco * qty;
      m.fii.custo  += custo;
      m.fii.ops.push({ ticker: t, cat: 'fii', tipo: 'FII', date, ym, qty, preco, pm, custo, receita, resultado: receita - custo });
      fiiBook[t].qty       = Math.max(0, fiiBook[t].qty - qty);
      fiiBook[t].totalCost = fiiBook[t].qty * pm;
    }
  }

  // Ações — detectar day trades antes de processar o livro
  const allAcTickers = [...new Set(acNegs.map(n => n.ticker))];
  const dtByTicker = {};
  for (const t of allAcTickers) {
    dtByTicker[t] = _detectarDayTradeDates(acNegs, t);
  }

  const acBook = {};
  for (const n of acNegs) {
    const t     = n.ticker;
    if (!acBook[t]) acBook[t] = { qty: 0, totalCost: 0 };
    const qty   = Number(n.quantidade    ?? 0);
    const preco = Number(n.preco_unitario ?? 0);
    const taxas = Number(n.taxas          ?? 0);
    const tipo  = (n.tipo || '').toLowerCase();
    if (tipo === 'c' || tipo === 'compra') {
      acBook[t].totalCost += qty * preco + taxas;
      acBook[t].qty       += qty;
    } else if (tipo === 'v' || tipo === 'venda') {
      const pm      = acBook[t].qty > 0 ? acBook[t].totalCost / acBook[t].qty : 0;
      const custo   = pm * qty;
      const receita = preco * qty - taxas;
      const date    = (n.data_negociacao ?? '').slice(0, 10);
      const ym      = date.slice(0, 7);
      const isDT    = dtByTicker[t]?.has(date) ?? false;
      const m       = _m(ym);
      const slot    = isDT ? m.acDt : m.acSwing;
      slot.vendas += preco * qty;
      slot.custo  += custo;
      slot.ops.push({ ticker: t, cat: 'acao', tipo: isDT ? 'DT' : 'SW', date, ym, qty, preco, pm, custo, receita, resultado: receita - custo });
      acBook[t].qty       = Math.max(0, acBook[t].qty - qty);
      acBook[t].totalCost = acBook[t].qty * pm;
    }
  }

  // Aplicar IR por mês na ordem cronológica com carry-forward de prejuízo
  let fiiLoss     = Math.abs(fiiLoss0);
  let swingLoss   = Math.abs(acSwingLoss0);
  let dtLoss      = Math.abs(acDtLoss0);

  for (const ym of Object.keys(months).sort()) {
    const m = months[ym];

    // FII — 20%, sem isenção, IRRF 0,005% sobre vendas brutas
    m.fii.ganho    = m.fii.vendas - m.fii.custo;
    m.fii.prejComp = m.fii.ganho > 0 ? Math.min(fiiLoss, m.fii.ganho) : 0;
    m.fii.base     = Math.max(0, m.fii.ganho - fiiLoss);
    m.fii.ir       = m.fii.base * IR_FII_TX;
    m.fii.irrf     = m.fii.vendas * IRRF_SWING_TX;
    fiiLoss        = m.fii.ganho >= 0
      ? Math.max(0, fiiLoss - m.fii.ganho)
      : fiiLoss + Math.abs(m.fii.ganho);

    // Ação Swing — 15%, isento se vendas ≤ 20k, IRRF 0,005% vendas brutas
    m.acSwing.ganho  = m.acSwing.vendas - m.acSwing.custo;
    m.acSwing.isento = m.acSwing.vendas <= ISENTO_MAX;
    if (m.acSwing.isento) {
      m.acSwing.prejComp = 0;
      m.acSwing.base     = 0;
      m.acSwing.ir       = 0;
      if (m.acSwing.ganho < 0) swingLoss += Math.abs(m.acSwing.ganho);
    } else {
      m.acSwing.prejComp = m.acSwing.ganho > 0 ? Math.min(swingLoss, m.acSwing.ganho) : 0;
      m.acSwing.base     = Math.max(0, m.acSwing.ganho - swingLoss);
      m.acSwing.ir       = m.acSwing.base * IR_ACAO_SWING;
      swingLoss          = m.acSwing.ganho >= 0
        ? Math.max(0, swingLoss - m.acSwing.ganho)
        : swingLoss + Math.abs(m.acSwing.ganho);
    }
    m.acSwing.irrf = m.acSwing.vendas * IRRF_SWING_TX;

    // Ação Day Trade — 20%, sem isenção, IRRF 1% sobre ganho líquido DT
    m.acDt.ganho    = m.acDt.vendas - m.acDt.custo;
    m.acDt.prejComp = m.acDt.ganho > 0 ? Math.min(dtLoss, m.acDt.ganho) : 0;
    m.acDt.base     = Math.max(0, m.acDt.ganho - dtLoss);
    m.acDt.ir       = m.acDt.base * IR_ACAO_DT;
    m.acDt.irrf     = Math.max(0, m.acDt.ganho) * IRRF_DT_TX;
    dtLoss          = m.acDt.ganho >= 0
      ? Math.max(0, dtLoss - m.acDt.ganho)
      : dtLoss + Math.abs(m.acDt.ganho);

    m.totalIR   = m.fii.ir + m.acSwing.ir + m.acDt.ir;
    m.totalIRRF = m.fii.irrf + m.acSwing.irrf + m.acDt.irrf;
    m.totalDARF = Math.max(0, m.totalIR - m.totalIRRF);
  }

  return months;
}

// ── Fechar modais ao clicar fora ──
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-compra')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-compra')) fecharCompra();
  });
  document.getElementById('modal-venda')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-venda')) fecharVenda();
  });
  ['mv-qty','mv-preco','mv-taxas'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', _previewVenda);
  });
});
