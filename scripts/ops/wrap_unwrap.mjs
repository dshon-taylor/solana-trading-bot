#!/usr/bin/env node
import fs from 'fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from '@solana/web3.js';
import { createAccount, getAccount, getOrCreateAssociatedTokenAccount, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, createTransferInstruction, closeAccount } from '@solana/spl-token';

const KEYPATH = './keys/offline/bot-keypair.2026-02-19T17-49-26Z.json';
const RPC = 'https://api.devnet.solana.com';

async function main(){
  const raw = JSON.parse(fs.readFileSync(KEYPATH,'utf8'));
  const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
  const conn = new Connection(RPC, 'confirmed');
  console.log('pubkey', kp.publicKey.toBase58());

  const lam = Math.round(0.01 * LAMPORTS_PER_SOL);
  console.log('Wrapping', lam, 'lamports (~0.01 SOL)');

  // Create temporary WSOL account by creating associated token account for WSOL mint
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';

  const ata = await getOrCreateAssociatedTokenAccount(conn, kp, new (await import('@solana/web3.js')).PublicKey(WSOL_MINT), kp.publicKey, false);
  console.log('WSOL ATA', ata.address.toBase58());

  // Fund ATA by transferring lamports to its account (createAccountWithSeed not needed). Use SystemProgram.transfer to ATA address.
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata.address, lamports: lam }),
  );

  const sig = await conn.sendTransaction(tx, [kp]);
  console.log('transfer sig', sig);
  await conn.confirmTransaction(sig, 'confirmed');

  // Now set the ATA's delegate? For WSOL, must set account's owner to token program; getOrCreateAssociatedTokenAccount already created token account and funded? Actually the usual pattern is create ATA then transfer lamports then syncNative; but spl-token provides wrapping by creating account with amount and calling syncNative. Simpler: use createWrappedNativeAccount from @solana/spl-token
}

main().catch(e=>{console.error(e); process.exit(1);});
