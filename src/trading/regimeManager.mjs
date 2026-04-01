import EventEmitter from 'events';

// Regime modes
export const MODES = Object.freeze({ DEFENSE: 'DEFENSE', BALANCED: 'BALANCED', AGGRESSIVE: 'AGGRESSIVE' });

class RegimeManager extends EventEmitter {
  constructor({ logger = console, birdEye = null, provider = null } = {}) {
    super();
    this.logger = logger;
    this.birdEye = birdEye; // optional data source
    this.provider = provider || { status: 'OK' };

    this.state = {
      mode: MODES.BALANCED,
      consecutive: { DEFENSE: 0, BALANCED: 0, AGGRESSIVE: 0 },
      lastScore: null,
      lastLogSummary: 0
    };

    // Config caps and weights (as required)
    this.caps = {
      confirmRate10m: 1.0,
      entryRate10m: 1.0,
      winRate30m: 1.0,
      runnerRate30m: 1.0,
      snapshotBlockRate10m: 1.0,
      marketHeat10m: 1.0
    };

    this.weights = {
      confirmRate10m: -0.15,
      entryRate10m: -0.1,
      winRate30m: -0.25,
      runnerRate30m: 0.35,
      snapshotBlockRate10m: 0.3,
      marketHeat10m: 0.15
    };

    // Mode parameter mappings (examples)
    this.mappings = {
      DEFENSE: {
        limitPerMin: 20,
        TOP_N_HOT: 5,
        HOT_TTL_MS: 30_000,
        MIN_LIQUIDITY_FLOOR_USD: 150,
        MAX_ACTIVE_RUNNERS: 1,
        POST_WIN_PAUSE_MS: 30_000,
        confirmStageSpeed: 'slow'
      },
      BALANCED: {
        limitPerMin: 60,
        TOP_N_HOT: 12,
        HOT_TTL_MS: 15_000,
        MIN_LIQUIDITY_FLOOR_USD: 50,
        MAX_ACTIVE_RUNNERS: 3,
        POST_WIN_PAUSE_MS: 10_000,
        confirmStageSpeed: 'normal'
      },
      AGGRESSIVE: {
        limitPerMin: 180,
        TOP_N_HOT: 30,
        HOT_TTL_MS: 5_000,
        MIN_LIQUIDITY_FLOOR_USD: 10,
        MAX_ACTIVE_RUNNERS: 8,
        POST_WIN_PAUSE_MS: 1_000,
        confirmStageSpeed: 'fast'
      }
    };

    // internal metric cache for rolling windows (simple): store last values
    this.metrics = {
      confirmRate10m: 0,
      entryRate10m: 0,
      winRate30m: 0,
      runnerRate30m: 0,
      snapshotBlockRate10m: 0,
      marketHeat10m: 0
    };

    this._ticker = null;
  }

  start() {
    if (this._ticker) return;
    // trigger compute every 60s
    this._ticker = setInterval(() => this._computeAndApply(), 60_000);
    // Also run first compute immediately
    this._computeAndApply();
  }

  stop() {
    if (this._ticker) clearInterval(this._ticker);
    this._ticker = null;
  }

  // Update metrics (allows tests to inject simulated values)
  updateMetrics(values = {}) {
    Object.assign(this.metrics, values);
  }

  // Compute normalization with caps
  _normalize(name, value) {
    const cap = this.caps[name] ?? 1.0;
    if (value <= 0) return 0;
    return Math.min(value, cap) / cap;
  }

  // Compute RegimeScore: higher -> more aggressive
  computeScore(metrics = this.metrics) {
    const n = {};
    for (const k of Object.keys(this.weights)) n[k] = this._normalize(k, metrics[k] ?? 0);

    // weighted sum then map to [0,1]
    let raw = 0;
    for (const k of Object.keys(this.weights)) raw += (this.weights[k] || 0) * n[k];

    // raw can be negative; map via sigmoid-like clamp
    // Map raw in [-1,1] to [0,1]
    const score = Math.max(0, Math.min(1, 0.5 + raw / 2));
    return { score, normalized: n, raw };
  }

