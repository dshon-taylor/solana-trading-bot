export function runMainWithFatalReporting({
  main,
  getConfig,
  safeErr,
  tgSend,
}) {
  main().catch(async (e) => {
    const cfg = (() => {
      try { return getConfig(); } catch { return null; }
    })();
    console.error('[fatal]', safeErr(e));
    if (cfg) await tgSend(cfg, `❌ Bot crashed: ${safeErr(e).message}`);
    process.exit(1);
  });
}
