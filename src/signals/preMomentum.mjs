const cache = new Map();
import hotQueue from './hotQueue.mjs';
// helper cache shim
function cacheGet(k){ const r = cache.get(k); return r? r.v:undefined; }
function cacheSet(k,v,ttlS){ cache.set(k,{v,expires: ttlS? Date.now()+ttlS*1000:null}); }
function cacheDel(k){ cache.delete(k); }

const DEFAULTS = {
  TX_BURST_FACTOR: 1.8,
  IMPACT_FACTOR: 2.5,
  MICRO_BUYS_WINDOW_S: 5,
  MICRO_BUYS_THRESHOLD: 3,
  UNIQUE_BUYERS_WINDOW_S: 60
};

export function evaluatePreMomentum(mintId, metrics = {}){
  // metrics: {tx_30s, tx_5m_avg, unique_buyers_60s, unique_buyers_baseline, buys_in_window, impact_now, impact_avg}
  const {tx_30s=0, tx_5m_avg=0, unique_buyers_60s=0, unique_buyers_baseline=0, buys_in_window=0, impact_now=0, impact_avg=0} = metrics;
  const reasons = [];
  if(tx_5m_avg>0 && tx_30s > DEFAULTS.TX_BURST_FACTOR * tx_5m_avg) reasons.push('tx_burst');
  if(unique_buyers_baseline>0 && unique_buyers_60s > unique_buyers_baseline * 1.5) reasons.push('unique_buyers_spike');
  if(buys_in_window >= DEFAULTS.MICRO_BUYS_THRESHOLD) reasons.push('micro_buys');
  if(impact_avg>0 && impact_now > DEFAULTS.IMPACT_FACTOR * impact_avg) reasons.push('impact_spike');

  const promote = reasons.length>0;
  if(promote){
    // use Redis locking / min interval via cache
    const lockKey = `preMomentumLock:${mintId}`;
    const lastKey = `preMomentumLast:${mintId}`;
    const MIN_INTERVAL_MS = 5000;
    const now = Date.now();
    const last = cacheGet(lastKey) || 0;
    if(now - last < MIN_INTERVAL_MS){
      return {promote:false, reasons:['rate_limited']};
    }
    // set last
    cacheSet(lastKey, now, 60); // 60s TTL
    hotQueue.promoteToHot(mintId, {metrics, reasons});
  }
  return {promote, reasons};
}

export default {evaluatePreMomentum};
