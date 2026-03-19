// CU budget monitor stub
let cuBudgetDaily = parseInt(process.env.BIRDEYE_CU_BUDGET_DAILY||'10000');
let consumed = 0;
export function record(cost){ consumed += cost; }
export function shouldThrottle(){
  // simplistic: throttle if consumed > 80% of budget
  return consumed > cuBudgetDaily*0.8;
}
export function getConsumed(){ return consumed; }
