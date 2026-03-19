export function pushDebug(state, item, max = 100) {
  state.debug ||= {};
  state.debug.last ||= [];
  state.debug.last.push(item);
  if (state.debug.last.length > max) {
    state.debug.last = state.debug.last.slice(state.debug.last.length - max);
  }
}

export function getLastDebug(state, n = 20) {
  const arr = state?.debug?.last || [];
  const take = Math.max(1, Math.min(100, Number(n) || 20));
  return arr.slice(Math.max(0, arr.length - take));
}
