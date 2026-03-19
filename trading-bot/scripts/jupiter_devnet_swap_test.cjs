#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const dotenv = require("dotenv");
const { Connection, Keypair, VersionedTransaction, PublicKey } = require("@solana/web3.js");
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } = require("@solana/spl-token");

const LOG_PATH = "/tmp/jupiter_swap_run.log";
const LEDGER_PATH = "trading-bot/state/trades.jsonl";

function logLine(s) {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch {}
}

function appendLedger(obj) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(obj) + "\n");
}

dotenv.config({ path: "trading-bot/.env" });

const RPC = process.env.SOLANA_RPC_URL || "";
const API_KEY = process.env.JUPITER_API_KEY || "";
const SOPS_WALLET_FILE = process.env.SOPS_WALLET_FILE || "";

if (!RPC.includes("devnet")) {
  logLine("STATUS:BLOCKED");
  logLine("NEXT_STEP:Set SOLANA_RPC_URL to a devnet RPC in trading-bot/.env");
  process.exit(1);
}
if (!API_KEY) {
  logLine("STATUS:BLOCKED");
  logLine("NEXT_STEP:Set JUPITER_API_KEY in trading-bot/.env and restart with --update-env if using PM2");
  process.exit(1);
}
if (!SOPS_WALLET_FILE || !fs.existsSync(SOPS_WALLET_FILE)) {
  logLine("STATUS:BLOCKED");
  logLine("NEXT_STEP:Set SOPS_WALLET_FILE to a decrypted JSON keypair file path");
  process.exit(1);
}

const connection = new Connection(RPC, "confirmed");
const secret = Uint8Array.from(JSON.parse(fs.readFileSync(SOPS_WALLET_FILE, "utf8")));
const wallet = Keypair.fromSecretKey(secret);

const JUP_BASE = "https://api.jup.ag/swap/v1";

// mints
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
// devnet USDC mint
const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

async function jup(url, opts = {}) {
  const headers = Object.assign(
    { "Content-Type": "application/json", "x-api-key": API_KEY },
    opts.headers || {}
  );
  const headerNames = Object.keys(headers);
  logLine(`JUPITER_REQUEST headers=${headerNames.join(",")}`);

  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();

  if (!res.ok) {
    logLine(`JUPITER_HTTP ${res.status}`);
    logLine(`JUPITER_BODY ${text.slice(0, 5000)}`);
    throw new Error(`Jupiter non-200: ${res.status}`);
  }
  return JSON.parse(text);
}

async function ensureAtaIx(mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false);
  const info = await connection.getAccountInfo(ata);
  if (info) return { ata, ix: null };

  const ix = createAssociatedTokenAccountInstruction(
    owner,     // payer
    ata,       // ata
    owner,     // owner
    mint
  );
  return { ata, ix };
}

(async () => {
  const start = Date.now();
  logLine(`Wallet=${wallet.publicKey.toBase58()}`);

  // amount 0.01 SOL in lamports
  const amount = 10_000_000;

  // Precreate USDC ATA (WSOL ATA is typically handled by Jupiter with wrapping, but USDC destination often needs to exist)
  logLine("PLAN ensure output ATA exists");
  const { ata: usdcAta, ix: usdcAtaIx } = await ensureAtaIx(USDC_DEVNET, wallet.publicKey);

  // Get quote (ExactIn)
  logLine("PLAN quote");
  const quoteUrl =
    `${JUP_BASE}/quote` +
    `?inputMint=${WSOL.toBase58()}` +
    `&outputMint=${USDC_DEVNET.toBase58()}` +
    `&amount=${amount}` +
    `&slippageBps=50` +
    `&asLegacyTransaction=true`;

  let quote;
  try {
    quote = await jup(quoteUrl, { method: "GET" });
  } catch (e) {
    logLine("STATUS:BLOCKED");
    logLine("NEXT_STEP:If 401, confirm x-api-key is set in env for this run and that you are using api.jup.ag/swap/v1 endpoints");
    process.exit(1);
  }

  if (!quote || !quote.routePlan || quote.routePlan.length === 0) {
    logLine("STATUS:BLOCKED");
    logLine("NEXT_STEP:No route found on devnet. Devnet liquidity is often thin. Try a different output token or accept running the test on mainnet with tiny amount.");
    process.exit(1);
  }

  // Ask Jupiter for swap transaction
  logLine("EXECUTE swap request");
  const swapBody = {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    asLegacyTransaction: true,
  };

  const swap = await jup(`${JUP_BASE}/swap`, {
    method: "POST",
    body: JSON.stringify(swapBody),
  });

  if (!swap || !swap.swapTransaction) {
    logLine("STATUS:BLOCKED");
    logLine("NEXT_STEP:Jupiter did not return swapTransaction. Check /tmp/jupiter_swap_run.log for response body.");
    process.exit(1);
  }

  // Deserialize the tx (Jupiter returns base64)
  const txBuf = Buffer.from(swap.swapTransaction, "base64");
  const vtx = VersionedTransaction.deserialize(txBuf);

  // If we need to create the USDC ATA, do it first in a separate tx to keep things simple and avoid large tx size.
  if (usdcAtaIx) {
    logLine("UTILITY creating missing USDC ATA");
    const { TransactionMessage } = require("@solana/web3.js");
    const latest = await connection.getLatestBlockhash("confirmed");

    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [usdcAtaIx],
    }).compileToV0Message(); // This is fine for ATA create, but you asked to avoid ALTs. This does not use ALTs.
    const ataTx = new VersionedTransaction(msg);
    ataTx.sign([wallet]);

    const simAta = await connection.simulateTransaction(ataTx);
    if (simAta.value.err) {
      logLine("STATUS:BLOCKED");
      logLine("NEXT_STEP:ATA create simulation failed. Check /tmp/jupiter_swap_run.log and RPC health.");
      process.exit(1);
    }
    const sigAta = await connection.sendTransaction(ataTx);
    await connection.confirmTransaction(sigAta, "finalized");
    logLine(`ATA_CREATED sig=${sigAta}`);
  }

  // Sign Jupiter swap tx
  vtx.sign([wallet]);

  // Simulate
  logLine("UTILITY simulate swap");
  const sim = await connection.simulateTransaction(vtx);
  if (sim.value.err) {
    logLine("STATUS:BLOCKED");
    logLine(`NEXT_STEP:Simulation failed: ${JSON.stringify(sim.value.err).slice(0, 1200)}`);
    process.exit(1);
  }

  // Send
  logLine("EXECUTE send swap");
  const sig = await connection.sendTransaction(vtx, { skipPreflight: false, preflightCommitment: "confirmed" });
  await connection.confirmTransaction(sig, "finalized");

  // Verify balances
  const solBal = await connection.getBalance(wallet.publicKey);
  let usdcUi = null;
  try {
    const parsed = await connection.getParsedAccountInfo(usdcAta);
    usdcUi = parsed?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
  } catch { usdcUi = null; }

  appendLedger({
    ts: new Date().toISOString(),
    kind: "devnet_swap_test",
    sig,
    rpc: RPC,
    wallet: wallet.publicKey.toBase58(),
    input: { mint: WSOL.toBase58(), amount },
    output: { mint: USDC_DEVNET.toBase58(), ata: usdcAta.toBase58(), uiAmount: usdcUi },
    solBalanceLamports: solBal,
    ms: Date.now() - start
  });

  logLine(`STATUS:DONE sig=${sig}`);
})().catch((e) => {
  logLine(`STATUS:BLOCKED`);
  logLine(`NEXT_STEP:${e.message}`);
  process.exit(1);
});
