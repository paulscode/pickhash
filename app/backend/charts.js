'use strict';
/*
 * Chart models (pure). buildChartModel-style builders that turn tick_metrics / market
 * snapshots into SVG-ready geometry: pixel paths, auto-scaled axes with nice ticks, and
 * the raw data points for the crosshair/tooltip. The frontend renders these with the
 * gradients/glow/animation; keeping the geometry here makes it unit-testable
 * and the visuals swappable.
 *
 * Axes AUTO-SCALE to the user's actual purchase: hashrate axis is PH/s once we're at/above
 * ~1 PH, TH/s below (a 3 PH/s and a 0.3 PH/s session both read naturally); the time axis
 * adapts to session length (hours for short rentals, days/weeks for the common case).
 */

const VIEW = { w: 800, h: 240, padL: 8, padR: 8, padT: 12, padB: 20 };

function scale(domainMin, domainMax, rangeMin, rangeMax) {
  const d = domainMax - domainMin || 1;
  return (v) => rangeMin + ((v - domainMin) / d) * (rangeMax - rangeMin);
}

/** Round a max up to a "nice" axis bound (1/2/2.5/5 × 10^n). */
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const f = v / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * base;
}

/** Choose a hashrate display unit from the peak TH. PH/s at/above ~1 PH, else TH/s. */
function hashUnit(maxTh) {
  return maxTh >= 1000 ? { unit: 'PH/s', div: 1000, dp: 2 } : { unit: 'TH/s', div: 1, dp: 0 };
}

/** Time-axis ticks + a range label that adapts to the span (hours/days/weeks). */
function timeAxis(minTs, maxTs, n = 5) {
  const span = Math.max(1, maxTs - minTs);
  const hours = span / 3600;
  let unit;
  let div;
  let suffix;
  if (hours <= 48) { unit = 'h'; div = 3600; suffix = 'h'; }
  else if (hours <= 24 * 21) { unit = 'd'; div = 86400; suffix = 'd'; }
  else { unit = 'w'; div = 604800; suffix = 'w'; }
  const ticks = [];
  for (let i = 0; i <= n; i++) {
    const ts = minTs + (span * i) / n;
    const rel = (ts - minTs) / div;
    ticks.push({ ts, label: `${Math.round(rel * 10) / 10}${suffix}` });
  }
  return { ticks, unit, span };
}

/** Even y-axis ticks with unit-aware labels. */
function yTicks(yMax, unitDiv, dp, n = 4) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const v = (yMax * i) / n;
    out.push({ v, label: (v / unitDiv).toFixed(dp) });
  }
  return out;
}

function path(points) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

// All horizontal gridlines as ONE path string — so the SVG needs no per-tick x-for
// (Alpine's <template x-for> does not work inside <svg>).
function gridPath(view, yTicksPx) {
  return yTicksPx.map((t) => `M${view.padL},${t.y.toFixed(1)} L${(view.w - view.padR).toFixed(1)},${t.y.toFixed(1)}`).join(' ');
}

/**
 * Delivered hashrate (TH) over time vs the target line. `ticks` = tick_metrics rows
 * ({ ts, delivered_th, target_th }).
 */
function buildDelivered(ticks, opts = {}) {
  const view = { ...VIEW, ...opts.view };
  const rows = (ticks || []).filter((r) => r.ts != null).sort((a, b) => a.ts - b.ts);
  const target = opts.targetTh != null ? opts.targetTh : (rows.length ? rows[rows.length - 1].target_th : 0);
  const peak = Math.max(target || 0, ...rows.map((r) => r.delivered_th || 0), 1);
  const yMax = niceCeil(peak * 1.1);
  const { unit, div, dp } = hashUnit(yMax);
  const minTs = rows.length ? rows[0].ts : 0;
  const maxTs = rows.length ? rows[rows.length - 1].ts : 1;

  const sx = scale(minTs, maxTs, view.padL, view.w - view.padR);
  const sy = scale(0, yMax, view.h - view.padB, view.padT);
  const points = rows.map((r) => ({ x: sx(r.ts), y: sy(r.delivered_th || 0), vx: r.ts, vy: r.delivered_th || 0 }));
  const line = path(points);
  const baseY = sy(0);
  const area = points.length
    ? `${line} L${points[points.length - 1].x.toFixed(1)},${baseY.toFixed(1)} L${points[0].x.toFixed(1)},${baseY.toFixed(1)} Z`
    : '';
  const ty = sy(target);

  return {
    view,
    kind: 'delivered',
    y: { max: yMax, unit, ticks: yTicks(yMax, div, dp).map((t) => ({ ...t, y: sy(t.v) })) },
    x: timeAxis(minTs, maxTs).ticks.map((t) => ({ ...t, x: sx(t.ts) })),
    gridPath: gridPath(view, yTicks(yMax, div, dp).map((t) => ({ y: sy(t.v) }))),
    yMaxLabel: `${(yMax / div).toFixed(dp)} ${unit}`,
    series: [{ key: 'delivered', line, area, points }],
    target: { th: target, y: ty, path: `M${view.padL},${ty.toFixed(1)} L${(view.w - view.padR)},${ty.toFixed(1)}` },
  };
}

