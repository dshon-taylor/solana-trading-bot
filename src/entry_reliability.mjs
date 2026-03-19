export function didEntryFill(entryRes) {
  return !!(entryRes?.signature || entryRes?.entryTx);
}
