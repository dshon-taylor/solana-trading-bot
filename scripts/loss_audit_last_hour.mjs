import fs from 'fs';
import path from 'path';

const root = path.resolve(process.cwd());
const tradesPath = path.join(root, 'state', 'trades.jsonl');
const statePath = path.join(root, 'state', 'state.json');

function readLines(file){
  return fs.existsSync(file) ? fs.readFileSync(file,'utf8').split(/\n/).filter(Boolean) : [];
}

const now = new Date();
const oneHourAgo = new Date(now.getTime() - 60*60*1000);

const lines = readLines(tradesPath);
const exits = lines.map(l=>{
  try{return JSON.parse(l);}catch(e){return null}
}).filter(Boolean).filter(r=>r.kind==='exit');

const lastHour = exits.filter(e=>{
  const t = new Date(e.exitAt || e.time || e.t_audit);
  return t >= oneHourAgo && t <= now;
});

const closedLastHour = lastHour.length;
const wins = lastHour.filter(e=>typeof e.pnlPct==='number' && e.pnlPct>0).length;
const losses = lastHour.filter(e=>typeof e.pnlPct==='number' && e.pnlPct<=0).length;
const bigLosses = lastHour.filter(e=>typeof e.pnlPct==='number' && e.pnlPct<=-0.10).length;

function avg(arr){return arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0}
function median(arr){if(!arr.length) return 0; const s=arr.slice().sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2}

const pnls = lastHour.map(e=>('pnlPct' in e)?e.pnlPct:(e.pnlUsdApprox||0));
const avgPnl = avg(pnls);
const medianPnl = median(pnls);

// exitReason counts
const exitReasonCounts = {};
for(const e of lastHour){
  const r = e.exitReason || e.exitReason || (e.exitReasonText||e.exitReason||'unknown');
  exitReasonCounts[r] = (exitReasonCounts[r]||0)+1;
}

// worst 10 exits by pnlPct (lowest)
const worst = lastHour.slice().sort((a,b)=>{
  const ap = (typeof a.pnlPct==='number')?a.pnlPct:(a.pnlUsdApprox||0);
  const bp = (typeof b.pnlPct==='number')?b.pnlPct:(b.pnlUsdApprox||0);
  return ap - bp;
}).slice(0,10).map(e=>({
  mint:e.mint, symbol:e.symbol, entry:e.entryPriceUsd, exit:e.exitPriceUsd, pnlPct:e.pnlPct, pnlUsd:e.pnlUsdApprox, holdMinutes: (e.entryAt && e.exitAt)?((new Date(e.exitAt)-new Date(e.entryAt))/60000):null, reason:e.exitReason
}));

// open positions count and % currently below entry
let openCount=0; let belowEntry=0;
if(fs.existsSync(statePath)){
  const state = JSON.parse(fs.readFileSync(statePath,'utf8'));
  const posMap = state.positions||{};
  const keys = Object.keys(posMap);
  for(const k of keys){
    const p = posMap[k];
    if(p.status && p.status==='open' || (!p.status && (!p.exitAt))){
      openCount++;
      const lastSeen = p.lastSeenPriceUsd;
      const entry = p.entryPriceUsd;
      if(typeof lastSeen==='number' && typeof entry==='number' && lastSeen < entry) belowEntry++;
    }
  }
}
const openBelowPct = openCount? (belowEntry/openCount):0;

const out = {
  generatedAt: now.toISOString(),
  windowStart: oneHourAgo.toISOString(),
  closedLastHour, wins, losses, bigLosses, avgPnl, medianPnl,
  exitReasonCounts,
  worst,
  openPositions:{count:openCount, belowEntryCount:belowEntry, belowEntryPct: openBelowPct}
};

const analysisDir = path.join(root,'analysis');
if(!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir,{recursive:true});
const outPath = path.join(analysisDir,'loss_audit_latest.json');
fs.writeFileSync(outPath, JSON.stringify(out,null,2));
console.log(outPath);
