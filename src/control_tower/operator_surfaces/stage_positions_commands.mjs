import { getTokenHoldingsByMint } from '../../portfolio.mjs';
import { getLastDebug } from '../../observability/debug_buffer.mjs';
import { nowIso, safeErr } from '../../core/logger.mjs';

export async function handlePositionsCommands(ctx) {
  const { cfg, state, conn, pub, tgSend, sendPositionsReport } = ctx;

  if (state.flags?.sendPositions) {
    state.flags.sendPositions = false;
    await sendPositionsReport();
  }

  if (state.flags?.sendOpencheck) {
    state.flags.sendOpencheck = false;
    try {
      const openRows = Object.entries(state.positions || {}).filter(([, p]) => p?.status === 'open');
      const stateOpen = openRows.length;
      const onchain = await getTokenHoldingsByMint(conn, pub);
      const onchainOpen = Array.from(onchain.values()).filter((amt) => Number(amt || 0) > 0).length;
      const exitPending = openRows.filter(([, p]) => !!p?.exitPending).length;
      const hotQueuePending = Array.isArray(state?.watchlist?.hotQueue) ? state.watchlist.hotQueue.length : 0;
      const mintBacklog = state?.watchlist?.mints && typeof state.watchlist.mints === 'object'
        ? Object.keys(state.watchlist.mints).length
        : 0;

      await tgSend(cfg, [
        '🔎 *Open Check*',
        `🕒 ${nowIso()}`,
        `• state open positions: ${stateOpen}`,
        `• on-chain token holdings (>0): ${onchainOpen}`,
        `• delta (state - onchain): ${stateOpen - onchainOpen}`,
        `• exitPending: ${exitPending}`,
        `• watchlist hot queue: ${hotQueuePending}`,
        `• watchlist tracked mints: ${mintBacklog}`,
      ].join('\n'));
    } catch (e) {
      await tgSend(cfg, `Opencheck error: ${safeErr(e).message}`);
    }
  }

  if (state.flags?.sendLast) {
    const n = state.flags.sendLast;
    delete state.flags.sendLast;
    const items = getLastDebug(state, n);
    if (!items.length) {
      await tgSend(cfg, 'Last candidates: none recorded yet');
    } else {
      const lines = items.map((it) => {
        const sym = it.symbol ? String(it.symbol) : '???';
        const mint = it.mint ? String(it.mint) : '';
        const r = it.reason || '';
        const extra = [];
        if (it.liqUsd != null) extra.push(`💧${Math.round(it.liqUsd)}`);
        if (it.mcapUsd != null) extra.push(`🧢${Math.round(it.mcapUsd)}`);
        if (it.rugScore != null) extra.push(`🛡️${it.rugScore}`);
        if (it.tx1h != null) extra.push(`🔁${it.tx1h}`);
        if (it.pc1h != null) extra.push(`📈${it.pc1h}`);
        return `• ${sym} (${mint.slice(0, 6)}…) — ${r}${extra.length ? `  [${extra.join(' ')}]` : ''}`;
      });
      const chunkSize = 25;
      for (let i = 0; i < lines.length; i += chunkSize) {
        await tgSend(cfg, `🧪 *Last candidates* (newest last)\n\n` + lines.slice(i, i + chunkSize).join('\n'));
      }
    }
  }
}