// Ember→flame shades for the stacked bands (bottom→top); last is "others".
const BAND_SHADES = ['#ff6a00', '#ff8a2a', '#ffa54a', '#ffbe6b', '#ffd08c', '#5b6b93'];

/**
 * Forward-fill a rental's (ts, th) samples onto a master timeline: hold the last value
 * between sparse samples (delivery is ~constant between measurements), but drop to 0 once
 * the rental has ended (past endTs) so an ended rig doesn't leave a phantom flat band.
 */
function forwardFill(arr, masterTs, endTs) {
  const out = [];
  let j = 0;
  let cur = 0;
  for (const ts of masterTs) {
    while (j < arr.length && arr[j].ts <= ts) { cur = arr[j].th; j += 1; }
    out.push(endTs != null && ts > endTs ? 0 : cur);
  }
  return out;
}

/**
 * Stacked per-rental delivered hashrate: the top-5 contributing rigs as individual ember
 * bands plus an aggregated "others" band, summing toward the target line. `samples` =
 * rental_samples rows ({ rental_id, ts, delivered_th, rig_name }); `ticks` = tick_metrics
 * rows (the master timeline). Fixed 6 bands so the SVG needs no per-series x-for.
 */
function buildDeliveredStacked(samples, ticks, opts = {}) {
  const view = { ...VIEW, ...opts.view };
  const tickRows = (ticks || []).filter((r) => r.ts != null).sort((a, b) => a.ts - b.ts);
  const target = opts.targetTh != null ? opts.targetTh : (tickRows.length ? tickRows[tickRows.length - 1].target_th : 0);
  const masterTs = tickRows.map((r) => r.ts);

  const empty = () => {
    const yMax = niceCeil((target || 1) * 1.1);
    const { unit, div, dp } = hashUnit(yMax);
    return { view, kind: 'delivered_stacked', bands: [], totalLine: '', totalPoints: [], target: { th: target, y: 0, path: '' },
      y: { max: yMax, unit }, x: [], gridPath: '', yMaxLabel: `${(yMax / div).toFixed(dp)} ${unit}`, empty: true };
  };
  if (!masterTs.length) return empty();

  // Group + forward-fill per rental onto the master timeline.
  const byRental = new Map();
  for (const s of samples || []) {
    if (s.rental_id == null || s.ts == null) continue;
    if (!byRental.has(s.rental_id)) {
      byRental.set(s.rental_id, { name: s.rig_name || `rig ${s.rental_id}`, endTs: s.end_ts != null ? Number(s.end_ts) : null, pts: [] });
    }
    byRental.get(s.rental_id).pts.push({ ts: s.ts, th: s.delivered_th || 0 });
  }
  if (!byRental.size) return empty();

  const rentals = [];
  for (const [rid, { name, endTs, pts }] of byRental) {
    pts.sort((a, b) => a.ts - b.ts);
    const filled = forwardFill(pts, masterTs, endTs);
    rentals.push({ rid, name, filled, total: filled.reduce((a, b) => a + b, 0) });
  }
  rentals.sort((a, b) => b.total - a.total);
  const series = rentals.slice(0, 5).map((r) => ({ name: r.name, filled: r.filled }));
  const rest = rentals.slice(5);
  if (rest.length) {
    series.push({ name: `others (${rest.length})`, filled: masterTs.map((_, i) => rest.reduce((s, r) => s + r.filled[i], 0)) });
  }

  const totals = masterTs.map((_, i) => series.reduce((s, ser) => s + ser.filled[i], 0));
  const yMax = niceCeil(Math.max(target || 0, ...totals, 1) * 1.1);
  const { unit, div, dp } = hashUnit(yMax);
  const minTs = masterTs[0];
  const maxTs = masterTs[masterTs.length - 1];
  const sx = scale(minTs, maxTs, view.padL, view.w - view.padR);
  const sy = scale(0, yMax, view.h - view.padB, view.padT);

  const lower = masterTs.map(() => 0);
  const bands = series.map((ser, idx) => {
    const upper = masterTs.map((_, i) => lower[i] + ser.filled[i]);
    const topPts = masterTs.map((ts, i) => ({ x: sx(ts), y: sy(upper[i]) }));
    const botRev = masterTs.map((ts, i) => ({ x: sx(ts), y: sy(lower[i]) })).reverse();
    const d = `${path(topPts)} ${botRev.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} Z`;
    for (let i = 0; i < lower.length; i += 1) lower[i] = upper[i];
    return { key: `b${idx}`, label: ser.name, fill: BAND_SHADES[idx] || BAND_SHADES[5], path: d };
  });

  const totalPoints = masterTs.map((ts, i) => ({ x: sx(ts), y: sy(lower[i]), vx: ts, vy: lower[i] }));
  const ty = sy(target);
  return {
    view,
    kind: 'delivered_stacked',
    bands,
    totalLine: path(totalPoints),
    totalPoints,
    y: { max: yMax, unit, ticks: yTicks(yMax, div, dp).map((t) => ({ ...t, y: sy(t.v) })) },
    x: timeAxis(minTs, maxTs).ticks.map((t) => ({ ...t, x: sx(t.ts) })),
    gridPath: gridPath(view, yTicks(yMax, div, dp).map((t) => ({ y: sy(t.v) }))),
    yMaxLabel: `${(yMax / div).toFixed(dp)} ${unit}`,
    target: { th: target, y: ty, path: `M${view.padL},${ty.toFixed(1)} L${(view.w - view.padR)},${ty.toFixed(1)}` },
  };
}

