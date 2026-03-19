// Redis-backed snapshot cache (stub)
import {createClient} from 'redis';

const client = createClient({url: process.env.REDIS_URL || 'redis://127.0.0.1:6379'});
client.connect().catch(()=>{});

export async function get(key){
  try{ const v = await client.get(key); return v?JSON.parse(v):null;}catch(e){return null}
}
export async function set(key, val, ttlMs){
  try{ await client.set(key, JSON.stringify(val), {PX: ttlMs}); }catch(e){}
}
export default client;
