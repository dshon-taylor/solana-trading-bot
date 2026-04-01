import { makeCounters } from '../../observability/metrics.mjs';

export function initializeDiagCounters({ state }) {
  state.runtime ||= {};
  const counters = (state.runtime.diagCounters && typeof state.runtime.diagCounters === 'object')
    ? state.runtime.diagCounters
    : makeCounters();
  state.runtime.diagCounters = counters;
  return counters;
}