  _applyHardOverrides(scoreObj) {
    // If provider degraded or snapshotBlockRate10m > 0.35 -> force DEFENSE
    if ((this.provider && this.provider.status === 'DEGRADED') || (this.metrics.snapshotBlockRate10m > 0.35)) {
      return { forced: true, mode: MODES.DEFENSE, note: 'snapshotBlockRate or provider degraded' };
    }
    // If runnerRate30m >= 0.15 -> force AGGRESSIVE (per requirements)
    if (this.metrics.runnerRate30m >= 0.15) {
      return { forced: true, mode: MODES.AGGRESSIVE, note: 'runnerRate forced aggressive' };
    }
    return { forced: false };
  }

  _chooseMode(score) {
    // Map score to mode thresholds (adjusted sensitivity)
    if (score < 0.5) return MODES.DEFENSE;
    if (score < 0.8) return MODES.BALANCED;
    return MODES.AGGRESSIVE;
  }

  _computeAndApply() {
    const computed = this.computeScore();
    let { score } = computed;

    const override = this._applyHardOverrides(computed);
    if (override.forced && override.mode === MODES.DEFENSE) {
      this._commitMode(MODES.DEFENSE, score, computed);
      return;
    }
    if (override.forced && override.mode === MODES.AGGRESSIVE) {
      this._commitMode(MODES.AGGRESSIVE, score, computed);
      return;
    }
    if (override.mode === MODES.AGGRESSIVE) {
      score = Math.max(score, override.floor || 0);
    }

    const candidate = this._chooseMode(score);
    // hysteresis: need 3 consecutive checks for candidate != current
    if (candidate === this.state.mode) {
      // reset counts and keep
      for (const k of Object.keys(this.state.consecutive)) this.state.consecutive[k] = 0;
    } else {
      this.state.consecutive[candidate] = (this.state.consecutive[candidate] || 0) + 1;
      // reset other
      for (const k of Object.keys(this.state.consecutive)) if (k !== candidate) this.state.consecutive[k] = 0;
      if (this.state.consecutive[candidate] >= 3) {
        this._commitMode(candidate, score, computed);
      }
    }

    // periodic 5-minute summary
    const now = Date.now();
    if (now - this.state.lastLogSummary > 5 * 60_000) {
      this._logSummary(score, computed);
      this.state.lastLogSummary = now;
    }
  }

  _commitMode(mode, score, computed) {
    const prev = this.state.mode;
    this.state.mode = mode;
    this.state.lastScore = score;
    // reset consecutive
    for (const k of Object.keys(this.state.consecutive)) this.state.consecutive[k] = 0;
    // Apply parameters atomically - emit event with the mapping
    const params = this.mappings[mode];
    this.emit('modeChange', { mode, params, score, computed });
    this.logger.info && this.logger.info(`[regime] mode-> ${mode} score=${score.toFixed(3)} prev=${prev}`);
    // also log summary
    this._logSummary(score, computed);
  }

  _logSummary(score, computed) {
    const m = this.metrics;
    const params = this.mappings[this.state.mode];
    this.logger.info && this.logger.info(JSON.stringify({
      tag: 'regime_summary',
      time: new Date().toISOString(),
      mode: this.state.mode,
      score: Number(score.toFixed(3)),
      confirmRate10m: m.confirmRate10m,
      winRate30m: m.winRate30m,
      runnerRate30m: m.runnerRate30m,
      snapshotBlockRate10m: m.snapshotBlockRate10m,
      limitPerMin: params.limitPerMin,
      TOP_N_HOT: params.TOP_N_HOT,
      MIN_LIQUIDITY_FLOOR_USD: params.MIN_LIQUIDITY_FLOOR_USD,
      MAX_ACTIVE_RUNNERS: params.MAX_ACTIVE_RUNNERS
    }));
  }

  // API
  getMode() {
    return this.state.mode;
  }

  getParams() {
    return this.mappings[this.state.mode];
  }
}

export default RegimeManager;
