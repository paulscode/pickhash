'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const charts = require('../charts');

test('niceCeil rounds up to clean axis bounds', () => {
  assert.equal(charts.niceCeil(2900), 5000);
  assert.equal(charts.niceCeil(3300), 5000);
  assert.equal(charts.niceCeil(180), 200);
  assert.equal(charts.niceCeil(0), 1);
});

test('hashUnit auto-scales: PH/s at 3 PH, TH/s at 0.3 PH', () => {
  assert.equal(charts.hashUnit(3300).unit, 'PH/s');   // ~3 PH session
  assert.equal(charts.hashUnit(330).unit, 'TH/s');    // ~0.3 PH session
});

test('the time axis adapts to span (hours vs days vs weeks)', () => {
  assert.equal(charts.timeAxis(0, 6 * 3600).unit, 'h');
  assert.equal(charts.timeAxis(0, 5 * 86400).unit, 'd');
  assert.equal(charts.timeAxis(0, 30 * 86400).unit, 'w');
});

test('buildDelivered scales axes to a 3 PH/s session and emits a target line + area', () => {
  const ticks = [
    { ts: 1000, delivered_th: 0, target_th: 3000 },
    { ts: 2000, delivered_th: 1500, target_th: 3000 },
    { ts: 3000, delivered_th: 2950, target_th: 3000 },
  ];
  const m = charts.buildDelivered(ticks);
  assert.equal(m.y.unit, 'PH/s');
  assert.ok(m.y.max >= 3000, 'axis covers the target');
  assert.equal(m.series[0].points.length, 3);
  assert.ok(m.series[0].line.startsWith('M'));
  assert.ok(m.series[0].area.endsWith('Z'), 'area is a closed path');
  assert.equal(m.target.th, 3000);
  // Higher delivery -> lower y pixel (inverted axis).
  const p = m.series[0].points;
  assert.ok(p[2].y < p[1].y && p[1].y < p[0].y);
});

test('buildDelivered uses TH/s for a sub-PH (0.3 PH/s) session', () => {
  const m = charts.buildDelivered([{ ts: 1, delivered_th: 300, target_th: 300 }, { ts: 2, delivered_th: 290, target_th: 300 }]);
  assert.equal(m.y.unit, 'TH/s');
});

test('buildDeliveredStacked makes top-5 rig bands + an others band summing toward target', () => {
  const ticks = [{ ts: 100, target_th: 1000 }, { ts: 200, target_th: 1000 }, { ts: 300, target_th: 1000 }];
  // 7 rigs of ~150 TH each: top 5 individual, remaining 2 -> "others".
  const samples = [];
  for (let rid = 1; rid <= 7; rid += 1) {
    for (const ts of [100, 200, 300]) samples.push({ rental_id: rid, ts, delivered_th: 150 - rid * 5, rig_name: `Rig ${rid}` });
  }
  const m = charts.buildDeliveredStacked(samples, ticks, { targetTh: 1000 });
  assert.equal(m.bands.length, 6, '5 rigs + others');
  assert.equal(m.bands[5].label, 'others (2)');
  assert.ok(m.bands.every((b) => b.path.endsWith('Z')), 'each band is a closed area');
  assert.ok(m.bands[0].fill !== m.bands[1].fill, 'distinct shades');
  assert.equal(m.target.th, 1000);
  assert.ok(m.totalLine.startsWith('M'));
  // The total line top equals the stacked sum (~ Σ delivered) at the last tick.
  const sum = [1, 2, 3, 4, 5, 6, 7].reduce((s, rid) => s + (150 - rid * 5), 0);
  assert.ok(m.totalPoints[m.totalPoints.length - 1].vy === sum);
});

