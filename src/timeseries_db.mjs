import pg from 'pg';

const { Pool } = pg;

const DB_CONFIG = {
  host: process.env.TIMESCALE_HOST || 'localhost',
  port: Number(process.env.TIMESCALE_PORT || 5432),
  database: process.env.TIMESCALE_DB || 'trading_bot',
  user: process.env.TIMESCALE_USER || 'postgres',
  password: process.env.TIMESCALE_PASSWORD || '',
  max: Number(process.env.TIMESCALE_POOL_SIZE || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

let pool = null;
let isInitialized = false;

export async function initializeTimescaleDB() {
  if (isInitialized) return;
  
  try {
    pool = new Pool(DB_CONFIG);
    
    // Test connection
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    
    // Create tables if they don't exist
    await createSchema();
    
    isInitialized = true;
    console.log('[TimescaleDB] Connected and initialized');
  } catch (error) {
    console.error('[TimescaleDB] Initialization failed:', error.message);
    // Don't crash the bot if DB is unavailable - degrade gracefully
    pool = null;
    isInitialized = false;
  }
}

async function createSchema() {
  if (!pool) return;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Market snapshots (price, liquidity, volume)
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_snapshots (
        time TIMESTAMPTZ NOT NULL,
        mint TEXT NOT NULL,
        price_usd DOUBLE PRECISION,
        liquidity_usd DOUBLE PRECISION,
        volume_1h DOUBLE PRECISION,
        volume_4h DOUBLE PRECISION,
        mcap_usd DOUBLE PRECISION,
        txns_1h INTEGER,
        buys_1h INTEGER,
        sells_1h INTEGER,
        source TEXT,
        confidence DOUBLE PRECISION,
        freshness_ms INTEGER,
        metadata JSONB
      );
    `);
    
    // Convert to hypertable if TimescaleDB extension is available
    await client.query(`
      SELECT create_hypertable('market_snapshots', 'time', 
        if_not_exists => TRUE,
        chunk_time_interval => INTERVAL '1 day'
      );
    `).catch(() => {
      // If TimescaleDB extension not available, just use regular table
      console.log('[TimescaleDB] Extension not found, using regular PostgreSQL table');
    });
    
    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_market_snapshots_mint_time 
      ON market_snapshots (mint, time DESC);
    `);
    
    // Momentum signals
    await client.query(`
      CREATE TABLE IF NOT EXISTS momentum_signals (
        time TIMESTAMPTZ NOT NULL,
        mint TEXT NOT NULL,
        score INTEGER,
        wallet_expansion DOUBLE PRECISION,
        tx_acceleration DOUBLE PRECISION,
        buy_sell_ratio DOUBLE PRECISION,
        volume_expansion BOOLEAN,
        passed BOOLEAN,
        failed_checks TEXT[],
        metadata JSONB
      );
    `);
    
    await client.query(`
      SELECT create_hypertable('momentum_signals', 'time',
        if_not_exists => TRUE,
        chunk_time_interval => INTERVAL '1 day'
      );
    `).catch(() => {});
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_momentum_signals_mint_time
      ON momentum_signals (mint, time DESC);
    `);
    
    // Trade entries
    await client.query(`
      CREATE TABLE IF NOT EXISTS trade_entries (
        time TIMESTAMPTZ NOT NULL,
        mint TEXT NOT NULL,
        entry_price_usd DOUBLE PRECISION,
        size_usd DOUBLE PRECISION,
        signature TEXT,
        momentum_score INTEGER,
        liquidity_usd DOUBLE PRECISION,
        source TEXT,
        metadata JSONB
      );
    `);
    
    await client.query(`
      SELECT create_hypertable('trade_entries', 'time',
        if_not_exists => TRUE,
        chunk_time_interval => INTERVAL '1 week'
      );
    `).catch(() => {});
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trade_entries_mint_time
      ON trade_entries (mint, time DESC);
    `);
    
    // Trade exits
    await client.query(`
      CREATE TABLE IF NOT EXISTS trade_exits (
        time TIMESTAMPTZ NOT NULL,
        mint TEXT NOT NULL,
        exit_price_usd DOUBLE PRECISION,
        pnl_usd DOUBLE PRECISION,
        pnl_pct DOUBLE PRECISION,
        hold_duration_ms BIGINT,
        signature TEXT,
        exit_reason TEXT,
        metadata JSONB
      );
    `);
    
    await client.query(`
      SELECT create_hypertable('trade_exits', 'time',
        if_not_exists => TRUE,
        chunk_time_interval => INTERVAL '1 week'
      );
    `).catch(() => {});
    
    // Set retention policies (optional - keep 90 days of raw data)
    await client.query(`
      SELECT add_retention_policy('market_snapshots', INTERVAL '90 days', if_not_exists => TRUE);
    `).catch(() => {});
    
    await client.query(`
      SELECT add_retention_policy('momentum_signals', INTERVAL '90 days', if_not_exists => TRUE);
    `).catch(() => {});
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Insert market snapshot
export async function insertMarketSnapshot(snapshot) {
  if (!pool || !snapshot?.mint) return;
  
  try {
    await pool.query(`
      INSERT INTO market_snapshots 
      (time, mint, price_usd, liquidity_usd, volume_1h, volume_4h, mcap_usd, 
       txns_1h, buys_1h, sells_1h, source, confidence, freshness_ms, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [
      new Date(snapshot.timestamp || Date.now()),
      snapshot.mint,
      snapshot.priceUsd || null,
      snapshot.liquidityUsd || null,
      snapshot.volume?.h1 || null,
      snapshot.volume?.h4 || null,
      snapshot.marketCapUsd || null,
      snapshot.txns?.h1 || null,
      snapshot.buys?.h1 || null,
      snapshot.sells?.h1 || null,
      snapshot.source || 'unknown',
      snapshot.confidence || null,
      snapshot.freshnessMs || null,
      JSON.stringify(snapshot.metadata || {})
    ]);
  } catch (error) {
    console.error('[TimescaleDB] Insert market snapshot failed:', error.message);
  }
}

// Insert momentum signal
export async function insertMomentumSignal(signal) {
  if (!pool || !signal?.mint) return;
  
  try {
    await pool.query(`
      INSERT INTO momentum_signals
      (time, mint, score, wallet_expansion, tx_acceleration, buy_sell_ratio,
       volume_expansion, passed, failed_checks, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      new Date(signal.timestamp || Date.now()),
      signal.mint,
      signal.score || null,
      signal.walletExpansion || null,
      signal.txAcceleration || null,
      signal.buySellRatio || null,
      signal.volumeExpansion || false,
      signal.passed || false,
      signal.failedChecks || [],
      JSON.stringify(signal.metadata || {})
    ]);
  } catch (error) {
    console.error('[TimescaleDB] Insert momentum signal failed:', error.message);
  }
}

// Insert trade entry
export async function insertTradeEntry(entry) {
  if (!pool || !entry?.mint) return;
  
  try {
    await pool.query(`
      INSERT INTO trade_entries
      (time, mint, entry_price_usd, size_usd, signature, momentum_score,
       liquidity_usd, source, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      new Date(entry.timestamp || Date.now()),
      entry.mint,
      entry.entryPriceUsd || null,
      entry.sizeUsd || null,
      entry.signature || null,
      entry.momentumScore || null,
      entry.liquidityUsd || null,
      entry.source || 'live',
      JSON.stringify(entry.metadata || {})
    ]);
  } catch (error) {
    console.error('[TimescaleDB] Insert trade entry failed:', error.message);
  }
}

// Insert trade exit
export async function insertTradeExit(exit) {
  if (!pool || !exit?.mint) return;
  
  try {
    await pool.query(`
      INSERT INTO trade_exits
      (time, mint, exit_price_usd, pnl_usd, pnl_pct, hold_duration_ms,
       signature, exit_reason, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      new Date(exit.timestamp || Date.now()),
      exit.mint,
      exit.exitPriceUsd || null,
      exit.pnlUsd || null,
      exit.pnlPct || null,
      exit.holdDurationMs || null,
      exit.signature || null,
      exit.exitReason || 'unknown',
      JSON.stringify(exit.metadata || {})
    ]);
  } catch (error) {
    console.error('[TimescaleDB] Insert trade exit failed:', error.message);
  }
}

// Query recent snapshots for a mint
export async function getRecentSnapshots(mint, minutes = 60) {
  if (!pool || !mint) return [];
  
  try {
    const result = await pool.query(`
      SELECT * FROM market_snapshots
      WHERE mint = $1 AND time > NOW() - INTERVAL '${minutes} minutes'
      ORDER BY time DESC
      LIMIT 1000
    `, [mint]);
    return result.rows;
  } catch (error) {
    console.error('[TimescaleDB] Query failed:', error.message);
    return [];
  }
}

// Batch insert for efficiency
export async function batchInsertSnapshots(snapshots) {
  if (!pool || !Array.isArray(snapshots) || snapshots.length === 0) return;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    for (const snapshot of snapshots) {
      if (!snapshot?.mint) continue;
      await client.query(`
        INSERT INTO market_snapshots 
        (time, mint, price_usd, liquidity_usd, volume_1h, volume_4h, mcap_usd,
         txns_1h, buys_1h, sells_1h, source, confidence, freshness_ms, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [
        new Date(snapshot.timestamp || Date.now()),
        snapshot.mint,
        snapshot.priceUsd || null,
        snapshot.liquidityUsd || null,
        snapshot.volume?.h1 || null,
        snapshot.volume?.h4 || null,
        snapshot.marketCapUsd || null,
        snapshot.txns?.h1 || null,
        snapshot.buys?.h1 || null,
        snapshot.sells?.h1 || null,
        snapshot.source || 'unknown',
        snapshot.confidence || null,
        snapshot.freshnessMs || null,
        JSON.stringify(snapshot.metadata || {})
      ]);
    }
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[TimescaleDB] Batch insert failed:', error.message);
  } finally {
    client.release();
  }
}

// Graceful shutdown
export async function closeTimescaleDB() {
  if (pool) {
    await pool.end();
    pool = null;
    isInitialized = false;
    console.log('[TimescaleDB] Connection pool closed');
  }
}

export default {
  initialize: initializeTimescaleDB,
  insertMarketSnapshot,
  insertMomentumSignal,
  insertTradeEntry,
  insertTradeExit,
  getRecentSnapshots,
  batchInsertSnapshots,
  close: closeTimescaleDB,
};
