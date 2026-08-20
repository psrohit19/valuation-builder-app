/* Cloudflare Pages Function: GET /api/peer?symbol=TICKER
   India (screener.in consolidated) + US/global (Yahoo).
   mult = EV / EBITDA, EV = market cap + total borrowings (gross of cash)
   days = average of last two annual working-capital days (ex-cash, on sales)
   capex = avg of last two annual fixed-asset additions / sales; da = latest depreciation / sales */

const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=900',
  'Access-Control-Allow-Origin': '*',
};
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html,application/json' };
const round = (v, d) => (v == null || !isFinite(v)) ? null : Math.round(v * 10 ** d) / 10 ** d;
const numly = s => { if (s == null) return null; const v = parseFloat(String(s).replace(/,/g, '')); return isNaN(v) ? null : v; };
// growth helpers — CAGR and simple growth, returned as a percent (null when undefined/non-positive base)
const cagrPct = (nv, ov, yrs) => (nv > 0 && ov > 0 && yrs > 0) ? (Math.pow(nv / ov, 1 / yrs) - 1) * 100 : null;
const growPct = (nv, ov) => (nv != null && isFinite(nv) && ov > 0) ? (nv / ov - 1) * 100 : null;

function screenerRow(html, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lblRe = new RegExp('<td[^>]*class="[^"]*text[^"]*"[^>]*>[\\s\\S]*?' + esc, 'i');
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    if (!lblRe.test(m[1])) continue;
    const nums = [...m[1].matchAll(/<td[^>]*>\s*(-?[\d,]+\.?\d*)\s*<\/td>/g)].map(x => numly(x[1])).filter(v => v != null);
    if (nums.length) return nums;
  }
  return null;
}
function screenerNumber(html, label) {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]{0,160}?<span[^>]*class="[^"]*number[^"]*"[^>]*>\\s*([\\d,\\.]+)', 'i');
  const m = re.exec(html);
  return m ? numly(m[1]) : null;
}
function section(html, id) {
  const m = new RegExp('<section[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</section>', 'i').exec(html);
  return m ? m[1] : '';
}
async function fromScreener(code) {
  const res = await fetch('https://www.screener.in/company/' + encodeURIComponent(code) + '/consolidated/', { headers: UA });
  if (!res.ok) throw new Error('screener ' + res.status);
  const html = await res.text();
  const nameM = /<h1[^>]*>\s*([^<]+?)\s*</i.exec(html);
  const name = nameM ? nameM[1].trim() : code;
  const pl = section(html, 'profit-loss'), bs = section(html, 'balance-sheet'), rt = section(html, 'ratios');
  const sales = screenerRow(pl, 'Sales');
  const opProfit = screenerRow(pl, 'Operating Profit');
  const dep = screenerRow(pl, 'Depreciation');
  const wcDays = screenerRow(rt, 'Working Capital Days');
  const fixed = screenerRow(bs, 'Fixed Assets');
  const borrow = (screenerRow(bs, 'Borrowings') || []).slice(-1)[0] || 0;
  const mcap = screenerNumber(html, 'Market Cap');
  const last = a => (a && a.length) ? a[a.length - 1] : null;
  const ebitda = last(opProfit), revLtm = last(sales);
  if (!mcap || !ebitda || !revLtm) throw new Error('screener: core figures missing');
  const mult = (mcap + (borrow || 0)) / ebitda;
  const days = (wcDays && wcDays.length) ? wcDays.slice(-2).reduce((a, b) => a + b, 0) / Math.min(2, wcDays.length) : null;
  const da = (dep && revLtm) ? Math.abs(last(dep)) / revLtm * 100 : null;
  let capex = null;
  if (fixed && fixed.length >= 2 && dep && dep.length) {
    const k = Math.min(3, fixed.length - 1);
    let sum = 0;
    for (let i = 0; i < k; i++) {
      const fi = fixed.length - 1 - i;
      sum += (fixed[fi] - fixed[fi - 1]) + (dep[dep.length - 1 - i] || last(dep));
    }
    capex = Math.abs(sum / k) / revLtm * 100;
  }
  // growth metrics — last screener column is TTM; annual figures exclude it.
  // 3y CAGR: latest full year vs the year three prior. LTM growth: TTM vs latest full year.
  let rev3 = null, eb3 = null, revLtmG = null, ebLtmG = null;
  if (sales && sales.length >= 2) {
    const annR = sales.slice(0, -1);
    if (annR.length >= 4) rev3 = cagrPct(annR[annR.length - 1], annR[annR.length - 4], 3);
    if (annR.length >= 1) revLtmG = growPct(last(sales), annR[annR.length - 1]);
  }
  if (opProfit && opProfit.length >= 2) {
    const annE = opProfit.slice(0, -1);
    if (annE.length >= 4) eb3 = cagrPct(annE[annE.length - 1], annE[annE.length - 4], 3);
    if (annE.length >= 1) ebLtmG = growPct(last(opProfit), annE[annE.length - 1]);
  }
  return {
    symbol: code, name, currency: 'INR', source: 'screener.in (consolidated)',
    mult: round(mult, 1), days: days == null ? null : round(days, 0),
    capex: capex == null ? null : round(capex, 1), da: da == null ? null : round(da, 1),
    rev3: round(rev3, 1), eb3: round(eb3, 1), revLtmG: round(revLtmG, 1), ebLtmG: round(ebLtmG, 1),
    asOf: { price: new Date().toISOString(), balance: 'latest annual filing' },
  };
}