test('buildDeliveredStacked drops an ended rig band to 0 after its end_ts (no phantom hashrate)', () => {
  const ticks = [{ ts: 100, target_th: 400 }, { ts: 200, target_th: 400 }, { ts: 300, target_th: 400 }];
  const samples = [
    { rental_id: 1, ts: 100, delivered_th: 100, rig_name: 'A', end_ts: 150 },   // ends at 150
    { rental_id: 2, ts: 100, delivered_th: 100, rig_name: 'B', end_ts: 9999 },
    { rental_id: 2, ts: 300, delivered_th: 100, rig_name: 'B', end_ts: 9999 },
  ];
  const m = charts.buildDeliveredStacked(samples, ticks, { targetTh: 400 });
  // At the last tick (300 > A's end 150), only B contributes -> total 100, not 200.
  assert.equal(m.totalPoints[m.totalPoints.length - 1].vy, 100);
});

test('buildDeliveredStacked is empty-safe with no samples', () => {
  const m = charts.buildDeliveredStacked([], [{ ts: 1, target_th: 500 }], { targetTh: 500 });
  assert.equal(m.empty, true);
  assert.equal(m.bands.length, 0);
});

test('buildSpend draws cumulative spend under a budget ceiling', () => {
  const ticks = [{ ts: 1, spent_sats: 0 }, { ts: 2, spent_sats: 40000 }, { ts: 3, spent_sats: 95000 }];
  const m = charts.buildSpend(ticks, { budgetSats: 100000 });
  assert.equal(m.ceiling.sats, 100000);
  assert.ok(m.y.max >= 100000);
  assert.ok(m.series[0].area.endsWith('Z'));
});

test('buildMarket converts per-TH-day snapshots to sats per-PH-day and plots two series', () => {
  const snaps = [{ ts: 1, lowest: 0.0000005, last10: 0.0000007 }, { ts: 2, lowest: 0.0000006, last10: 0.0000007 }];
  const m = charts.buildMarket(snaps);
  assert.equal(m.series.length, 2);
  assert.equal(m.series[0].key, 'lowest');
  assert.equal(m.y.unit, 'sats/PH·day');
  // 0.0000005 BTC/TH·day -> 50,000 sats/PH·day; axis max covers the 70,000 peak.
  assert.ok(Math.abs(m.series[0].points[0].vy - 50000) < 1e-6, `lowest=${m.series[0].points[0].vy}`);
  assert.ok(m.y.max >= 70000);
  assert.match(m.yMaxLabel, /sats\/PH·day/);
});

test('builders do not crash on empty data', () => {
  assert.doesNotThrow(() => charts.buildDelivered([]));
  assert.doesNotThrow(() => charts.buildSpend([]));
  assert.doesNotThrow(() => charts.buildMarket([]));
});

// --- buildSpend ceiling behavior -------------------------------------------------

test('buildSpend emits NO ceiling line when called without a budget', () => {
  const m = charts.buildSpend([{ ts: 1, spent_sats: 0 }, { ts: 2, spent_sats: 30000 }]);
  assert.equal(m.ceiling, null, 'no budgetSats -> ceiling is null');
});

test('buildSpend emits a ceiling model (sats + horizontal path) with a real budget', () => {
  const m = charts.buildSpend([{ ts: 1, spent_sats: 0 }, { ts: 2, spent_sats: 40000 }], { budgetSats: 100000 });
  assert.equal(m.ceiling.sats, 100000);
  assert.ok(typeof m.ceiling.y === 'number' && Number.isFinite(m.ceiling.y));
  // The ceiling renders as one flat rule spanning the plot (M<left> L<right>).
  assert.match(m.ceiling.path, /^M8,[\d.]+ L792,[\d.]+$/);
});

test('buildSpend over budget: yMax still covers the spend and the ceiling value is not clamped', () => {
  // spend (95000) exceeds the budget ceiling (50000).
  const m = charts.buildSpend([{ ts: 1, spent_sats: 0 }, { ts: 2, spent_sats: 95000 }], { budgetSats: 50000 });
  assert.ok(m.y.max >= 95000, `axis (${m.y.max}) covers the over-budget spend`);
  assert.equal(m.ceiling.sats, 50000, 'ceiling keeps its real value, not clamped to yMax');
  // The spend line's peak sits ABOVE the ceiling rule (smaller y pixel = higher up).
  const peakY = Math.min(...m.series[0].points.map((p) => p.y));
  assert.ok(peakY < m.ceiling.y, 'the over-budget spend is drawn above the ceiling line');
});