/** Cumulative spend (sats) over time vs the budget ceiling. */
function buildSpend(ticks, opts = {}) {
  const view = { ...VIEW, ...opts.view };
  const rows = (ticks || []).filter((r) => r.ts != null).sort((a, b) => a.ts - b.ts);
  const ceiling = opts.budgetSats != null ? opts.budgetSats : null;   // no budget -> no ceiling line
  const peak = Math.max(ceiling || 0, ...rows.map((r) => r.spent_sats || 0), 1);
  const yMax = niceCeil(peak * 1.1);
  const minTs = rows.length ? rows[0].ts : 0;
  const maxTs = rows.length ? rows[rows.length - 1].ts : 1;
  const sx = scale(minTs, maxTs, view.padL, view.w - view.padR);
  const sy = scale(0, yMax, view.h - view.padB, view.padT);
  const points = rows.map((r) => ({ x: sx(r.ts), y: sy(r.spent_sats || 0), vx: r.ts, vy: r.spent_sats || 0 }));
  const line = path(points);
  const baseY = sy(0);
  const area = points.length
    ? `${line} L${points[points.length - 1].x.toFixed(1)},${baseY.toFixed(1)} L${points[0].x.toFixed(1)},${baseY.toFixed(1)} Z`
    : '';
  return {
    view,
    kind: 'spend',
    y: { max: yMax, unit: 'sats', ticks: yTicks(yMax, 1, 0).map((t) => ({ ...t, y: sy(t.v) })) },
    x: timeAxis(minTs, maxTs).ticks.map((t) => ({ ...t, x: sx(t.ts) })),
    gridPath: gridPath(view, yTicks(yMax, 1, 0).map((t) => ({ y: sy(t.v) }))),
    yMaxLabel: `${Math.round(yMax).toLocaleString('en-US')} sats`,
    series: [{ key: 'spend', line, area, points }],
    ceiling: ceiling != null ? { sats: ceiling, y: sy(ceiling), path: `M${view.padL},${sy(ceiling).toFixed(1)} L${(view.w - view.padR)},${sy(ceiling).toFixed(1)}` } : null,
  };
}

// Snapshots store BTC per-TH·day; the UI shows sats per-PH·day (readable at this scale,
// consistent with the rest of the dashboard): ×1000 TH/PH ×1e8 sats/BTC = ×1e11.
const SATS_PH_DAY = 1e11;