const YH = 'https://query1.finance.yahoo.com';
const YTYPES = ['trailingEBITDA','trailingTotalRevenue','trailingReconciledDepreciation','annualEBITDA','annualTotalRevenue','annualReconciledDepreciation','annualCurrentAssets','annualCurrentLiabilities','annualCashCashEquivalentsAndShortTermInvestments','annualCashAndCashEquivalents','annualCurrentDebt','annualTotalDebt','annualOrdinarySharesNumber','annualCapitalExpenditure'].join(',');
function yseries(ts, type) {
  const list = (ts && ts.timeseries && ts.timeseries.result) ? ts.timeseries.result : [];
  const r = list.find(x => x && x.meta && x.meta.type && x.meta.type[0] === type);
  if (!r || !r[type]) return [];
  return r[type].filter(v => v && v.reportedValue && typeof v.reportedValue.raw === 'number').map(v => ({ d: v.asOfDate, raw: v.reportedValue.raw }));
}
async function fromYahoo(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const cRes = await fetch(YH + '/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1d&interval=1d', { headers: UA });
  if (!cRes.ok) throw new Error('yahoo quote ' + cRes.status);
  const cj = await cRes.json();
  const meta = (cj && cj.chart && cj.chart.result && cj.chart.result[0]) ? cj.chart.result[0].meta : null;
  if (!meta || typeof meta.regularMarketPrice !== 'number') throw new Error('yahoo: symbol not found');
  const tRes = await fetch(YH + '/ws/fundamentals-timeseries/v1/finance/timeseries/' + encodeURIComponent(symbol) + '?type=' + YTYPES + '&period1=' + (now - 3600 * 24 * 1200) + '&period2=' + now, { headers: UA });
  const ts = tRes.ok ? await tRes.json() : null;
  const lastRaw = a => a.length ? a[a.length - 1].raw : undefined;
  const shares = lastRaw(yseries(ts, 'annualOrdinarySharesNumber'));
  const debt = lastRaw(yseries(ts, 'annualTotalDebt')) || 0;
  const ebitda = lastRaw(yseries(ts, 'trailingEBITDA')) || lastRaw(yseries(ts, 'annualEBITDA'));
  const rev = lastRaw(yseries(ts, 'trailingTotalRevenue')) || lastRaw(yseries(ts, 'annualTotalRevenue'));
  if (!shares || !ebitda || !rev) throw new Error('yahoo: fundamentals unavailable');
  const ev = meta.regularMarketPrice * shares + debt;
  const ca = yseries(ts, 'annualCurrentAssets'), cl = yseries(ts, 'annualCurrentLiabilities');
  const cash = yseries(ts, 'annualCashCashEquivalentsAndShortTermInvestments'), cashO = yseries(ts, 'annualCashAndCashEquivalents'), cd = yseries(ts, 'annualCurrentDebt');
  const at = (a, d) => { const f = a.find(x => x.d === d); return f ? f.raw : undefined; };
  const nwcs = ca.slice(-2).map(c => { const l = at(cl, c.d); if (l === undefined) return undefined; const csh = (at(cash, c.d) != null) ? at(cash, c.d) : (at(cashO, c.d) || 0); const k = at(cd, c.d) || 0; return c.raw - csh - (l - k); }).filter(v => v !== undefined);
  const days = nwcs.length ? (nwcs.reduce((a, b) => a + b, 0) / nwcs.length) / rev * 365 : null;
  const capA = yseries(ts, 'annualCapitalExpenditure').slice(-2).map(v => Math.abs(v.raw));
  const capex = capA.length ? (capA.reduce((a, b) => a + b, 0) / capA.length) / rev * 100 : null;
  const daRaw = lastRaw(yseries(ts, 'trailingReconciledDepreciation')) || lastRaw(yseries(ts, 'annualReconciledDepreciation'));
  const da = daRaw ? daRaw / rev * 100 : null;
  const caLast = ca.length ? ca[ca.length - 1] : null;
  // growth metrics — 3y CAGR from annual series; LTM growth = trailing vs latest full year
  const annRev = yseries(ts, 'annualTotalRevenue'), annEb = yseries(ts, 'annualEBITDA');
  const trR = lastRaw(yseries(ts, 'trailingTotalRevenue')), trE = lastRaw(yseries(ts, 'trailingEBITDA'));
  let rev3 = null, eb3 = null, revLtmG = null, ebLtmG = null;
  if (annRev.length >= 4) rev3 = cagrPct(annRev[annRev.length - 1].raw, annRev[annRev.length - 4].raw, 3);
  if (annRev.length >= 1 && trR != null) revLtmG = growPct(trR, annRev[annRev.length - 1].raw);
  if (annEb.length >= 4) eb3 = cagrPct(annEb[annEb.length - 1].raw, annEb[annEb.length - 4].raw, 3);
  if (annEb.length >= 1 && trE != null) ebLtmG = growPct(trE, annEb[annEb.length - 1].raw);
  return {
    symbol, name: meta.shortName || meta.longName || symbol, currency: meta.currency, source: 'Yahoo Finance',
    mult: round(ev / ebitda, 1), days: days == null ? null : round(days, 0),
    capex: capex == null ? null : round(capex, 1), da: da == null ? null : round(da, 1),
    rev3: round(rev3, 1), eb3: round(eb3, 1), revLtmG: round(revLtmG, 1), ebLtmG: round(ebLtmG, 1),
    asOf: { price: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null, balance: caLast ? caLast.d : null },
  };
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const raw = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-&]{1,20}$/.test(raw)) return new Response(JSON.stringify({ error: 'invalid symbol' }), { status: 400, headers: CORS });
  const bare = raw.replace(/\.(NS|BO)$/, '');
  const isIndia = /\.(NS|BO)$/.test(raw);
  const order = isIndia ? [() => fromScreener(bare)]
    : /^[A-Z]{1,5}$/.test(raw) ? [() => fromYahoo(raw), () => fromScreener(raw), () => fromYahoo(raw + '.NS')]
    : [() => fromScreener(bare), () => fromYahoo(raw)];
  let lastErr = 'not found';
  for (const attempt of order) {
    try { const peer = await attempt(); if (peer && peer.mult != null) return new Response(JSON.stringify(peer), { status: 200, headers: CORS }); }
    catch (e) { lastErr = (e && e.message) ? e.message : String(e); }
  }
  return new Response(JSON.stringify({ error: lastErr, symbol: raw }), { status: 404, headers: CORS });
}
