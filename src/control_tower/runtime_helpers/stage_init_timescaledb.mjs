export function initializeTimescaleDbIfEnabled() {
  if (process.env.TIMESCALE_ENABLED !== 'true') return;

  import('../../analytics/timeseries_db.mjs').then(({ initializeTimescaleDB }) => {
    initializeTimescaleDB().catch((err) => {
      console.warn('[TimescaleDB] Failed to initialize (bot will continue without it):', err.message);
    });
  }).catch((err) => {
    console.warn('[TimescaleDB] Import failed:', err.message);
  });
}
