import cache from '../global_cache.mjs';

const DEFAULT = {
  HOT_TTL_MS: 5*60*1000,
  HOT_SAMPLE_MS: 700,
  CONFIRM_SAMPLE_MS: 300,
  LIMIT_PER_MIN: 120,
  PER_MINT_LIMIT_PER_MIN: 6,
  TOP_N: 5
};

const hotMap = new Map(); // mintId -> {promotedAt, ttl, priorityScore}
const promotionsLog = []; // rolling promotions {mint, ts}

function score(metrics={}){
  return (metrics.tx_30s||0) + (metrics.unique_buyers_60s||0) + (metrics.volume||0);
}

function prunePromotions(now){
  const cutoff = now - 60_000;
  while(promotionsLog.length && promotionsLog[0].ts < cutoff) promotionsLog.shift();
}

export function promoteToHot(mintId, {metrics,reasons}={}){
  if(hotMap.has(mintId)) return false;
  const now = Date.now();
  prunePromotions(now);

  // Global per-minute promotion limit
  const recentPromotions = promotionsLog.filter(p => (now - p.ts) < 60_000).length;
  if (recentPromotions >= DEFAULT.LIMIT_PER_MIN) {
    console.log(`[hotQueue] promotion rate-limited global limit reached (${recentPromotions}/min)`);
    return false;
  }

  // Per-mint limit
  const perMintCount = promotionsLog.filter(p => p.mint === mintId && (now - p.ts) < 60_000).length;
  if (perMintCount >= DEFAULT.PER_MINT_LIMIT_PER_MIN) {
    console.log(`[hotQueue] promotion rate-limited for ${mintId} (per-min=${perMintCount})`);
    return false;
  }

  const entry = {promotedAt:now, expiresAt: now+DEFAULT.HOT_TTL_MS, metrics, reasons, sampleMs:DEFAULT.HOT_SAMPLE_MS, confirmSampleMs:DEFAULT.CONFIRM_SAMPLE_MS, priorityScore:score(metrics)};
  hotMap.set(mintId, entry);
  cache.set(`hot:${mintId}`, entry, Math.ceil(DEFAULT.HOT_TTL_MS/1000));
  maintainTopN();
  // hook BirdEye WS subscription - write flag into cache for other service
  cache.set(`birdeye:sub:${mintId}`, true, Math.ceil(DEFAULT.HOT_TTL_MS/1000));

  // record promotion in rolling log
  promotionsLog.push({mint: mintId, ts: now});
  console.log(`[hotQueue] promoted ${mintId} reasons=${reasons}`);
  return true;
}

export function demote(mintId){
  if(!hotMap.has(mintId)) return false;
  hotMap.delete(mintId);
  cache.del(`hot:${mintId}`);
  cache.del(`birdeye:sub:${mintId}`);
  console.log(`[hotQueue] demoted ${mintId}`);
  return true;
}

export function maintainTopN(){
  // sort by priorityScore desc
  const arr = Array.from(hotMap.entries());
  arr.sort((a,b)=> (b[1].priorityScore||0)-(a[1].priorityScore||0));
  const top = arr.slice(0, DEFAULT.TOP_N).map(x=>x[0]);
  cache.set('hot:top', top, 60);
  // demote extras beyond TOP_N by reducing sample rate
  arr.slice(DEFAULT.TOP_N).forEach(([mintId,entry])=>{
    entry.sampleMs = Math.max(entry.sampleMs, 2000);
  });
}

export function getHotList(){
  return Array.from(hotMap.keys());
}

export function tickHousekeeping(){
  const now = Date.now();
  // prune promotions log
  prunePromotions(now);
  for(const [mintId,entry] of hotMap.entries()){
    if(now > entry.expiresAt){
      // demote if not confirmed
      demote(mintId);
    }
  }
}

export default {promoteToHot,demote,maintainTopN,getHotList,tickHousekeeping};
