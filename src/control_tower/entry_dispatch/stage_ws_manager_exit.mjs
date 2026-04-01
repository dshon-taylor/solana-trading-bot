import { saveState } from '../../persistence/state.mjs';

export function bindWsManagerExitHandler({
  wsmgr,
  state,
  cfg,
  conn,
  wallet,
  getSplBalance,
  executeSwap,
  getSolUsdPrice,
  closePosition,
  safeErr,
}) {
  wsmgr.on('exit', async ({ mint, price, reason, chunked }) => {
    try {
      const pair = state.positions[mint] ? { priceUsd: state.positions[mint].lastSeenPriceUsd } : null;
      if (chunked) {
        try {
          const pos = state.positions[mint];
          const bal = await getSplBalance(conn, wallet.publicKey.toBase58(), mint);
          const amountRaw = Number(bal.amount || 0);
          if (amountRaw > 0) {
            const chunks = [0.35, 0.35, 0.30];
            let remaining = amountRaw;
            const startMs = Date.now();
            let anySuccess = false;
            for (let i = 0; i < chunks.length; i += 1) {
              if (remaining <= 0) break;
              const take = Math.max(1, Math.round(amountRaw * chunks[i]));
              const submitMs = Date.now();
              try {
                const res = await executeSwap({
                  conn,
                  wallet,
                  inputMint: mint,
                  outputMint: cfg.SOL_MINT,
                  inAmountBaseUnits: take,
                  slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
                });
                try {
                  const d = wsmgr.diag && wsmgr.diag[mint];
                  if (d && d.triggerAtMs) d.trigger_to_order_ms = (submitMs - d.triggerAtMs);
                  if (d) {
                    d.order_to_fill_ms = Date.now() - submitMs;
                    const triggerP = Number(d.trigger_price || 0) || price || null;
                    const soldTokens = Number(res?.fill?.inAmountRaw || 0) / (10 ** (res?.fill?.inDecimals || pos?.decimals || 0));
                    const outSolRaw = Number(res?.fill?.outAmountRaw || 0);
                    const outSol = outSolRaw > 0 ? (outSolRaw / 1e9) : null;
                    const solUsd = (await getSolUsdPrice()).solUsd || null;
                    if (triggerP && soldTokens && outSol && solUsd) {
                      const exitPriceUsd = (outSol * solUsd) / soldTokens;
                      d.slippage_vs_trigger_price_pct = ((exitPriceUsd - triggerP) / triggerP) * 100;
                    }
                  }
                } catch {}
                anySuccess = true;
                remaining = Math.max(0, remaining - take);
                await new Promise((r) => setTimeout(r, 80));
                if (Date.now() - startMs > 1000) break;
              } catch {
                break;
              }
            }
            if (!anySuccess || (Date.now() - startMs) > 1000) {
              await closePosition(cfg, conn, wallet, state, mint, pair, `ws_exit:${reason?.rule || 'auto'}:fallback`);
            } else {
              const finalBal = await getSplBalance(conn, wallet.publicKey.toBase58(), mint);
              if (!finalBal || Number(finalBal.amount || 0) <= 0) {
                try {
                  state.positions[mint].status = 'closed';
                  state.positions[mint].exitAt = new Date().toISOString();
                } catch {}
              } else {
                await closePosition(cfg, conn, wallet, state, mint, pair, `ws_exit:${reason?.rule || 'auto'}:post_chunks`);
              }
            }
            saveState(cfg.STATE_PATH, state);
            return;
          }
        } catch (e) {
          console.warn('[wsmgr glue] chunked exit attempt failed', safeErr(e));
        }
      }

      await closePosition(cfg, conn, wallet, state, mint, pair, `ws_exit:${reason?.rule || 'auto'}${chunked ? ':chunked' : ''}`);
      saveState(cfg.STATE_PATH, state);
    } catch (e) {
      console.error('[wsmgr glue] exit handler err', safeErr(e));
    }
  });
}
