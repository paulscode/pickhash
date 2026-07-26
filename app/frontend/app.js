'use strict';
/*
 * Dashboard front-end.
 *
 * We ship the Content-Security-Policy build of Alpine, which evaluates directives
 * with a restricted parser (no eval). So all logic lives here in the registered
 * component and the HTML templates reference only plain data properties, method
 * calls, x-model, and x-text — never inline expressions with operators.
 */

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    // Views (bare booleans so templates never need operators).
    onStyleguide: false,
    showApp: false,
    showWizard: false,
    showLogin: false,
    loginPassword: '',

    // Wizard step visibility (0=password, 1=keys, 2=pool, 3=fund).
    s0: false, s1: false, s2: false, s3: false,
    stepLabel: '',

    // Auth.
    passwordEnabled: false, pwManaged: false, pwManagedHint: '',
    csrf: null,

    // Form fields.
    password: '',
    mrrKey: '', mrrSecret: '',
    poolHost: '', poolPort: '', poolUser: '',

    // Status / results.
    busy: false,
    error: '',
    keyPermsText: '',
    withdrawWarn: false,
    poolReport: null,
    poolReportText: '',
    poolWarning: '',
    poolOk: false,
    poolFailed: false,
    bareIp: false,            // tested setup endpoint is a raw IP -> offer DuckDNS
    // DuckDNS (give a raw-IP endpoint a stable name; shared by setup Step 2 + Settings endpoint card)
    duckdnsWant: true, duckdnsSub: '', duckdnsToken: '', duckdnsBusy: false,
    duckdnsReport: '', duckdnsReportClass: '', duckdnsEnabled: false, duckdnsName: '', seIsIp: false,
    depositAddr: '',
    depositConfirmed: 0,

    // --- Quote card ---
    unit: 'ph',                 // hashrate display unit: 'ph' | 'th'
    compute: 'duration',        // which field is solved for: 'spend' | 'hashrate' | 'duration'
    isSpendOut: false, isHashOut: false, isDurationOut: true,
    notSpendOut: true, notHashOut: true, notDurationOut: false,
    inSpend: '1000000',         // sats (empty-state default: 1M sats / 3 PH/s ≈ ~1 week)
    inHash: '3',                // in the current unit
    inDays: '7',                // days
    quote: null,                // latest server quote
    quoting: false,
    quoteError: '',
    breakdownOpen: false,
    _quoteTimer: null,
    _refreshTimer: null,

    // Derived display (plain props so CSP templates bind bare refs, not expressions).
    unitLabelText: 'PH/s',
    qHasQuote: false,
    qHeadline: '', qFeeLine: '', qPoolLine: '', qBalance: '', qTotal: '—',
    qDurationOut: '—', qHashOut: '—', qSpendOut: '—',
    qInsufficient: false, qShortfall: false, qShortfallText: '', qCapped: false,
    qMaxCapped: false, qMaxCappedText: '', qExceedsGuard: false, qDiffEdge: false,
    qCanRent: false, qCannotRent: true, qTight: false, qRigs: [],
    // Inline cues on a COMPUTED field when its value is clamped and more input won't move it:
    //  - Duration: pinned to the rigs' max rental length (more spend can't buy more time).
    //  - Hashrate: bought the whole eligible market at this duration (more spend can't add TH).
    // Each points the eye at the field's (i) for the reason.
    durComputedPlain: true, durComputedCapped: false, durBoxClass: 'bg-navy-800/50 border-navy-600',
    hashComputedPlain: false, hashComputedCapped: false, hashBoxClass: 'bg-navy-800/50 border-navy-600',
    qMarketCapped: false, qMarketCappedText: '', qBudgetTooLow: false, qInfeasibleDuration: false,
    // Active/inactive class strings for the segmented controls (CSP-safe :class binding).
    lockSpendClass: '', lockHashClass: '', lockDurClass: '',
    unitPhClass: '', unitThClass: '',

    // Quick vs Autopilot mode (of the Rent Hashrate card). Autopilot is the default.
    rentMode: 'autopilot', modeQuick: false, modeAutopilot: true,
    mqClass: 'text-gray-500 hover:text-white', maClass: 'bg-neon-ember/15 text-neon-ember',
    apTarget: '3', apDays: '7', apBudget: '1000000',
    apBusy: false, apBusyText: '', apMaxBusy: false, apError: '', apHasEstimate: false, apShortfall: false,
    apRigsText: '', apRateText: '', apBurnText: '', apRunwayText: '', apShortfallText: '', apSpendText: '', apRateCeil: '', apRateCeilTouched: false, apRateCeilAuto: true,
    apStarted: false, apStartedText: '',
    // Settings > Connection cards (API credentials + stratum endpoint).
    skKey: '', skSecret: '', skBusy: false, skReport: '', skReportClass: '', skUser: '',
    seHost: '', sePort: '', seWorker: '', seBusy: false, seReport: '', seReportClass: '', seWarning: '',
    seHashggAvail: false, seCurrent: '',

    // Review modal + session result.
    showReview: false, reviewBusy: false, reviewError: '',
    showMsgModal: false, msgRentalId: null, msgRigName: '', msgThread: [], msgThreadEmpty: false, msgInput: '', msgError: '', msgBusy: false,
    reviewBadge: 'DRY-RUN', reviewBadgeClass: '', sessionMode: 'dry-run',
    reconfirm: false, reconfirmText: '',
    showRehearsal: false, rehearsalBanner: '', rehearsalRows: [],
    hasSession: false, sessionSummary: '', rentals: [], hasRentals: false, emptyRentalsNote: '', stopNote: '',
    sessionState: '', sessionWinding: false, stopConfirm: false, stopBusy: false, stopBtnShow: true,
    // Run-mode switch (DRY-RUN <-> LIVE).
    modeIsLive: false, showModeModal: false, modeBusy: false, modeError: '', modeTyped: '', modeNeedsTyped: false,

    // --- Dashboard hero + charts + alerts ---
    chartRange: 'all', hasMetrics: false,
    cls6h: '', cls24h: '', cls7d: '', clsAll: '',
    // hero tiles
    heroActive: false, heroDelivered: '0.00', heroUnit: 'PH/s', heroTarget: '',
    heroPct: '0%', heroPctClass: '', heroSpent: '', heroBudget: '', heroChip: 'DRY-RUN', heroChipClass: '',
    // delivered chart (flattened server model -> bare props; NO x-for inside <svg>)
    dLine: '', dArea: '', dTargetPath: '', dTargetLabel: '', dGridPath: '', dYMaxLabel: '', dXLabels: [], dUnit: '', dPoints: [],
    // stacked per-rental bands (top-5 + others) — fixed 6 slots so the SVG needs no x-for
    hasBands: false, showSingleArea: true, deliveredLegend: [],
    band0: '', band1: '', band2: '', band3: '', band4: '', band5: '',
    fill0: 'transparent', fill1: 'transparent', fill2: 'transparent', fill3: 'transparent', fill4: 'transparent', fill5: 'transparent',
    // spend chart
    sLine: '', sArea: '', sCeilPath: '', sCeilLabel: '', sGridPath: '', sYMaxLabel: '', sXLabels: [],
    // market chart
    mLowest: '', mLast10: '', mGridPath: '', mYMaxLabel: '', mXLabels: [], mUnit: '', mHasData: false,
    mPayLine: '', mCheapVal: '—', mLast10Val: '—', mPayShow: false, mPayVal: '—', mPayLabel: 'you',
    // Hash Value comparison (your pay-rate vs market rate)
    hvAvail: false, hvShowHint: false, hvBadge: '', hvBadgeClass: 'text-gray-500 border-navy-600', hvPay: '—', hvMarket: '—', hvEff: '—',
    phPayLine: '', phCheapVal: '—', phLast10Val: '—', phPayShow: false, phPayVal: '—', phPayLabel: 'you',
    // crosshair
    crossShow: false, crossX: 0, tipX: 0, tipTextX: 0, tipText: '',
    // alerts strip
    alertsList: [], hasAlerts: false,
    // history view
    showHistory: false, historySessions: [], historyEmpty: false, appReady: false,
    showSettings: false, settingsGroups: [], diagText: { mrr: '', mode: '', tick: '', hashgg: '', fallback: '' },
    fallbackOcean: true,
    rerouteDeadRigs: true,   // sub-option of the Ocean fallback (surfaced beside it, not in the generic list)
    showMarket: false, marketEmpty: false, hasMarket: false, mktSummary: '', cheapText: '', cheapSub: '', cheapClass: '', marketRegions: [], regionsEmpty: false,
    impactHasData: false, impactTotal: '0 PH·days', impactLine: '', impactArea: '', impactGridPath: '', impactXLabels: [], impactYMaxLabel: '', impactPoints: [],
    impCrossShow: false, impCrossX: 0, impTipX: 0, impTipTextX: 0, impTipText: '',
    phLowest: '', phLast10: '', phGridPath: '', phYMaxLabel: '', phXLabels: [], phHasData: false,
    navDashClass: 'tab-active pb-1', navHistClass: 'hover:text-white pb-1', navSetClass: 'hover:text-white pb-1', navMktClass: 'hover:text-white pb-1',

    // Balance + deposit + info popovers.
    balanceBig: '—', hasUnconfirmed: false, balanceUnconfText: '',
    showDeposit: false, depositAddr2: '',
    // Inline info tips: one open at a time. Bare booleans + a bare text prop so the CSP
    // templates bind plain refs (x-show="tipSpend", x-text="infoTipText"), never expressions.
    infoOpen: '', infoTipText: '',
    tipSpend: false, tipHashrate: false, tipDuration: false, tipLock: false,
    tipBlended: false, tipMarket: false, tipBalance: false,
    qHasBlocking: false, qHasNotes: false,

    // Plain-language explainers for the (i) icons.
    INFO: {
      spend: 'How many sats you want to spend — the 3% MiningRigRentals fee is already included. Pickhash packs the cheapest reliable rigs to fit.',
      hashrate: 'The total mining power to rent, in PH/s (1 PH/s = 1,000 TH/s). Use the PH/s ⇄ TH/s toggle for sub-PH amounts.',
      duration: 'How long the rented rigs run. MRR rentals are a fixed length and paid up front — this is the actual length Pickhash will buy.',
      lock: 'Choose which field to solve for. Fill the other two and Pickhash computes this one from the live order book.',
      blended: 'The average price across the packed rigs, in sats per PH per day — what you are effectively paying for hashrate.',
      market: 'How your blended price compares to the last 10 rentals on the market — a quick read on whether hashrate is cheap right now.',
      balance: 'Your confirmed MiningRigRentals balance — what you can spend now. Deposits need 3 confirmations before they clear.',
    },

    async init() {
      this.onStyleguide = window.location.pathname === '/styleguide';
      if (!this.onStyleguide) await this.refresh();
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },

    async refresh() {
      this.showLogin = false; this.showWizard = false; this.showApp = false; this.showHistory = false; this.showSettings = false; this.showMarket = false; this.appReady = false;
      const auth = await this.getJson('/api/auth/state');
      this.passwordEnabled = !!auth.password_enabled;
      this.pwManaged = !!auth.managed;
      this.pwManagedHint = auth.managed_path
        ? `Your dashboard password is set by your platform. ${auth.managed_path}`
        : 'Your dashboard password is managed by your platform configuration.';
      this.csrf = auth.csrf || null;
      // Password set but no valid session -> show the login screen.
      if (this.passwordEnabled && !auth.authed) { this.showLogin = true; return; }
      const setup = await this.getJson('/api/setup/state');
      if (setup.completed) { this.appReady = true; this.showApp = true; this.initApp(); return; }
      this.showWizard = true;
      // Resume at the first incomplete step: if the MRR key is already stored, skip
      // the password/keys steps and land on the pool step.
      if (setup.configured) this.goStep(2);
      else this.goStep(this.passwordEnabled ? 1 : 0);
    },

    async login() {
      this.error = ''; this.busy = true;
      const r = await this.send('POST', '/api/auth/login', { password: this.loginPassword });
      this.busy = false;
      if (!r.ok) { this.error = r.status === 429 ? 'Too many attempts — wait a moment and try again.' : 'Wrong password.'; return; }
      this.csrf = r.json.csrf; this.loginPassword = '';
      await this.refresh();
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },

    goStep(n) {
      this.s0 = n === 0; this.s1 = n === 1; this.s2 = n === 2; this.s3 = n === 3;
      this.stepLabel = ['Password', 'Connect', 'Pool', 'Fund'][n] || '';
      this.error = '';
    },

    // The session expired mid-use (a gated call returned 401/403). Drop to the login screen and
    // stop the app — its polling is gated on showApp — instead of silently spamming 401s and
    // leaving a stale page up. A manual refresh should not be the only way back to login.
    handleAuthLost() {
      if (this.showLogin) return;   // already there (e.g. a wrong-password login attempt)
      this.showApp = false; this.showHistory = false; this.showSettings = false; this.showMarket = false; this.appReady = false;
      this.passwordEnabled = true; this.showLogin = true;
    },

    // --- API helpers ---
    async getJson(path) {
      try {
        const res = await fetch(path);
        if (res.status === 401 || res.status === 403) { this.handleAuthLost(); return {}; }
        return await res.json();
      } catch { return {}; }
    },
    async send(method, path, body) {
      const headers = { 'content-type': 'application/json' };
      if (this.csrf) headers['x-csrf-token'] = this.csrf;
      try {
        const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        if (res.status === 401 || res.status === 403) { this.handleAuthLost(); return { ok: false, status: res.status, json: {} }; }
        let json = {};
        try { json = await res.json(); } catch { /* empty body */ }
        return { ok: res.ok, status: res.status, json };
      } catch {
        // Network drop / abort — never throw, so callers reliably reset `busy`.
        return { ok: false, status: 0, json: {} };
      }
    },

    // --- Step 0: password ---
    async submitPassword() {
      this.error = ''; this.busy = true;
      const r = await this.send('POST', '/api/auth/set-password', { password: this.password });
      this.busy = false;
      if (!r.ok) { this.error = r.json.error === 'password_too_short' ? 'Choose a password of at least 8 characters.' : 'Could not set the password.'; return; }
      this.csrf = r.json.csrf; this.passwordEnabled = true; this.password = '';
      this.goStep(1);
    },

    // --- Step 1: MRR keys ---
    async submitKeys() {
      this.error = ''; this.busy = true;
      const r = await this.send('POST', '/api/setup/mrr-keys', { key: this.mrrKey, secret: this.mrrSecret });
      this.busy = false;
      if (!r.ok) {
        if (r.json.error === 'rent_permission_required') this.error = 'This key is missing the Rental (rent) permission.';
        else if (r.json.error === 'auth_failed') this.error = 'Could not authenticate — check the key and secret.';
        else this.error = 'Could not validate the key.';
        return;
      }
      const perms = r.json.permissions || {};
      this.keyPermsText = `rent: ${perms.rent} · withdraw: ${perms.withdraw} · rigs: ${perms.rigs}`;
      this.withdrawWarn = !!r.json.withdraw_capable;
      this.mrrSecret = '';
      this.goStep(2);
    },

    // --- Step 2: pool ---
    // Split a pasted "host:port" or "stratum+tcp://host:port" into the two fields, so
    // the user can see what will be used (mirrors the server-side normalization).
    normalizeHost() {
      let host = String(this.poolHost || '').trim();
      let port = String(this.poolPort || '').trim() !== '' ? Number(this.poolPort) : null;
      host = host.replace(/^\w+(\+\w+)?:\/\//i, '').replace(/[/?#].*$/, '').trim();
      const v6 = host.match(/^\[([^\]]+)\](?::(\d+))?$/);
      if (v6) { host = v6[1]; if (v6[2]) port = Number(v6[2]); }
      else { const hp = host.match(/^([^:]+):(\d+)$/); if (hp) { host = hp[1]; port = Number(hp[2]); } }
      this.poolHost = host;
      if (port) this.poolPort = String(port);
    },

    async detect() {
      this.busy = true;
      const r = await this.getJson('/api/setup/hashgg-detect');
      this.busy = false;
      if (r.reachable && r.publicEndpoint) { this.poolHost = r.publicEndpoint.host; this.poolPort = String(r.publicEndpoint.port); }
      else this.error = 'HashGG was not detected — enter your endpoint manually.';
    },
    async testPool() {
      this.error = ''; this.busy = true; this.poolReport = null;
      const r = await this.send('POST', '/api/setup/pool-test', { host: this.poolHost, port: this.poolPort, user: this.poolUser });
      this.busy = false;
      if (!r.ok) { this.error = this.poolTestErr(r.json && r.json.error); return; }
      this.poolReport = r.json;
      this.poolOk = !!r.json.ok;
      this.poolFailed = !r.json.ok;
      this.poolWarning = r.json.warning || '';
      this.bareIp = !!r.json.bare_ip;   // a raw IP -> surface the DuckDNS naming option
      this.duckdnsReport = '';
      const pr = r.json.probe || {};
      this.poolReportText = this.poolOk
        ? `Endpoint serves work (subscribe ${pr.msToSubscribe}ms, first work ${pr.msToFirstWork}ms, difficulty ${pr.difficulty}).`
        : `Endpoint reachable: ${pr.reachable}, but no work received (${pr.error || 'no work'}). Check that Datum is running.`;
    },
    poolTestErr(e) {
      return e === 'endpoint_not_allowed' ? 'That address can’t be used as a stratum endpoint (link-local/metadata ranges are blocked).'
        : e === 'host_unresolvable' ? 'That host couldn’t be resolved — check the spelling.'
        : e === 'rate_limited' ? 'Slow down a moment and try again.'
        : 'Enter a valid host, port, and worker username.';
    },
    async toFund() {
      this.error = ''; this.busy = true;
      const b = await this.send('POST', '/api/setup/bootstrap');
      if (!b.ok) {
        this.busy = false;
        this.error = 'Could not set up the MRR pool/profile — check your endpoint and try again.';
        return;
      }
      const d = await this.getJson('/api/setup/deposit');
      this.busy = false;
      this.depositAddr = d.address || '';
      this.depositConfirmed = d.confirmed_sats || 0;
      this.goStep(3);
      this.$nextTick(() => this.renderQr());
    },
    renderQr() {
      try {
        const el = document.getElementById('depositQr');
        if (el && this.depositAddr && window.QRCode && window.QRCode.toCanvas) {
          el.innerHTML = '';
          const c = document.createElement('canvas');
          el.appendChild(c);
          window.QRCode.toCanvas(c, this.depositAddr, { width: 168 });
        }
      } catch { /* QR is a nice-to-have */ }
    },

    // --- Quote card ---
    initApp() {
      // Start once: land on the empty-state default and price it, then live-refresh.
      if (this._refreshTimer) return;
      this.setComputeFlags();
      this.setUnitClasses();
      this.setRangeClasses();
      this.refreshStatus();
      this.refreshBalance();
      this.refreshMetrics();
      if (this.modeQuick) this.scheduleQuote(0);   // Autopilot is default; only price Quick on load
      // Live re-price every 30s — but NOT while the review modal is open, or a background
      // reprice would swap the quote id out from under the user mid-confirm.
      this._refreshTimer = setInterval(() => {
        // Background re-price: quick mode only (never re-price behind the autopilot form),
        // never over an open review, and silent so it doesn't flash "Pricing…" when idle.
        if (this.showApp && this.modeQuick && !this.quoting && !this.showReview && !this.hasSelection()) this.runQuote({ silent: true });
      }, 30000);
      // Charts + status refresh on a gentler cadence. Paused while the user has an active
      // text selection so a refresh can't clobber a copy in progress (e.g. dispute evidence).
      this._metricsTimer = setInterval(() => {
        if (this.hasSelection()) return;
        if (this.showApp) { this.refreshStatus(); this.refreshMetrics(); }
        else if (this.showHistory) { this.loadHistory(); }   // keep History (incl. dispute countdowns) current while viewing
        else if (this.showSettings) { this.loadDiag(); }     // keep diagnostics (tick freshness) live
        else if (this.showMarket) { this.loadMarket(); }     // keep market depth/price current
      }, 15000);
    },

    // --- Charts / metrics ---
    setRangeClasses() {
      const on = 'text-neon-ember bg-neon-ember/10 border-neon-ember/40';
      const off = 'text-gray-500 border-navy-600 hover:text-white';
      this.cls6h = this.chartRange === '6h' ? on : off;
      this.cls24h = this.chartRange === '24h' ? on : off;
      this.cls7d = this.chartRange === '7d' ? on : off;
      this.clsAll = this.chartRange === 'all' ? on : off;
    },
    setRange(r) { this.chartRange = r; this.setRangeClasses(); this.refreshMetrics(); },
    async refreshMetrics() {
      const m = await this.getJson('/api/metrics?range=' + this.chartRange);
      if (!m || !m.delivered) return;
      this.applyChart(m);
    },
    applyChart(m) {
      const d = m.delivered;
      this.hasMetrics = (d.series[0].points || []).length > 0;
      // Prefer the stacked per-rental bands; fall back to the single delivered area when
      // there are no per-rental samples yet.
      const st = m.delivered_stacked;
      const bands = (st && st.bands) || [];
      this.hasBands = bands.length > 0;
      this.showSingleArea = !this.hasBands;
      for (let i = 0; i < 6; i += 1) {
        this['band' + i] = bands[i] ? bands[i].path : '';
        this['fill' + i] = bands[i] ? bands[i].fill : 'transparent';
      }
      this.deliveredLegend = bands.map((b, i) => ({ key: `lg${i}`, label: b.label, style: `background:${b.fill}` }));
      if (this.hasBands) {
        this.dArea = ''; this.dLine = st.totalLine; this.dPoints = st.totalPoints;
        this.dTargetPath = st.target.path; this.dUnit = st.y.unit; this.dGridPath = st.gridPath;
        this.dYMaxLabel = st.yMaxLabel; this.dXLabels = st.x.map((t) => t.label);
      } else {
        this.dLine = d.series[0].line; this.dArea = d.series[0].area; this.dPoints = d.series[0].points;
        this.dTargetPath = d.target ? d.target.path : ''; this.dUnit = d.y.unit;
        this.dGridPath = d.gridPath; this.dYMaxLabel = d.yMaxLabel; this.dXLabels = d.x.map((t) => t.label);
      }
      const s = m.spend;
      this.sLine = s.series[0].line; this.sArea = s.series[0].area;
      this.sCeilPath = s.ceiling ? s.ceiling.path : ''; this.sCeilLabel = s.ceiling ? `budget ${this.fmtSats(s.ceiling.sats)}` : '';
      this.sGridPath = s.gridPath; this.sYMaxLabel = s.yMaxLabel; this.sXLabels = s.x.map((t) => t.label);
      const mk = m.market;
      this.mHasData = (mk.series[0].points || []).length > 0;
      this.mLowest = mk.series[0].line; this.mLast10 = mk.series[1].line; this.mUnit = mk.y.unit;
      this.mGridPath = mk.gridPath; this.mYMaxLabel = mk.yMaxLabel; this.mXLabels = mk.x.map((t) => t.label);
      this.mPayLine = mk.pay_line || '';
      const mv = this.mktLegendVals(mk);
      this.mCheapVal = mv.cheap; this.mLast10Val = mv.last10; this.mPayShow = mv.payShow; this.mPayVal = mv.pay; this.mPayLabel = mv.payLabel;
      // Hero: latest delivered vs target — read from the SAME series the chart shows
      // (stacked total when bands are up, else the aggregate) so the numeral, %, axis
      // label and crosshair never disagree.
      const heroSeries = this.hasBands ? { points: st.totalPoints, unit: st.y.unit, targetTh: st.target.th } : { points: d.series[0].points, unit: d.y.unit, targetTh: d.target ? d.target.th : 0 };
      const pts = heroSeries.points;
      if (pts.length) {
        const last = pts[pts.length - 1].vy;
        const target = heroSeries.targetTh;
        const div = heroSeries.unit === 'PH/s' ? 1000 : 1;
        const dp = heroSeries.unit === 'PH/s' ? 2 : 0;
        this.heroActive = true;
        this.heroUnit = heroSeries.unit;
        this.countUp('heroDeliveredNum', last / div, (v) => { this.heroDelivered = v.toFixed(dp); }, dp);
        this.heroTarget = `of ${(target / div).toFixed(dp)} ${heroSeries.unit} target`;
        const pct = target > 0 ? Math.round((last / target) * 100) : 0;
        this.heroPct = pct + '%';
        this.heroPctClass = pct >= 95 ? 'text-neon-green' : pct >= 90 ? 'text-neon-yellow' : 'text-neon-flame';
      }
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },
    // Lightweight count-up tween for the hero numeral (the "count rather than snap" feel).
    countUp(key, target, setter, dp) {
      const from = this['_' + key] != null ? this['_' + key] : 0;
      const t0 = performance.now();
      const dur = 500;
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - k, 3);
        setter(from + (target - from) * eased);
        if (k < 1) requestAnimationFrame(tick);
        else this['_' + key] = target;
      };
      requestAnimationFrame(tick);
    },
    onCrosshair(ev) {
      if (!this.dPoints.length) return;
      const svg = ev.currentTarget;
      const rect = svg.getBoundingClientRect();
      const vx = ((ev.clientX - rect.left) / rect.width) * 800;   // viewBox is 800 wide
      let nearest = this.dPoints[0];
      for (const p of this.dPoints) { if (Math.abs(p.x - vx) < Math.abs(nearest.x - vx)) nearest = p; }
      this.crossShow = true; this.crossX = nearest.x;
      this.tipX = Math.min(716, Math.max(4, nearest.x - 42)); this.tipTextX = this.tipX + 42;
      const div = this.dUnit === 'PH/s' ? 1000 : 1;
      const dp = this.dUnit === 'PH/s' ? 2 : 0;
      this.tipText = `${(nearest.vy / div).toFixed(dp)} ${this.dUnit}`;
    },
    hideCrosshair() { this.crossShow = false; },
    onImpactCrosshair(ev) {
      if (!this.impactPoints.length) return;
      const rect = ev.currentTarget.getBoundingClientRect();
      const vx = ((ev.clientX - rect.left) / rect.width) * 800;
      let nearest = this.impactPoints[0];
      for (const p of this.impactPoints) { if (Math.abs(p.x - vx) < Math.abs(nearest.x - vx)) nearest = p; }
      this.impCrossShow = true; this.impCrossX = nearest.x;
      this.impTipX = Math.min(716, Math.max(4, nearest.x - 42)); this.impTipTextX = this.impTipX + 42;
      this.impTipText = `${nearest.vy.toFixed(nearest.vy < 10 ? 2 : 1)} PH·days`;
    },
    hideImpactCrosshair() { this.impCrossShow = false; },
    async ackAlert(id) {
      await this.send('POST', '/api/alerts/ack', { id });
      await this.refreshStatus();
    },
    alertChipClass(sev) {
      return sev === 'critical' ? 'bg-neon-pink/10 text-neon-pink border-neon-pink/30'
        : sev === 'warning' ? 'bg-neon-yellow/10 text-neon-yellow border-neon-yellow/30'
          : 'bg-neon-green/10 text-neon-green border-neon-green/30';
    },
    alertText(a) {
      const c = a.context || {};
      const map = {
        rental_underdelivering: `${c.name || 'A rig'} is under-delivering (${c.percent != null ? Math.round(c.percent) + '%' : 'low'})`,
        rental_offline: `${c.name || 'A rig'} is offline`,
        endpoint_down: `Your pool endpoint is unreachable — new rentals are paused`,
        mrr_api_outage: `MiningRigRentals API is unreachable`,
        balance_low: `Low balance — about ${c.runway_hours != null ? c.runway_hours + 'h' : 'little'} of runway left`,
        deposit_seen: `Deposit detected — waiting for confirmations`,
        deposit_cleared: `Deposit cleared`,
        dispute_window: `A rental under-delivered — MRR usually auto-refunds the difference (see History if it doesn’t)`,
        session_ended: `Session ended`,
        refund_received: `Refund received`,
        needs_reconcile: `A rental's outcome was unclear — check MiningRigRentals for an untracked rental${c.name ? ` (${c.name})` : ''}`,
        endpoint_repaired: `Your pool endpoint moved${c.to ? ` to ${c.to.host}:${c.to.port}` : ''} — active rentals were re-pointed to it`,
        rental_extended: `Auto-extended ${c.name || 'a rig'}${c.hours ? ` by ${c.hours}h` : ''}${c.sats ? ` (${c.sats} sats)` : ''}`,
        rental_adopted: `Recovered an untracked rental${c.mrr_id ? ` (#${c.mrr_id})` : ''} into this session — now monitored and counted`,
        rate_ceiling_hold: `Holding${c.active_th != null && c.target_th != null ? ` at ${this.fmtHashTh(c.active_th)}/${this.fmtHashTh(c.target_th)}` : ' below target'} — your blended rate ceiling is reached. Raise it in the Autopilot preview (or Settings), or wait for cheaper rigs.`,
        rig_rerouted: `${c.name || 'A rig'} wasn’t mining on your pool — switched it to the Ocean fallback${c.messaged ? ' and messaged the owner' : ''}`,
        duckdns_update_failed: `Your endpoint's IP changed but the DuckDNS name couldn't be updated${c.name ? ` (${c.name}.duckdns.org)` : ''} — it may point at the old IP. Check your DuckDNS token.`,
      };
      return map[a.kind] || a.kind;
    },
    setComputeFlags() {
      this.isSpendOut = this.compute === 'spend';
      this.isHashOut = this.compute === 'hashrate';
      this.isDurationOut = this.compute === 'duration';
      this.notSpendOut = !this.isSpendOut;
      this.notHashOut = !this.isHashOut;
      this.notDurationOut = !this.isDurationOut;
      const on = 'text-neon-ember border-neon-ember/40 bg-neon-ember/10';
      const off = 'text-gray-400 border-navy-600 hover:text-white';
      this.lockSpendClass = this.isSpendOut ? on : off;
      this.lockHashClass = this.isHashOut ? on : off;
      this.lockDurClass = this.isDurationOut ? on : off;
      this.syncComputedCue();
    },
    // Derive the computed-field cues from the current compute mode + cap state. A cue only
    // shows when that field is the COMPUTED one and it hit a clamp more input can't move.
    syncComputedCue() {
      this.durComputedPlain = this.isDurationOut && !this.qMaxCapped;
      this.durComputedCapped = this.isDurationOut && this.qMaxCapped;
      this.durBoxClass = this.durComputedCapped ? 'bg-neon-yellow/10 border-neon-yellow/30' : 'bg-navy-800/50 border-navy-600';
      this.hashComputedPlain = this.isHashOut && !this.qMarketCapped;
      this.hashComputedCapped = this.isHashOut && this.qMarketCapped;
      this.hashBoxClass = this.hashComputedCapped ? 'bg-neon-yellow/10 border-neon-yellow/30' : 'bg-navy-800/50 border-navy-600';
    },
    setUnitClasses() {
      const on = 'text-neon-ember bg-neon-ember/10';
      const off = 'text-gray-500 hover:text-white';
      this.unitPhClass = this.unit === 'ph' ? on : off;
      this.unitThClass = this.unit === 'th' ? on : off;
    },
    setCompute(mode) { this.compute = mode; this.setComputeFlags(); this.scheduleQuote(0); },
    setUnit(u) {
      if (u === this.unit) return;
      // Convert BOTH editable hashrate fields (Quick's inHash and Autopilot's apTarget) so the
      // number the user sees keeps meaning the same rate — otherwise toggling the shared unit
      // silently reinterprets the value by 1000x.
      const conv = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return v;
        return u === 'th' ? String(Math.round(n * 1000)) : String(n / 1000);
      };
      this.inHash = conv(this.inHash);
      this.apTarget = conv(this.apTarget);
      this.apHasEstimate = false;   // a re-scaled target invalidates any shown estimate
      this.unit = u;
      this.unitLabelText = u === 'ph' ? 'PH/s' : 'TH/s';
      this.setUnitClasses();
      this.scheduleQuote(0);
    },
    preset(sats) { this.inSpend = String(sats); this.scheduleQuote(0); },
    hashToTh() {
      const n = Number(this.inHash);
      if (!Number.isFinite(n)) return null;
      return this.unit === 'ph' ? n * 1000 : n;
    },

    // --- Autopilot ---
    setRentMode(m) {
      this.rentMode = m;
      this.modeQuick = m === 'quick';
      this.modeAutopilot = m === 'autopilot';
      const on = 'bg-neon-ember/15 text-neon-ember';
      const off = 'text-gray-500 hover:text-white';
      this.mqClass = this.modeQuick ? on : off;
      this.maClass = this.modeAutopilot ? on : off;
      this.apError = '';
      this.apRateCeilTouched = false;   // fresh context on a mode switch -> ceiling re-defaults on next Preview
      if (this.modeAutopilot) { this.qHasQuote = false; this.quoteError = ''; }
      else { this.apHasEstimate = false; this.apStarted = false; this.scheduleQuote(0); }
    },
    apPreset(sats) { this.apBudget = String(sats); this.apHasEstimate = false; },
    apCeilTouched() { this.apRateCeilTouched = true; this.apRateCeilAuto = false; },   // an edited ceiling is deliberate -> sticky
    async apMax() {
      this.apMaxBusy = true;
      try {
        const d = await this.getJson('/api/deposit');
        if (!d || d.confirmed_sats == null) { this.apError = 'Couldn’t read your balance — try again in a moment.'; return; }
        this.apBudget = String(d.confirmed_sats);
        this.apHasEstimate = false; this.apError = '';
      } finally {
        this.apMaxBusy = false;
      }
    },
    apTargetTh() {
      const n = Number(this.apTarget);
      if (!Number.isFinite(n) || n <= 0) return null;
      return this.unit === 'ph' ? n * 1000 : n;
    },
    apParams() {
      return { targetTh: this.apTargetTh(), timeCapHours: Number(this.apDays) * 24, budgetSats: Math.round(Number(this.apBudget)) };
    },
    apValid(p) { return p.targetTh && p.timeCapHours > 0 && p.budgetSats > 0; },
    async apPreview() {
      const p = this.apParams();
      if (!this.apValid(p)) { this.apError = 'Enter a target, time cap, and budget.'; return; }
      this.apBusy = true; this.apBusyText = 'Checking the market…'; this.apError = ''; this.apStarted = false;
      const r = await this.getJson(`/api/autopilot/estimate?target_th=${p.targetTh}&budget_sats=${p.budgetSats}`);
      this.apBusy = false;
      if (!r || !r.estimate) { this.apHasEstimate = false; this.apError = 'Could not estimate — check your MRR connection and try again.'; return; }
      this.applyEstimate(r.estimate, p, r.current_blended_ceiling_sats_ph_day);
    },
    applyEstimate(est, p, currentCeiling) {
      this.apHasEstimate = true;
      this.apRigsText = `${est.rigCount} · ${this.fmtHashTh(est.coveredTh)}`;
      this.apRateText = est.blendedSatsPhDay != null ? `${this.fmtSats(est.blendedSatsPhDay)} sats/PH·day` : '—';
      // Pre-fill the blended rate ceiling. A deliberate standing setting wins (the API returns it only
      // when it was NOT an auto-suggestion); otherwise the suggested cap (estimated blend + headroom,
      // so the fill isn't strangled hugging the estimate), falling back to the bare blend. apRateCeilAuto
      // tracks whether the pre-filled value is an auto-suggestion — sent on start so an accepted
      // suggestion doesn't get persisted as a sticky ceiling that masks future suggestions. Don't
      // clobber a value the user has already typed this session.
      if (!this.apRateCeilTouched) {
        if (currentCeiling != null) { this.apRateCeil = String(currentCeiling); this.apRateCeilAuto = false; }
        else {
          this.apRateCeil = est.suggestedCeilingSatsPhDay != null ? String(est.suggestedCeilingSatsPhDay)
            : (est.blendedSatsPhDay != null ? String(est.blendedSatsPhDay) : '');
          this.apRateCeilAuto = true;
        }
      }
      this.apBurnText = `${this.fmtSats(est.burnSatsHr)} sats/hr`;
      // Estimated spend through the run: burn × time cap, but never more than the budget cap
      // (whichever cap ends the run first). An estimate only — actual spend tracks live prices.
      const estSpend = est.burnSatsHr != null && p.timeCapHours > 0
        ? Math.min(p.budgetSats, Math.round(est.burnSatsHr * p.timeCapHours))
        : null;
      this.apSpendText = estSpend != null ? `≈ ${this.fmtSats(estSpend)} sats` : '—';
      if (est.runwayHours == null) {
        this.apRunwayText = 'no burn';
      } else {
        // Show the ACTUAL run length — whichever cap hits first — not the raw runway.
        const budgetEndsIt = est.runwayHours < p.timeCapHours;
        const days = Math.min(est.runwayHours, p.timeCapHours) / 24;
        this.apRunwayText = `${days.toFixed(1)} days · ${budgetEndsIt ? 'budget ends it' : 'time cap ends it'}`;
      }
      this.apShortfall = est.shortfallTh > 0;
      this.apShortfallText = est.shortfallTh > 0
        ? `The market can only cover ${this.fmtHashTh(est.coveredTh)} of your target right now — autopilot will hold what it can and keep watching for more.`
        : '';
    },
    async startAutopilot() {
      const p = this.apParams();
      if (!this.apValid(p)) { this.apError = 'Enter a target, time cap, and budget.'; return; }
      this.apBusy = true; this.apBusyText = 'Starting autopilot…'; this.apError = '';
      const ceil = this.apRateCeil !== '' && Number(this.apRateCeil) > 0 ? Math.round(Number(this.apRateCeil)) : null;
      // blended_ceiling_auto: true when the ceiling is an accepted auto-suggestion (not user-typed), so
      // the backend won't persist it as a sticky value that masks the next preview's fresh suggestion.
      const r = await this.send('POST', '/api/autopilot/start', { target_th: p.targetTh, time_cap_hours: p.timeCapHours, budget_sats: p.budgetSats, blended_ceiling_sats_ph_day: ceil, blended_ceiling_auto: this.apRateCeilAuto });
      this.apBusy = false;
      if (!r.ok) {
        const e = r.json.error;
        this.apError = e === 'session_active' ? 'A session is already running — stop it in the “Active rentals” card above before starting another.'
          : e === 'no_rigs_available' ? 'No eligible rigs on the market right now — try again shortly.'
          : e === 'exceeds_guardrail' ? 'That budget is above the safety ceiling — lower it or raise the limit in Settings.'
          : e === 'no_endpoint' ? 'Finish pool setup before starting autopilot.'
          : (e === 'bad_target' || e === 'bad_time_cap' || e === 'bad_budget') ? 'Check the target, time cap, and budget.'
          : 'Could not start autopilot — try again in a moment.';
        return;
      }
      this.apHasEstimate = false;
      this.apStarted = true;
      this.apRateCeilTouched = false;   // next session's preview re-defaults the ceiling
      const days = Math.round((r.json.time_cap_hours || 0) / 24);
      const live = this.heroChip === 'LIVE';
      this.apStartedText = `Autopilot started — holding ${this.fmtHashTh(r.json.target_th)} until the budget or ${days}-day cap.${live ? '' : ' (DRY-RUN: rehearsing only — switch to LIVE to spend.)'}`;
      await this.refreshStatus();
    },

    scheduleQuote(delay) {
      this.quoteError = '';
      this.showRehearsal = false;   // a fresh quote supersedes any prior rehearsal panel
      if (this._quoteTimer) clearTimeout(this._quoteTimer);
      this._quoteTimer = setTimeout(() => this.runQuote(), delay == null ? 450 : delay);
    },
    // The two editable fields for the current lock must be present and positive.
    inputsReady() {
      const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0; };
      if (this.compute !== 'spend' && !pos(this.inSpend)) return false;
      if (this.compute !== 'hashrate' && !pos(this.inHash)) return false;
      if (this.compute !== 'duration' && !pos(this.inDays)) return false;
      return true;
    },
    // `silent:true` is the 30s background re-price — no "Pricing…" indicator (so it never
    // flashes when idle) and a transient failure keeps the last good quote instead of
    // clearing it. A user-initiated quote (silent:false) shows progress and errors normally.
    async runQuote(opts = {}) {
      const silent = !!opts.silent;
      if (!this.inputsReady()) {
        if (!silent) { this.quote = null; this.applyQuoteDisplay(); this.quoteError = 'Enter the two values above to see a quote.'; }
        return;
      }
      const body = { compute: this.compute };
      if (this.compute !== 'spend') body.spend_sats = Number(this.inSpend);
      if (this.compute !== 'hashrate') body.hashrate_th = this.hashToTh();
      if (this.compute !== 'duration') body.duration_hours = Number(this.inDays) * 24;
      if (!silent) this.quoting = true;
      const r = await this.send('POST', '/api/quote', body);
      if (!silent) this.quoting = false;
      if (!r.ok) {
        if (silent) return;   // keep the last good quote on a transient background failure
        this.quote = null;
        this.quoteError = r.json.error === 'missing_inputs' ? 'Fill in the two fields above to get a quote.'
          : r.json.error === 'no_endpoint' ? 'No pool endpoint is configured.'
          : 'Could not price a quote right now — try again in a moment.';
        return;
      }
      this.quote = r.json;
      this.applyQuoteDisplay();
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },

    // Fold the quote into the plain display props the (CSP-restricted) templates bind.
    applyQuoteDisplay() {
      const q = this.quote;
      this.qHasQuote = !!q;
      if (!q) { this.qCanRent = false; this.qCannotRent = true; this.qMaxCapped = false; this.qMarketCapped = false; this.syncComputedCue(); return; }
      const mc = q.market_context;
      const badge = mc && mc.label ? ` · ${mc.label}` : '';
      this.qHeadline = `${q.rig_count} rigs · ${this.fmtHashTh(q.target_th)} · ${this.fmtSats(Number(q.blended_btc_ph_day) * 1e8)} sats/PH/day blended`;
      this.qFeeLine = `3% MRR fee included${badge}`;
      this.qPoolLine = `Pool: ${q.endpoint.stratum}`;
      this.qBalance = `Balance: ${this.fmtSats(q.balance_sats)} sats confirmed`;
      if (q.balance_sats != null) this.balanceBig = `${this.fmtSats(q.balance_sats)} sats`;   // keep the balance card in sync
      this.qTotal = `${this.fmtSats(q.total_sats)} sats`;
      this.qDurationOut = this.fmtDurationHours(q.duration_hours);
      this.qHashOut = this.fmtHashTh(q.target_th);
      this.qSpendOut = this.fmtSats(q.total_sats);
      this.qInsufficient = !!q.insufficient_funds;
      this.qShortfall = q.shortfall_th > 0;
      this.qShortfallText = `Only ${this.fmtHashTh(q.target_th)} of your target is available right now — the market can't fill the rest.`;
      this.qCapped = !!(q.warnings && q.warnings.includes('budget_capped'));
      this.qMaxCapped = !!(q.warnings && q.warnings.includes('maxhours_capped'));
      // Framed around DURATION (the cause), not the sats amount — so it doesn't read like a
      // balance statement next to the insufficient-funds message.
      this.qMaxCappedText = `These rigs cap their rental length at ${this.fmtDurationHours(q.duration_hours).replace('≈ ', '')}, so your run is shorter than your budget could fund — you're only charged for the time you actually get.`;
      this.qExceedsGuard = !!(q.warnings && q.warnings.includes('exceeds_guardrail'));
      this.qDiffEdge = !!(q.warnings && q.warnings.includes('diff_edge'));
      this.qMarketCapped = !!(q.warnings && q.warnings.includes('market_capped'));
      this.qMarketCappedText = `You've priced in every rig available at this duration, so more spend can't add hashrate right now — shorten the duration or check back as supply frees up.`;
      // Zero-hashrate reasons (hashrate mode) — surfaced so a "0" result explains itself.
      this.qBudgetTooLow = !!(q.warnings && q.warnings.includes('budget_too_low'));
      this.qInfeasibleDuration = !!(q.warnings && q.warnings.includes('infeasible_duration'));
      this.qCanRent = q.rig_count > 0 && !q.insufficient_funds && !this.qExceedsGuard;
      this.qCannotRent = !this.qCanRent;
      // Group notices: blocking (why you can't rent) vs informational (context).
      this.qHasBlocking = this.qInsufficient || this.qExceedsGuard || this.qBudgetTooLow || this.qInfeasibleDuration;
      this.qHasNotes = this.qShortfall || this.qMaxCapped || this.qMarketCapped || this.qCapped || this.qDiffEdge;
      this.syncComputedCue();
      this.qTight = !!(mc && mc.tight);
      this.qRigs = (q.rigs || []).map((r) => ({
        id: r.id, name: r.name, owner: r.owner, region: r.region,
        rpi: r.rpi != null ? Number(r.rpi).toFixed(0) : '—',
        hash: this.fmtHashRig(r.advertised_th),
        cost: `${this.fmtSats((r.paid_sats || 0) + (r.fee_sats || 0))} sats`,
      }));
    },

    // Formatting (internal — never referenced from templates).
    fmtSats(n) {
      if (n == null || !Number.isFinite(Number(n))) return '—';
      return Math.round(Number(n)).toLocaleString('en-US');
    },
    fmtDurationHours(h) {
      if (h == null || !(h > 0)) return '—';
      if (h < 24) return `≈ ${(Math.round(h * 10) / 10)} hours`;
      const days = h / 24;
      if (days < 14) return `≈ ${(Math.round(days * 10) / 10)} days`;
      return `≈ ${(Math.round((days / 7) * 10) / 10)} weeks`;
    },
    fmtHashTh(th) {
      if (th == null || !(th >= 0)) return '—';
      return this.unit === 'ph' ? `${(th / 1000).toFixed(2)} PH/s` : `${Math.round(th).toLocaleString('en-US')} TH/s`;
    },
    // Per-rig hashrate, auto-scaled to the rig's own magnitude and INDEPENDENT of the quote
    // card's aggregate PH/TH toggle. A single MRR rig is tens of TH/s, so the aggregate PH/s
    // unit would render it as "0.00 PH/s"; here a 4 TH/s rig reads "4.0 TH/s" and a 1.5 PH/s
    // rig reads "1.50 PH/s".
    fmtHashRig(th) {
      if (th == null || !(th >= 0)) return '—';
      const n = Number(th);
      if (n >= 1000) return `${(n / 1000).toFixed(2)} PH/s`;
      return `${n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1)} TH/s`;
    },
    toggleBreakdown() { this.breakdownOpen = !this.breakdownOpen; this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); }); },

    // --- Balance + deposit ---
    // True while the user has text selected — periodic refreshes pause so re-rendering a
    // list (which re-sets textContent) can't collapse a selection mid-copy.
    hasSelection() {
      const s = window.getSelection && window.getSelection();
      return !!(s && String(s).length);
    },
    applyBalance(confirmed, unconfirmed) {
      if (confirmed == null) return;
      this.balanceBig = `${this.fmtSats(confirmed)} sats`;
      const unconf = unconfirmed || 0;
      this.hasUnconfirmed = unconf > 0;
      this.balanceUnconfText = unconf > 0 ? `+${this.fmtSats(unconf)} sats pending (3 confirmations)` : '';
    },
    async refreshBalance() {
      const d = await this.getJson('/api/deposit');
      if (d && d.address) this.depositAddr2 = d.address;
      if (d) this.applyBalance(d.confirmed_sats, d.unconfirmed_sats);
    },
    openDeposit() {
      this.showDeposit = true;
      this.$nextTick(() => { this.renderDepositQr(); if (window.lucide) window.lucide.createIcons(); });
    },
    closeDeposit() { this.showDeposit = false; },
    renderDepositQr() {
      try {
        const el = document.getElementById('dashDepositQr');
        if (el && this.depositAddr2 && window.QRCode && window.QRCode.toCanvas) {
          el.innerHTML = '';
          const c = document.createElement('canvas');
          el.appendChild(c);
          window.QRCode.toCanvas(c, this.depositAddr2, { width: 168 });
        }
      } catch { /* QR is a nice-to-have */ }
    },

    // --- Info tips (inline, one open at a time) ---
    toggleInfo(key) {
      const k = this.infoOpen === key ? '' : key;
      this.infoOpen = k;
      this.infoTipText = this.INFO[k] || '';
      // When a computed field is clamped, fold the reason into its tip.
      if (k === 'duration' && this.qMaxCapped) this.infoTipText = `${this.INFO.duration} ${this.qMaxCappedText}`;
      if (k === 'hashrate' && this.qMarketCapped) this.infoTipText = `${this.INFO.hashrate} ${this.qMarketCappedText}`;
      this.tipSpend = k === 'spend';
      this.tipHashrate = k === 'hashrate';
      this.tipDuration = k === 'duration';
      this.tipLock = k === 'lock';
      this.tipBlended = k === 'blended';
      this.tipMarket = k === 'market';
      this.tipBalance = k === 'balance';
    },

    // --- Top-nav views ---
    setNav(view) {
      this.showApp = view === 'dashboard';
      this.showHistory = view === 'history';
      this.showSettings = view === 'settings';
      this.showMarket = view === 'market';
      const on = 'tab-active pb-1';
      const off = 'hover:text-white pb-1';
      this.navDashClass = view === 'dashboard' ? on : off;
      this.navHistClass = view === 'history' ? on : off;
      this.navSetClass = view === 'settings' ? on : off;
      this.navMktClass = view === 'market' ? on : off;
    },
    goDashboard() {
      if (!this.appReady) return;   // nav is inert until authed + setup complete
      this.setNav('dashboard');
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },
    goHistory() {
      if (!this.appReady) return;
      this.setNav('history');
      this.loadHistory();
    },
    async goMarket() {
      if (!this.appReady) return;
      this.setNav('market');
      await this.loadMarket();
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },
    // Populate the Hash Value readout (your pay-rate vs market rate) from an /api/{status,market} block.
    fmtHashValue(hv) {
      hv = hv || {};
      this.hvMarket = hv.market_sats_ph_day != null ? this.fmtSats(hv.market_sats_ph_day) : '—';
      if (!hv.available) {
        this.hvAvail = false; this.hvBadge = ''; this.hvBadgeClass = 'text-gray-500 border-navy-600';
        this.hvPay = '—'; this.hvEff = '—';
        return;
      }
      this.hvAvail = true;
      this.hvPay = this.fmtSats(hv.your_pay_sats_ph_day);
      this.hvEff = hv.effective_sats_ph_day != null ? this.fmtSats(hv.effective_sats_ph_day) : '—';
      const over = hv.over_market_pct;
      if (over == null) { this.hvBadge = ''; this.hvBadgeClass = 'text-gray-500 border-navy-600'; return; }
      const sign = over > 0 ? `+${over}%` : `${over}%`;
      const under = over <= 0;
      this.hvBadge = over === 0 ? 'at market' : (under ? `${sign} under market` : `${sign} over market`);
      this.hvBadgeClass = under ? 'text-neon-green border-neon-green/40' : 'text-neon-pink border-neon-pink/40';
    },
    // Split each market line's current value out so the legend can show a color swatch per line
    // (fixes "which line is which" / "the 'you' line looks missing").
    mktLegendVals(mk) {
      const cur = (v) => (v != null ? this.fmtSats(v) : '—');
      const s = mk && mk.series ? mk.series : [];
      return {
        cheap: cur(s[0] && s[0].current),
        last10: cur(s[1] && s[1].current),
        payShow: !!(mk && mk.pay_value != null),
        pay: cur(mk && mk.pay_value),
        // "you" while a session is live; "you (last)" when the rate is from a finished session.
        payLabel: mk && mk.pay_live === false ? 'you (last)' : 'you',
      };
    },
    async loadMarket() {
      const d = (await this.getJson('/api/market')) || {};
      this.fmtHashValue(d.hash_value);
      const s = d.summary;
      this.marketEmpty = !s;
      this.hasMarket = !!s;
      this.hvShowHint = this.hasMarket && !this.hvAvail;   // market data but no active session to compare
      this.mktSummary = s ? `${this.fmtSats(s.lowest_sats_ph_day)} sats/PH·day cheapest · ${this.fmtHashTh(s.available_th)} available · ${s.available_rigs} rigs` : '';
      const cn = d.cheap_now || {};
      if (cn.available) {
        this.cheapText = cn.label.toUpperCase();
        const vs = cn.vs_median_pct === 0 ? 'at the median' : (cn.vs_median_pct < 0 ? `${Math.abs(cn.vs_median_pct)}% below median` : `${cn.vs_median_pct}% above median`);
        this.cheapSub = `cheaper than ${100 - cn.percentile}% of the last ${cn.samples} snapshots · ${vs}`;
        this.cheapClass = cn.label === 'cheap' ? 'text-neon-green border-neon-green/40' : cn.label === 'pricey' ? 'text-neon-pink border-neon-pink/40' : 'text-neon-yellow border-neon-yellow/40';
      } else { this.cheapText = '—'; this.cheapSub = 'not enough market history yet'; this.cheapClass = 'text-gray-500 border-navy-600'; }
      const im = d.impact || {};
      this.impactHasData = !im.empty;
      this.impactTotal = im.total_label || '0 PH·days';
      this.impactLine = im.line || ''; this.impactArea = im.area || ''; this.impactGridPath = im.gridPath || '';
      this.impactPoints = im.points || [];
      this.impactXLabels = (im.x || []).map((t) => t.label);
      this.impactYMaxLabel = im.y ? `${(im.y.max).toFixed(im.y.max < 10 ? 2 : 1)} ${im.y.unit}` : '';
      const ph = d.price_history || { series: [{}, {}], x: [] };
      this.phHasData = (((ph.series || [])[0] || {}).points || []).length > 0;
      this.phLowest = ((ph.series || [])[0] || {}).line || ''; this.phLast10 = ((ph.series || [])[1] || {}).line || '';
      this.phGridPath = ph.gridPath || ''; this.phYMaxLabel = ph.yMaxLabel || ''; this.phXLabels = (ph.x || []).map((t) => t.label);
      this.phPayLine = ph.pay_line || '';
      const pv = this.mktLegendVals(ph);
      this.phCheapVal = pv.cheap; this.phLast10Val = pv.last10; this.phPayShow = pv.payShow; this.phPayVal = pv.pay; this.phPayLabel = pv.payLabel;
      const regs = d.regions || [];
      const maxTh = regs.reduce((mx, r) => Math.max(mx, r.th), 0) || 1;
      this.regionsEmpty = regs.length === 0;
      this.marketRegions = regs.map((r) => ({ region: r.region, thText: this.fmtHashTh(r.th), rigs: r.rigs, style: `width:${Math.round((r.th / maxTh) * 100)}%` }));
    },
    async goSettings() {
      if (!this.appReady) return;
      this.setNav('settings');
      await this.loadSettings();
      await this.loadDiag();
      await this.loadConnection();
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },

    // --- Settings > Connection (API credentials + stratum endpoint) ---
    // Prefill from diagnostics so the current values are visible and editable.
    async loadConnection() {
      const d = (await this.getJson('/api/diag')) || {};
      const m = d.mrr || {};
      this.skUser = m.configured ? `Connected as ${m.username || m.userid}` : 'Not connected';
      this.seHashggAvail = !!d.hashgg_host_set;
      this.fallbackOcean = !!(d.fallback && d.fallback.enabled);   // reflect the saved setting on the endpoint card
      this.rerouteDeadRigs = !!(d.fallback && d.fallback.reroute_dead_rigs);
      this.seIsIp = !!(d.endpoint && d.endpoint.is_ip);
      this.duckdnsEnabled = !!(d.duckdns && d.duckdns.enabled);
      this.duckdnsName = (d.duckdns && d.duckdns.name) || '';
      if (d.duckdns && d.duckdns.subdomain) this.duckdnsSub = d.duckdns.subdomain;
      const ep = d.endpoint;
      if (ep) {
        this.seCurrent = `${ep.host}:${ep.port} · ${ep.worker}`;
        this.seHost = ep.host; this.sePort = String(ep.port); this.seWorker = ep.worker;
      } else {
        this.seCurrent = 'No endpoint set';
      }
    },
    async updateKeys() {
      if (!this.skKey || !this.skSecret) { this.skReport = 'Enter both the API key and secret.'; this.skReportClass = 'text-neon-pink'; return; }
      this.skBusy = true; this.skReport = '';
      const r = await this.send('POST', '/api/setup/mrr-keys', { key: this.skKey, secret: this.skSecret });
      this.skBusy = false;
      if (!r.ok) {
        this.skReportClass = 'text-neon-pink';
        if (r.json.error === 'rent_permission_required') this.skReport = 'This key is missing the Rental (rent) permission.';
        else if (r.json.error === 'auth_failed') this.skReport = 'Could not authenticate — check the key and secret.';
        else this.skReport = 'Could not validate the key.';
        return;
      }
      this.skKey = ''; this.skSecret = '';
      this.skReportClass = 'text-neon-green';
      this.skReport = `Updated — connected as ${r.json.username || r.json.userid}. Run mode reset to DRY-RUN.`;
      await this.loadConnection();
      await this.loadDiag();
    },
    async seDetect() {
      this.seBusy = true; this.seReport = '';
      const r = await this.getJson('/api/setup/hashgg-detect');
      this.seBusy = false;
      if (r.reachable && r.publicEndpoint) { this.seHost = r.publicEndpoint.host; this.sePort = String(r.publicEndpoint.port); this.seReport = 'HashGG endpoint detected — set your worker and test.'; this.seReportClass = 'text-neon-green'; }
      else { this.seReport = 'HashGG was not detected — enter your endpoint manually.'; this.seReportClass = 'text-neon-pink'; }
    },
    async saveEndpoint() {
      this.seBusy = true; this.seReport = ''; this.seWarning = '';
      const r = await this.send('POST', '/api/setup/pool-test', { host: this.seHost, port: this.sePort, user: this.seWorker });
      if (!r.ok) { this.seBusy = false; this.seReport = this.poolTestErr(r.json && r.json.error); this.seReportClass = 'text-neon-pink'; return; }
      const pr = r.json.probe || {};
      this.seWarning = r.json.warning || '';
      if (!r.json.ok) {
        this.seBusy = false;
        this.seReportClass = 'text-neon-pink';
        this.seReport = `Endpoint reachable: ${pr.reachable}, but no work received (${pr.error || 'no work'}). Not saved.`;
        return;
      }
      // Work confirmed and the endpoint is now active — re-ensure the MRR pool/profile for it.
      const b = await this.send('POST', '/api/setup/bootstrap');
      this.seBusy = false;
      if (!b.ok) { this.seReportClass = 'text-neon-pink'; this.seReport = 'Endpoint saved, but the MRR pool/profile update failed — try again.'; return; }
      this.seReportClass = 'text-neon-green';
      this.seReport = `Saved — serves work (difficulty ${pr.difficulty}). New rentals use this endpoint.`;
      await this.loadConnection();
    },
    async loadSettings() {
      const r = await this.getJson('/api/config');
      const schema = (r && r.schema) || {};
      const values = (r && r.values) || {};
      const titles = { strategy: 'Strategy', guardrails: 'Guardrails', notifications: 'Notifications', ui: 'Display' };
      this.settingsGroups = Object.keys(schema).map((ns) => ({
        ns, title: titles[ns] || ns, saved: false, error: '',
        // fallback_pool_enabled + its dead_rig_reroute_enabled sub-option are surfaced together on
        // the Stratum endpoint card instead of here.
        fields: Object.keys(schema[ns]).filter((key) => !(ns === 'strategy' && (key === 'fallback_pool_enabled' || key === 'dead_rig_reroute_enabled'))).map((key) => {
          const spec = schema[ns][key];
          const val = values[ns] ? values[ns][key] : undefined;
          const isBool = spec.type === 'bool';
          const isEnum = spec.type === 'enum';
          const isText = spec.type === 'strlist';
          const isNum = !isBool && !isEnum && !isText;
          let value;
          if (isBool) value = !!val;
          else if (isText) value = Array.isArray(val) ? val.join(', ') : (val || '');
          else value = (val == null ? '' : String(val));
          return { key, label: spec.label || key, help: spec.help || '', unit: spec.unit || '', isBool, isEnum, isText, isNum, values: spec.values || [], value };
        }),
      }));
    },
    async saveGroup(group) {
      const patch = {};
      for (const f of group.fields) patch[f.key] = f.value;
      const r = await this.send('POST', '/api/config', { ns: group.ns, patch });
      if (r.ok) { group.saved = true; group.error = ''; setTimeout(() => { group.saved = false; }, 1500); }
      else { group.error = r.json && r.json.field ? `${r.json.field}: ${r.json.reason || 'invalid'}` : 'Could not save.'; }
    },
    // Persist the setup-wizard Ocean-fallback toggle (default on server-side, so only a change needs saving).
    async saveFallbackOcean() {
      // The reroute sub-option only makes sense with the Ocean fallback on. Turning Ocean off turns it
      // off too (and hides it); the backend also no-ops it without the fallback, so the two stay in sync.
      const patch = { fallback_pool_enabled: this.fallbackOcean };
      if (!this.fallbackOcean && this.rerouteDeadRigs) { this.rerouteDeadRigs = false; patch.dead_rig_reroute_enabled = false; }
      await this.send('POST', '/api/config', { ns: 'strategy', patch });
    },
    async saveRerouteDeadRigs() {
      await this.send('POST', '/api/config', { ns: 'strategy', patch: { dead_rig_reroute_enabled: this.rerouteDeadRigs } });
    },
    // --- DuckDNS: give a raw-IP endpoint a stable name (CSP build -> multi-condition gates are methods) ---
    showDuckdnsSetup() { return this.poolOk && this.bareIp && !this.duckdnsEnabled; },   // setup Step 2
    seShowDuckdnsSetup() { return this.seIsIp && !this.duckdnsEnabled; },                // Settings endpoint card
    duckdnsCantSubmit() { return this.duckdnsBusy || !this.duckdnsSub || !this.duckdnsToken; },
    async setupDuckdns() {
      this.duckdnsBusy = true; this.duckdnsReport = '';
      const r = await this.send('POST', '/api/duckdns/setup', { subdomain: this.duckdnsSub, token: this.duckdnsToken });
      this.duckdnsBusy = false;
      if (r.ok && r.json && r.json.ok) {
        this.duckdnsEnabled = true; this.duckdnsName = r.json.name; this.duckdnsToken = ''; this.seHost = r.json.name;
        this.duckdnsReport = `Using ${r.json.name} — new rentals point here.`; this.duckdnsReportClass = 'text-neon-green';
      } else {
        this.duckdnsReport = this.duckdnsErr(r.json && r.json.error); this.duckdnsReportClass = 'text-neon-pink';
      }
    },
    duckdnsErr(e) {
      return e === 'invalid_subdomain' ? 'Enter a valid DuckDNS subdomain (letters, numbers, hyphens).'
        : e === 'token_required' ? 'Enter your DuckDNS token.'
        : e === 'duckdns_rejected' ? 'DuckDNS rejected that — double-check the subdomain and token.'
        : e === 'not_resolving' ? 'The name isn’t resolving to your IP yet — DuckDNS can be slow; give it a minute and try again.'
        : e === 'endpoint_not_ip' ? 'The endpoint isn’t a raw IP — no name needed.'
        : e === 'no_endpoint' ? 'Test an endpoint first.'
        : 'Could not set up the DuckDNS name — try again.';
    },
    async disableDuckdns() {
      this.duckdnsBusy = true; this.duckdnsReport = '';
      const r = await this.send('POST', '/api/duckdns/disable', {});
      this.duckdnsBusy = false;
      if (r.ok) { this.duckdnsEnabled = false; this.duckdnsName = ''; await this.loadConnection(); }
    },
    async loadDiag() {
      const d = (await this.getJson('/api/diag')) || {};
      const m = d.mrr || {}; const e = d.engine || {};
      this.diagText = {
        mrr: m.configured ? `connected as ${m.username || m.userid} · withdraw ${m.withdraw_capable ? 'YES' : 'no'}` : 'not configured',
        mode: d.run_mode || '—',
        tick: e.last_tick_age_sec != null ? `${e.last_tick_age_sec}s ago · ${e.ticks_last_hour}/hr` : 'no ticks yet',
        hashgg: d.hashgg_host_set ? 'set' : 'not set (endpoint auto-repair off)',
        fallback: (d.fallback && d.fallback.enabled) ? `Ocean · ${d.fallback.worker || 'your address'}` : 'off',
      };
    },
    async loadHistory() {
      const r = await this.getJson('/api/session/history');
      const sessions = (r && r.sessions) || [];
      const nowSec = Math.floor(Date.now() / 1000);
      this.historySessions = sessions.map((s) => ({
        id: s.id,
        dateText: this.fmtDate(s.ended_at || s.started_at),
        spentText: `${this.fmtSats(s.spent_sats)} sats`,
        effectiveText: s.effective_sats_per_th_day != null ? `${this.fmtSats(Math.round(s.effective_sats_per_th_day * 1000))} sats/PH·day delivered` : '—',
        durationText: this.fmtDurationHours(s.duration_hours),
        hasRefund: s.refund_sats > 0,
        refundText: s.refund_sats > 0 ? `${this.fmtSats(s.refund_sats)} sats refunded` : '',
        rigs: (s.rigs || []).map((rg, i) => ({
          key: `${s.id}-${i}`,
          rig_id: rg.rig_id,
          name: rg.name, region: rg.region,
          pctText: rg.avg_percent != null ? `${Math.round(rg.avg_percent)}%` : '—',
          pctClass: rg.avg_percent == null ? 'text-gray-500' : rg.avg_percent >= 93 ? 'text-neon-green' : rg.avg_percent >= 90 ? 'text-neon-yellow' : 'text-neon-flame',
          hash: this.fmtHashRig(rg.advertised_th),
          costText: `${this.fmtSats(rg.cost_sats)} sats`,
          // Learned reliability score (mean delivery across all rentals of this rig) + a manual blacklist toggle.
          scoreText: rg.score_percent != null ? `${rg.score_percent}% · ${rg.score_rentals}×` : '—',
          blacklisted: !!rg.blacklisted,
          blLabel: rg.blacklisted ? 'Blacklisted' : 'Blacklist',
          blClass: rg.blacklisted ? 'border-neon-pink/40 text-neon-pink hover:bg-neon-pink/10' : 'border-navy-600 text-gray-500 hover:text-white',
          disputable: rg.disputable,
          deadlineText: rg.disputable ? this.disputeCountdown(rg.deadline_ts, nowSec) : '',
          disputeUrl: rg.links && /^https:\/\//.test(String(rg.links.rental || '')) ? rg.links.rental : '',
          evidenceText: rg.evidence_text || '',
        })),
      }));
      this.historyEmpty = this.historySessions.length === 0;
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },
    async toggleBlacklist(rg) {
      // Blacklisted rigs are filtered from every quote + autopilot top-up (server-side). Reload
      // history so the flag + button reflect the new state.
      const r = await this.send('POST', '/api/rig/blacklist', { rig_id: rg.rig_id, blacklisted: !rg.blacklisted });
      if (r.ok) this.loadHistory();
    },
    disputeCountdown(deadlineTs, nowSec) {
      const rem = deadlineTs - nowSec;
      if (rem <= 0) return 'dispute window closed';
      const h = Math.floor(rem / 3600);
      const m = Math.floor((rem % 3600) / 60);
      return `${h}h ${m}m left to file a dispute`;
    },
    fmtDate(ts) {
      if (!ts) return '';
      try { return new Date(ts * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
    },
    async copyEvidence(text) {
      try { await navigator.clipboard.writeText(text); } catch { /* clipboard may be blocked */ }
    },

    // --- Review modal + session ---
    setModeBadge(mode) {
      this.sessionMode = mode;
      this.reviewBadge = mode === 'live' ? 'LIVE' : 'DRY-RUN';
      this.reviewBadgeClass = mode === 'live'
        ? 'bg-neon-green/10 text-neon-green border-neon-green/30'
        : 'bg-neon-yellow/10 text-neon-yellow border-neon-yellow/30';
    },
    healthClass(h) {
      const m = {
        healthy: 'bg-neon-green/10 text-neon-green border-neon-green/30',
        ramping: 'bg-neon-yellow/10 text-neon-yellow border-neon-yellow/30',
        degraded: 'bg-neon-flame/10 text-neon-flame border-neon-flame/30',
        offline: 'bg-neon-pink/10 text-neon-pink border-neon-pink/30',
        ended: 'bg-navy-800 text-gray-400 border-navy-600',
      };
      return m[h] || 'bg-navy-800 text-gray-400 border-navy-600';
    },
    // --- Owner messaging. Owner-authored username + message are UNTRUSTED -> x-text only. ---
    async openMessages(row) {
      this.msgRentalId = row.mrr_id; this.msgRigName = row.name || '';
      this.msgInput = ''; this.msgError = ''; this.msgThread = []; this.msgThreadEmpty = false;
      this.showMsgModal = true;
      await this.loadThread();
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },
    async loadThread() {
      if (!this.msgRentalId) return;
      const r = await this.getJson(`/api/rental/messages?mrr_id=${this.msgRentalId}`);
      const msgs = (r && r.messages) || [];
      this.msgThread = msgs.map((m) => ({
        username: m.username, message: m.message, is_support: m.is_support,   // rendered via x-text
        whenText: m.when ? String(m.when) : '',
        nameClass: m.is_support ? 'text-neon-yellow' : (m.is_admin ? 'text-neon-pink' : 'text-gray-400'),
      }));
      this.msgThreadEmpty = this.msgThread.length === 0;
      this.msgError = r && r.error ? this.msgErrText(r.error) : '';
    },
    async sendMessage() {
      const text = (this.msgInput || '').trim();
      if (!text || this.msgBusy) return;
      this.msgBusy = true; this.msgError = '';
      const r = await this.send('POST', '/api/rental/messages', { mrr_id: this.msgRentalId, message: text });
      this.msgBusy = false;
      if (r.ok) { this.msgInput = ''; await this.loadThread(); }
      else { this.msgError = this.msgErrText(r.json && r.json.error); }
    },
    closeMessages() { this.showMsgModal = false; this.msgThread = []; },
    msgErrText(e) {
      return e === 'mrr_not_configured' ? 'Connect your MRR account first.'
        : e === 'mrr_unavailable' ? 'Could not reach MRR — try again in a moment.'
        : e === 'send_failed' ? 'The message didn’t send — try again.'
        : e === 'message_too_long' ? 'Too long (2000 character max).'
        : e === 'empty_message' ? 'Enter a message.'
        : e === 'unknown_rental' ? 'That rental isn’t tracked here.'
        : e ? 'Something went wrong.' : '';
    },
    // Third-party rig strings (name/region) are carried raw and only ever bound via x-text.
    mapRentals(rows) {
      return (rows || []).map((r) => {
        const pct = r.avg_percent != null ? Math.round(r.avg_percent) : null;
        return {
          id: r.mrr_id || r.rig_id, mrr_id: r.mrr_id, canMessage: !!r.mrr_id, name: r.rig_name, region: r.region,
          hash: this.fmtHashRig(r.advertised_th),
          cost: `${this.fmtSats((r.paid_sats || 0) + (r.fee_sats || 0))} sats`,
          health: String(r.health || 'pending').toUpperCase(),
          chipClass: this.healthClass(String(r.health || 'pending').toLowerCase()),
          // Delivery percentage, shown next to the badge and spelled out on hover, so the
          // exact rate is visible beyond the coarse HEALTHY/DEGRADED state.
          pctText: pct != null ? `${pct}%` : '',
          pctClass: pct == null ? 'text-gray-500' : pct >= 93 ? 'text-neon-green' : pct >= 90 ? 'text-neon-yellow' : 'text-neon-flame',
          healthTitle: pct != null ? `Delivering ${pct}% of advertised hashrate` : 'No delivery reading yet',
        };
      });
    },
    async refreshStatus() {
      const s = await this.getJson('/api/status');
      if (!s || !s.ok) return;   // a dropped/failed poll must leave the last good state intact, not blank the card
      if (s && s.mode) {
        this.setModeBadge(s.mode);
        this.modeIsLive = s.mode === 'live';
        this.heroChip = s.mode === 'live' ? 'LIVE' : 'DRY-RUN';
        this.heroChipClass = s.mode === 'live' ? 'bg-neon-green/10 text-neon-green border-neon-green/30' : 'bg-neon-yellow/10 text-neon-yellow border-neon-yellow/30';
      }
      if (s && s.balance) this.applyBalance(s.balance.confirmed_sats, s.balance.unconfirmed_sats);   // live balance off the engine's poll
      this.hasSession = !!(s && s.session);
      this.fmtHashValue(s.hash_value);   // "am I paying over/under market?" readout
      this.rentals = this.mapRentals(s && s.rentals);
      this.hasRentals = this.rentals.length > 0;
      // A rehearsal (DRY-RUN, 0 rentals) reads as "active" but nothing was rented or spent —
      // say so plainly, and reassure it's safe to stop. In LIVE it's just filling in.
      this.emptyRentalsNote = this.heroChip === 'LIVE'
        ? 'No rentals yet — autopilot fills in gradually while this session runs.'
        : 'This is a DRY-RUN rehearsal session with no rentals yet. It’s still counted as running, so it blocks a new one until you press “Stop session” above — nothing was rented or spent, so it’s safe to stop.';
      // What "Stop session" will actually do, depending on whether paid rentals are running.
      this.stopNote = this.hasRentals
        ? 'This does NOT cancel rentals you’ve already paid for — MRR gives renters no refund, so that time keeps running until it expires. It stops autopilot from renting any more; the session then ends once your current rentals finish.'
        : 'Nothing is running yet, so this just ends the session immediately and frees you to start a new one.';
      if (s && s.session) {
        const ss = s.session;
        this.sessionState = ss.state || '';
        this.sessionWinding = ss.state === 'winding_down';
        const n = this.rentals.length;
        const label = ss.mode === 'autopilot' ? 'Autopilot' : 'Quick session';
        this.sessionSummary = `${label} · ${n} rental${n === 1 ? '' : 's'}`;
        this.heroSpent = `${this.fmtSats(ss.spent_sats)} spent`;
        this.heroBudget = ss.budget_sats ? `of ${this.fmtSats(ss.budget_sats)} budget` : '';
      } else {
        this.sessionState = ''; this.sessionWinding = false; this.stopConfirm = false;
      }
      this.updateStopBtn();
      this.alertsList = ((s && s.alerts) || []).map((a) => ({
        id: a.id, kind: a.kind, severity: a.severity,
        text: this.alertText(a), chipClass: this.alertChipClass(a.severity),
      }));
      this.hasAlerts = this.alertsList.length > 0;
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },
    openModeModal() { this.modeError = ''; this.modeNeedsTyped = false; this.modeTyped = ''; this.showModeModal = true; },
    closeModeModal() { this.showModeModal = false; },
    async setRunMode(mode) {
      this.modeBusy = true; this.modeError = '';
      const body = { mode };
      if (mode === 'live') body.confirm = this.modeTyped;   // ignored server-side unless a typed confirm is required
      const r = await this.send('POST', '/api/run-mode', body);
      this.modeBusy = false;
      if (r.ok) {
        this.showModeModal = false; this.modeNeedsTyped = false; this.modeTyped = '';
        await this.refreshStatus();
        return;
      }
      const e = r.json.error;
      if (e === 'confirmation_required') {
        // First LIVE attempt with a withdraw-capable key -> reveal the typed confirm; a second
        // failure means what they typed didn't match.
        this.modeError = this.modeNeedsTyped ? 'That didn’t match — type LIVE exactly to confirm.' : '';
        this.modeNeedsTyped = true;
        return;
      }
      this.modeError = e === 'mrr_not_configured' ? 'Finish MRR setup before going live.'
        : e === 'password_required' ? 'Set a dashboard password before going live — it protects the controls that spend Bitcoin.'
        : 'Could not change the run mode — try again.';
    },
    // CSP-safe derived prop: the templates can't evaluate `!a && !b`, so compute it here.
    updateStopBtn() { this.stopBtnShow = !this.stopConfirm && !this.sessionWinding; },
    stopAsk() { this.stopConfirm = true; this.updateStopBtn(); },
    stopCancel() { this.stopConfirm = false; this.updateStopBtn(); },
    async stopSession() {
      this.stopBusy = true;
      await this.send('POST', '/api/session/stop', {});
      this.stopBusy = false; this.stopConfirm = false; this.updateStopBtn();
      await this.refreshStatus();
    },
    reviewRent() {
      if (!this.quote) return;
      this.reviewError = ''; this.reconfirm = false; this.showReview = true;
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },
    closeReview() { this.showReview = false; },
    async confirmRent() {
      if (!this.quote) { this.reviewError = 'This quote is no longer available — close this and get a fresh one.'; return; }
      this.reviewBusy = true; this.reviewError = '';
      const r = await this.send('POST', '/api/session', { quote_id: this.quote.id });
      this.reviewBusy = false;
      if (!r.ok) {
        const e = r.json.error;
        this.reviewError = e === 'insufficient_balance' ? 'Your confirmed balance can’t cover this — deposit more or lower the spend.'
          : (e === 'session_active' || e === 'session_in_progress') ? 'A session is already running — stop it in the “Active rentals” card above before starting another.'
          : e === 'quote_expired' ? 'This quote expired — close this and get a fresh one.'
          : e === 'endpoint_down' ? 'Your pool endpoint is unreachable right now — renting would pay for hashrate that can’t reach it. Wait for the connection to recover, then try again.'
          : 'Could not start the session — try again in a moment.';
        return;
      }
      const j = r.json;
      if (j.needs_reconfirm) {
        this.quote = j.quote; this.applyQuoteDisplay();
        this.reconfirm = true;
        this.reconfirmText = `Prices moved since your quote — the new total is ${this.fmtSats(j.quote.total_sats)} sats. Confirm again to rent at the current price.`;
        return;
      }
      this.showReview = false;
      if (j.dry_run) {
        this.rehearsalBanner = `Rehearsal — nothing was purchased. ${j.planned.length} rentals would have been created for ${this.fmtSats(j.total_sats)} sats.`;
        this.rehearsalRows = (j.planned || []).map((p) => ({
          id: p.rig_id, name: p.rig_name, region: p.region,
          hash: this.fmtHashRig(p.advertised_th), cost: `${this.fmtSats((p.paid_sats || 0) + (p.fee_sats || 0))} sats`,
        }));
        this.showRehearsal = true;
      } else {
        this.showRehearsal = false;
        await this.refreshStatus();
      }
      this.$nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    },

    // --- Finish ---
    async finish() {
      this.error = ''; this.busy = true;
      const r = await this.send('POST', '/api/setup/complete');
      this.busy = false;
      if (r.ok) window.location.reload();
      else this.error = 'Could not finish setup.';
    },
  }));
});