/** Market price trend: cheapest + last-10 average (sats per PH·day) over time. */
function buildMarket(snapshots, opts = {}) {
  const view = { ...VIEW, ...opts.view };
  const rows = (snapshots || []).filter((r) => r.ts != null).sort((a, b) => a.ts - b.ts);
  // Overlay YOUR pay-rate (sats/PH·day) as a flat reference line, so over/under-market reads visually.
  const payRate = opts.payRate != null && opts.payRate > 0 ? opts.payRate : null;
  const vals = rows.flatMap((r) => [r.lowest, r.last10].filter((v) => v != null)).map((v) => v * SATS_PH_DAY);
  if (payRate != null) vals.push(payRate);
  const yMax = niceCeil(Math.max(1, ...vals));
  const minTs = rows.length ? rows[0].ts : 0;
  const maxTs = rows.length ? rows[rows.length - 1].ts : 1;
  const sx = scale(minTs, maxTs, view.padL, view.w - view.padR);
  const sy = scale(0, yMax, view.h - view.padB, view.padT);
  const seriesFor = (field) => {
    const pts = rows.filter((r) => r[field] != null).map((r) => ({ x: sx(r.ts), y: sy(r[field] * SATS_PH_DAY), vx: r.ts, vy: r[field] * SATS_PH_DAY }));
    return { key: field, line: path(pts), points: pts, current: pts.length ? Math.round(pts[pts.length - 1].vy) : null };
  };
  const payY = payRate != null ? sy(payRate) : null;
  return {
    view,
    kind: 'market',
    y: { max: yMax, unit: 'sats/PH·day', ticks: yTicks(yMax, 1, 0).map((t) => ({ ...t, y: sy(t.v) })) },
    x: timeAxis(minTs, maxTs).ticks.map((t) => ({ ...t, x: sx(t.ts) })),
    gridPath: gridPath(view, yTicks(yMax, 1, 0).map((t) => ({ y: sy(t.v) }))),
    yMaxLabel: `${Math.round(yMax).toLocaleString('en-US')} sats/PH·day`,
    pay_line: payY != null ? `M${view.padL},${payY.toFixed(1)} L${(view.w - view.padR).toFixed(1)},${payY.toFixed(1)}` : '',
    pay_value: payRate != null ? Math.round(payRate) : null,
    series: [seriesFor('lowest'), seriesFor('last10')],
  };
}

/**
 * Market depth: cumulative available TH by price (an ascending step curve — "at or below price X
 * you can buy Y TH"). `depth` = a snapshot's [{priceBtcThDay, th}] array. Pure -> SVG geometry.
 */
function buildDepth(depth, opts = {}) {
  const view = { ...VIEW, ...opts.view };
  const rows = (depth || []).filter((d) => d && Number.isFinite(d.priceBtcThDay) && d.th > 0).sort((a, b) => a.priceBtcThDay - b.priceBtcThDay);
  if (!rows.length) return { view, kind: 'depth', empty: true, line: '', points: [], gridPath: '', x: [], y: { max: 1, unit: 'TH/s', ticks: [] }, total_th: 0, price_unit: 'sats/PH·day', hash_unit: 'TH/s' };
  let cum = 0;
  const cumPts = rows.map((d) => { cum += d.th; return { price: d.priceBtcThDay * SATS_PH_DAY, cumTh: cum }; });
  const totalTh = cum;
  const xMax = niceCeil(cumPts[cumPts.length - 1].price);
  const u = hashUnit(totalTh);
  const yMax = niceCeil(totalTh / u.div) * u.div;
  const sx = scale(0, xMax, view.padL, view.w - view.padR);
  const sy = scale(0, yMax, view.h - view.padB, view.padT);
  // Step curve from (0,0): horizontal to each price, then up by that price's TH.
  const pts = [{ x: sx(0), y: sy(0), vx: 0, vy: 0 }];
  let prev = 0;
  for (const p of cumPts) {
    pts.push({ x: sx(p.price), y: sy(prev), vx: p.price, vy: prev });
    pts.push({ x: sx(p.price), y: sy(p.cumTh), vx: p.price, vy: p.cumTh });
    prev = p.cumTh;
  }
  const yTk = yTicks(yMax, u.div, u.dp);
  const xTk = [];
  for (let i = 0; i <= 4; i++) { const v = (xMax * i) / 4; xTk.push({ v, x: sx(v), label: Math.round(v).toLocaleString('en-US') }); }
  return {
    view, kind: 'depth', empty: false,
    total_th: totalTh, price_unit: 'sats/PH·day', hash_unit: u.unit,
    x: xTk,
    y: { max: yMax, unit: u.unit, ticks: yTk.map((t) => ({ ...t, y: sy(t.v) })) },
    gridPath: gridPath(view, yTk.map((t) => ({ y: sy(t.v) }))),
    line: path(pts), points: pts,
  };
}

module.exports = { buildDelivered, buildDeliveredStacked, buildSpend, buildMarket, buildDepth, niceCeil, hashUnit, timeAxis, VIEW };