// --- buildDeliveredStacked shape / fallback / forward-fill -----------------------

test('buildDeliveredStacked with only 2 rigs returns exactly 2 bands (variable count, no others, not padded to 6)', () => {
  const ticks = [{ ts: 100, target_th: 400 }, { ts: 200, target_th: 400 }, { ts: 300, target_th: 400 }];
  const samples = [];
  for (const rid of [1, 2]) {
    for (const ts of [100, 200, 300]) samples.push({ rental_id: rid, ts, delivered_th: 100, rig_name: `Rig ${rid}` });
  }
  const m = charts.buildDeliveredStacked(samples, ticks, { targetTh: 400 });
  assert.equal(m.bands.length, 2, 'one band per rig; not padded to 6');
  assert.ok(!m.bands.some((b) => /^others/.test(b.label)), 'no others band with <5 rigs');
  assert.ok(m.bands.every((b) => b.path.endsWith('Z')), 'each band is a closed area');
});

test('buildDeliveredStacked returns the empty model (not an aggregate area) when no sample matches a rental', () => {
  // Ticks present (a master timeline exists) but every sample lacks a usable rental_id,
  // so byRental is empty -> the code takes the empty() fallback.
  const ticks = [{ ts: 1, target_th: 500 }, { ts: 2, target_th: 500 }];
  const m = charts.buildDeliveredStacked([{ rental_id: null, ts: 1, delivered_th: 300 }], ticks, { targetTh: 500 });
  assert.equal(m.empty, true);
  assert.equal(m.bands.length, 0);
  assert.equal(m.totalLine, '', 'no aggregate line is drawn in the fallback');
  assert.deepEqual(m.totalPoints, []);
});

test('buildDeliveredStacked forward-fills: a value is HELD at an intermediate tick with no sample', () => {
  const ticks = [{ ts: 100, target_th: 500 }, { ts: 200, target_th: 500 }, { ts: 300, target_th: 500 }];
  // One rental with samples at ts=100 and ts=300 only (none at 200).
  const samples = [
    { rental_id: 1, ts: 100, delivered_th: 100, rig_name: 'A' },
    { rental_id: 1, ts: 300, delivered_th: 200, rig_name: 'A' },
  ];
  const m = charts.buildDeliveredStacked(samples, ticks, { targetTh: 500 });
  // At tick 200 the last known value (100) is held, not interpolated or dropped.
  assert.equal(m.totalPoints[1].vx, 200);
  assert.equal(m.totalPoints[1].vy, 100, 'held at the intermediate tick');
  assert.equal(m.totalPoints[2].vy, 200, 'jumps to the new sample at ts=300');
});

// --- buildMarket edge cases + unit conversion ------------------------------------

test('buildMarket handles a single snapshot without NaN and with a covering axis', () => {
  const m = charts.buildMarket([{ ts: 1000, lowest: 0.0000005, last10: 0.0000006 }]);
  assert.equal(m.series[0].points.length, 1);
  assert.equal(m.series[1].points.length, 1);
  assert.ok(Number.isFinite(m.series[0].points[0].x) && Number.isFinite(m.series[0].points[0].y));
  assert.ok(!Number.isNaN(m.y.max) && m.y.max >= 60000, 'axis covers the 60,000 sats/PH·day point');
});

test('buildMarket on an empty series returns a well-formed shape (both series present, empty points)', () => {
  const m = charts.buildMarket([]);
  assert.equal(m.series.length, 2);
  assert.equal(m.series[0].key, 'lowest');
  assert.equal(m.series[1].key, 'last10');
  assert.deepEqual(m.series[0].points, []);
  assert.deepEqual(m.series[1].points, []);
  assert.ok(Number.isFinite(m.y.max) && m.y.max >= 1);
});

