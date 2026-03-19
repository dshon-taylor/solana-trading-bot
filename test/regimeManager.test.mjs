import RegimeManager, { MODES } from '../src/services/regimeManager.mjs';

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

async function runUnitTests() {
  console.log('UNIT: testing normalization and scoring...');
  const rm = new RegimeManager({ logger: console });
  rm.updateMetrics({ confirmRate10m: 0.8, runnerRate30m: 0.05, snapshotBlockRate10m: 0.01, winRate30m: 0.2, marketHeat10m: 0.2 });
  const { score, normalized } = rm.computeScore();
  assert(score >= 0 && score <= 1, 'score out of range');
  assert(normalized.confirmRate10m <= 1 && normalized.confirmRate10m >= 0);
  console.log('UNIT: pass');
}

async function runHysteresisIntegration() {
  console.log('INT: testing hysteresis and transitions...');
  const logs = [];
  const rm = new RegimeManager({ logger: { info: (m)=>logs.push(m) } });

  rm.on('modeChange', ({mode, score}) => {
    logs.push(`EMIT:${mode}:${score}`);
  });

  // start in BALANCED
  assert(rm.getMode() === MODES.BALANCED, 'initial mode not BALANCED');

  // Feed metrics that should push toward DEFENSE for 3 checks
  const defenseMetrics = { confirmRate10m: 0.1, runnerRate30m: 0.01, snapshotBlockRate10m: 0.0, winRate30m: 0.05, marketHeat10m: 0.1 };
  for (let i=0;i<3;i++) { rm.updateMetrics(defenseMetrics); rm._computeAndApply(); }
  assert(rm.getMode() === MODES.DEFENSE, 'did not switch to DEFENSE after 3 checks');

  // Now metrics pushing AGGRESSIVE - but with runner floor to ensure aggressive allowed
  const aggressiveMetrics = { confirmRate10m: 0.9, runnerRate30m: 0.16, snapshotBlockRate10m: 0.0, winRate30m: 0.9, marketHeat10m: 0.9 };
  for (let i=0;i<3;i++) { rm.updateMetrics(aggressiveMetrics); rm._computeAndApply(); }
  assert(rm.getMode() === MODES.AGGRESSIVE, 'did not switch to AGGRESSIVE after 3 checks');

  console.log('INT: pass');
}

(async ()=>{
  try{
    await runUnitTests();
    await runHysteresisIntegration();
    console.log('ALL TESTS PASSED');
  }catch(e){
    console.error('TEST FAILED', e);
    process.exitCode = 2;
  }
})();
