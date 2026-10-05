require('dotenv').config();
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');

// ===== Provider adapter: CommodityPriceAPI -> ATLAS normalised quotes.
// To swap providers, keep the same exported function signature: getCommodities() -> { items, asOf }.
const BASE = process.env.COMMODITY_API_BASE || 'https://api.commoditypriceapi.com/v2';
const KEY = process.env.COMMODITY_API_KEY;

// ALLOWLIST: ATLAS symbol -> provider symbol. Users can never request anything outside this list.
// XAU, XAG and WTIOIL-FUT appear in the provider's docs. Run `npm run symbols` to confirm the other three.
const MAP = {
  XAU:   { provider: 'XAU',        n: 'Gold',        e: 'oz' },
  XAG:   { provider: 'XAG',        n: 'Silver',      e: 'oz' },
  WTI:   { provider: 'WTIOIL-FUT', n: 'WTI Crude',   e: 'bbl' },
  BRENT: { provider: 'BRENTOIL-FUT', n: 'Brent Crude', e: 'bbl' },
  NG:    { provider: 'NG-FUT',     n: 'Natural Gas', e: 'MMBtu' },
  HG:    { provider: 'HG-FUT',     n: 'Copper',      e: 'lb' },
};

const cache = { latest: null, prev: null };
const hist = {}; // rolling samples per symbol, used for sparklines (since server start)
const TTL = (+process.env.CACHE_SECONDS || 60) * 1000;
const PREV_TTL = 6 * 3600 * 1000;

async function call(path) {
  if (!KEY) throw new Error('COMMODITY_API_KEY is not set');
  const r = await fetch(`${BASE}${path}`, { headers: { 'x-api-key': KEY }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) { const body = await r.text().catch(() => ''); throw new Error(`provider HTTP ${r.status} ${body.slice(0, 300)}`); }
  const j = await r.json();
  if (j.success === false) throw new Error(j.error?.message || 'provider returned success=false');
  return j;
}
const bad = {}; // ATLAS symbol -> { reason, t }: symbols the provider rejected (retried after 1h)
const isBad = k => bad[k] && Date.now() - bad[k].t < 3600e3;
const list = () => Object.keys(MAP).filter(k => !isBad(k)).map(k => MAP[k].provider).join(',');

// One batched request; if it fails, try each symbol alone so one bad symbol can't take down the rest.
async function latestRates() {
  const keys = Object.keys(MAP).filter(k => !isBad(k));
  try { const j = await call(`/rates/latest?symbols=${list()}`); return { rates: j.rates || {}, timestamp: j.timestamp }; }
  catch (e) {
    if (keys.length < 2) throw e;
    const rs = await Promise.allSettled(keys.map(k => call(`/rates/latest?symbols=${MAP[k].provider}`)));
    const rates = {}, fails = {}; let ts, ok = 0;
    rs.forEach((r, i) => { if (r.status === 'fulfilled') { Object.assign(rates, r.value.rates || {}); ts ||= r.value.timestamp; ok++; } else fails[keys[i]] = r.reason.message; });
    if (!ok) throw e; // everything failed (quota or key problem): don't blame individual symbols
    for (const [k, reason] of Object.entries(fails)) bad[k] = { reason, t: Date.now() };
    return { rates, timestamp: ts };
  }
}
const num = v => (typeof v === 'number' ? v : v && typeof v === 'object' ? (v.close ?? v.rate ?? v.value) : undefined);

// Previous close: walk back from yesterday (skips weekends/holidays) until the provider returns data.
async function previousCloses() {
  if (cache.prev && Date.now() - cache.prev.t < PREV_TTL) return cache.prev.v;
  for (let d = 1; d <= 5; d++) {
    const date = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
    try {
      const j = await call(`/rates/historical?symbols=${list()}&date=${date}`);
      const out = {};
      for (const [k, m] of Object.entries(MAP)) { const v = num(j.rates?.[m.provider]); if (v) out[k] = v; }
      if (Object.keys(out).length) { cache.prev = { t: Date.now(), v: out }; return out; }
    } catch { /* try an earlier day */ }
  }
  return {};
}

async function getCommodities() {
  if (cache.latest && Date.now() - cache.latest.t < TTL) return cache.latest.v;
  const j = await latestRates();
  const prev = await previousCloses();
  const ts = j.timestamp ? new Date(j.timestamp * 1000).toISOString() : new Date().toISOString();
  const items = [];
  for (const [k, m] of Object.entries(MAP)) {
    const p = num(j.rates?.[m.provider]);
    if (!p) continue; // never invent a price for a missing symbol
    (hist[k] ||= []).push(p); if (hist[k].length > 60) hist[k].shift();
    const pv = prev[k], ch = pv ? p - pv : 0, pc = pv ? (ch / pv) * 100 : 0;
    items.push({ s: k, n: m.n, e: m.e, p, ch, pc, hasChange: !!pv, pts: [...hist[k]], ts });
  }
  const v = { items, asOf: ts, skipped: Object.entries(bad).filter(([k]) => isBad(k)).map(([s, b]) => ({ s, reason: b.reason })) };
  cache.latest = { t: Date.now(), v };
  return v;
}
const lastGood = () => cache.latest?.v || null;

// ===== Server =====
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct rate limiting
const PORT = process.env.PORT || 3000;
// What your provider plan really delivers. Set to REALTIME only if the plan is real-time. Default is the safe option.
const PLAN_STATUS = ['REALTIME', 'DELAYED'].includes(process.env.COMMODITY_DATA_STATUS) ? process.env.COMMODITY_DATA_STATUS : 'DELAYED';

app.disable('x-powered-by');
app.use((_, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' }); next(); });
app.use('/api', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', (_, res) => res.json({ ok: true, keyConfigured: !!process.env.COMMODITY_API_KEY }));

// Commodities: fresh -> REALTIME/DELAYED; provider down but we have an old answer -> CACHED; nothing at all -> 503.
app.get('/api/commodities', async (_, res) => {
  try {
    const d = await getCommodities();
    return res.json({ source: 'CommodityPriceAPI', status: PLAN_STATUS, asOf: d.asOf, items: d.items, skipped: d.skipped });
  } catch (err) {
    console.error('commodities error:', err.message); // key is never logged
    const old = lastGood();
    if (old) return res.json({ source: 'CommodityPriceAPI', status: 'CACHED', asOf: old.asOf, items: old.items });
    return res.status(503).json({ error: 'Market data unavailable' });
  }
});

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/api', (_, res) => res.status(404).json({ error: 'Not found' }));
app.listen(PORT, () => console.log(`ATLAS running on http://localhost:${PORT}`));