test('buildMarket drops a null lowest point but still plots last10 from the same snapshot', () => {
  const m = charts.buildMarket([{ ts: 1, lowest: null, last10: 0.0000007 }]);
  assert.equal(m.series[0].points.length, 0, 'lowest:null contributes no point');
  assert.equal(m.series[1].points.length, 1, 'last10 is still plotted');
  assert.ok(Math.abs(m.series[1].points[0].vy - 70000) < 1e-6);
});

test('buildMarket unit conversion is exactly x1e11 (per-TH·day BTC -> sats/PH·day)', () => {
  const m = charts.buildMarket([{ ts: 1, lowest: 1e-6, last10: 2e-6 }]);
  assert.equal(m.series[0].points[0].vy, 1e-6 * 1e11);   // 100,000
  assert.equal(m.series[1].points[0].vy, 2e-6 * 1e11);   // 200,000
});

// --- gridPath invariant (no per-line x-for inside SVG) ---------------------------

test('gridlines are ONE path string with multiple M/L segments (protects the Alpine-CSP SVG invariant)', () => {
  const m = charts.buildDelivered([{ ts: 1, delivered_th: 100, target_th: 300 }, { ts: 2, delivered_th: 200, target_th: 300 }]);
  assert.equal(typeof m.gridPath, 'string', 'gridPath is a single string, not a per-line array');
  assert.ok(!Array.isArray(m.gridPath));
  assert.ok((m.gridPath.match(/M/g) || []).length > 1, 'multiple horizontal segments in the one string');
  assert.ok((m.gridPath.match(/L/g) || []).length > 1);
  // Same single-string contract holds for spend and market charts.
  assert.equal(typeof charts.buildSpend([{ ts: 1, spent_sats: 10 }]).gridPath, 'string');
  assert.equal(typeof charts.buildMarket([{ ts: 1, lowest: 1e-6 }]).gridPath, 'string');
});

test('buildDepth builds a cumulative TH-by-price step curve (and an empty model for no depth)', () => {
  const empty = charts.buildDepth([]);
  assert.equal(empty.empty, true);
  assert.equal(empty.total_th, 0);

  // 100 TH @ 1e-6 BTC/TH·day, 200 TH @ 2e-6 -> cumulative 100 then 300; prices in sats/PH·day = x1e11.
  const m = charts.buildDepth([{ priceBtcThDay: 2e-6, th: 200 }, { priceBtcThDay: 1e-6, th: 100 }]);
  assert.equal(m.empty, false);
  assert.equal(m.total_th, 300, 'cumulative available TH');
  assert.equal(m.hash_unit, 'TH/s', '<1000 TH -> TH/s axis');
  assert.equal(m.price_unit, 'sats/PH·day');
  // The curve steps up to the full 300 at the top price; last point's value is the total.
  assert.equal(m.points[m.points.length - 1].vy, 300);
  assert.ok(m.line.startsWith('M'), 'an SVG path was produced');
});

test('buildMarket overlays a pay-rate reference line + per-series current values', () => {
  const snaps = [{ ts: 100, lowest: 4e-7, last10: 5e-7 }, { ts: 200, lowest: 4.2e-7, last10: 5.1e-7 }];
  const m = charts.buildMarket(snaps, { payRate: 52000 });
  assert.ok(m.pay_line.startsWith('M'), 'pay reference line drawn');
  assert.equal(m.pay_value, 52000);
  assert.equal(m.series[0].current, 42000, 'lowest current = latest value in sats/PH·day');
  assert.equal(m.series[1].current, 51000, 'last10 current');
  assert.equal(charts.buildMarket(snaps).pay_line, '', 'no payRate -> no overlay');
});

test('buildMarket with a payRate but no snapshots stays well-formed (no throw, null currents)', () => {
  const m = charts.buildMarket([], { payRate: 52000 });
  assert.ok(m.pay_line.startsWith('M'), 'pay line still drawn against a payRate-derived axis');
  assert.equal(m.pay_value, 52000, 'pay_value reported for the legend');
  assert.equal(m.series.length, 2, 'both series present');
  assert.equal(m.series[0].current, null, 'no data -> no current value');
  assert.equal(m.series[1].current, null);
});
