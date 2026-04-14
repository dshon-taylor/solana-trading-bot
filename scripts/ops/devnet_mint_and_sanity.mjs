import dotenv from 'dotenv';
import fs from 'fs';
// Load the trading-bot .env explicitly
dotenv.config({path: new URL('../.env', import.meta.url).pathname});

import {Connection, LAMPORTS_PER_SOL, Keypair, PublicKey} from '@solana/web3.js';
import {createMint, getOrCreateAssociatedTokenAccount, mintTo} from '@solana/spl-token';
import {loadKeypairFromEnv} from '../../src/wallet.mjs';
import {getConfig} from '../../src/config.mjs';
import {execSync} from 'child_process';

async function main(){
  // Allow loading keypair from env for this devnet operation
  process.env.ALLOW_WALLET_SECRET_KEY_ENV = 'true';
  // Load wallet secret from workspace key file
  process.env.WALLET_SECRET_KEY_JSON = await fs.promises.readFile(new URL('../keys/offline/bot-keypair.2026-02-19T17-49-26Z.json', import.meta.url).pathname, 'utf8');
  const cfg = getConfig();
  const keypair = loadKeypairFromEnv();
  const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
  const pk = keypair.publicKey;
  const bal = await conn.getBalance(pk);
  console.log('balance', bal / LAMPORTS_PER_SOL);
  if(bal < 0.05 * LAMPORTS_PER_SOL){
    console.log('requesting airdrop 0.1 SOL');
    let sig=null; let attempts=0; while(attempts<5){
      try{
        sig = await conn.requestAirdrop(pk, 0.1 * LAMPORTS_PER_SOL);
        await conn.confirmTransaction(sig, 'confirmed');
        console.log('airdrop done', sig);
        break;
      }catch(e){
        attempts++; console.log('airdrop attempt failed', attempts, e.message);
        await new Promise(r=>setTimeout(r, 2000));
      }
    }
    if(!sig) throw new Error('Airdrop failed after retries');
  }
  // create mint
  const mintAuthority = keypair.publicKey;
  const freezeAuthority = null;
  const decimals = 6;
  console.log('creating mint...');
  const mint = await createMint(conn, keypair, mintAuthority, freezeAuthority, decimals);
  console.log('mint created', mint.toBase58());
  // create ata
  const ata = await getOrCreateAssociatedTokenAccount(conn, keypair, mint, pk);
  console.log('ata', ata.address.toBase58());
  // mint 1000 units (considering decimals)
  const amount = 1000 * (10 ** decimals);
  const mSig = await mintTo(conn, keypair, mint, ata.address, keypair.publicKey, amount);
  console.log('mintTo sig', mSig);
  // run manual sanity swap with env overrides
  const env = Object.assign({}, process.env, {
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    USDC_MINT: mint.toBase58(),
    JUPITER_ONLY_DIRECT: 'true'
  });
  console.log('running manual_sanity_swap.mjs');
  try{
    const out = execSync('node scripts/ops/manual_sanity_swap.mjs', {cwd: process.cwd(), env, stdio: 'pipe'}).toString();
    console.log('script output:\n', out);
  }catch(e){
    console.error('manual script failed', e.stdout && e.stdout.toString(), e.stderr && e.stderr.toString());
  }
}

main().catch(e=>{console.error(e); process.exit(1)});
