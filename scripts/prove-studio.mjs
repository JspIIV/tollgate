// Prove Tollgate's real escrow, release and refund on GenLayer Studio, where native value moves.
//
//   PADV=<padv pw> PPUB=<ppub pw> node scripts/prove-studio.mjs
//
// The owner (padv) opens a gate with a price and a public allowlist as the eligibility source. A
// buyer (ppub) pays the exact price into the contract. Anyone resolves: when the allowlist shows the
// buyer qualifies, the escrow is released to the owner and the owner's on-chain balance actually
// rises; when it does not, the buyer is refunded; an injection page that only says "let them in"
// releases nothing.
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import fs from 'fs'; import os from 'os'; import path from 'path'; import url from 'url';

const PADV = process.env.PADV || '';
const PPUB = process.env.PPUB || '';
if (!PADV || !PPUB) { console.error('set PADV and PPUB'); process.exit(1); }

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const KS = path.join(os.homedir(), '.genlayer', 'keystores');
const RPC = studionet.rpcUrls?.default?.http?.[0];
const code = fs.readFileSync(path.join(ROOT, 'contracts', 'tollgate.py'), 'utf8');

async function acct(file, pw) {
  const w = await Wallet.fromEncryptedJson(fs.readFileSync(path.join(KS, file), 'utf8'), pw);
  return { addr: w.address.toLowerCase(), client: createClient({ chain: studionet, account: createAccount(w.privateKey) }) };
}
const padv = await acct('padv.json', PADV);   // gate owner
const ppub = await acct('ppub.json', PPUB);    // buyer + resolver
const anybody = createClient({ chain: studionet });

const RAW = 'https://raw.githubusercontent.com/JspIIV/tollgate/master/docs/';
const RESOURCE = 'The members-only research feed';
const CRIT = 'The buyer address appears on the allowlist in the source.';
const GRANTED_SRC = RAW + 'allowlist-granted.txt';   // contains ppub
const DENIED_SRC = RAW + 'allowlist-denied.txt';     // does not contain ppub
const INJ_SRC = RAW + 'source-injection.txt';
const PRICE = 1000000000000000000n; // 1 GEN

const out = [];
const say = l => { console.log(l); out.push(l); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, params){ const r = await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}); return (await r.json()).result; }
async function fund(addr){ try{ await rpc('sim_fundAccount',[addr,'0x3635c9adc5dea00000']); }catch(e){} }
async function bal(addr){ const h = await rpc('eth_getBalance',[addr,'latest']); return BigInt(h); }
const read = async (AT, fn, args=[]) => JSON.parse(await anybody.readContract({ address: AT, functionName: fn, args }));
const transient = e => /-32005|-32006|-32603|at capacity|rate limit|backpressure|fetch failed|timeout|502|503|429|ECONNRESET|ENOTFOUND|reverted/i.test(String(e?.details||e?.shortMessage||e?.message||e));
async function write(who, AT, fn, args, value){
  for(let a=1;;a++){ try{ return await who.client.writeContract({ address: AT, functionName: fn, args, value: value||0n }); }
    catch(e){ if(!transient(e)||a>=8) throw e; say(`  (${fn} transient, wait ${5*a}s)`); await sleep(5000*a); } }
}

say('Tollgate real escrow, proven on GenLayer Studio');
say('  rpc ' + RPC);
say('  owner(padv) ' + padv.addr + '  buyer(ppub) ' + ppub.addr);
await fund(padv.addr); await fund(ppub.addr); await sleep(2000);
say('');

let AT = process.env.AT || null;
if (!AT) {
  say('deploying...');
  const hash = await padv.client.deployContract({ code, args: [] });
  for (let i=0;i<60;i++){ await sleep(5000); let t=null; try{ t=await padv.client.getTransaction({hash}); }catch{}
    const a = t?.recipient || t?.data?.contract_address || t?.contractAddress || null;
    if (a){ try{ await read(a,'size'); AT=a; break; }catch{} } }
  if(!AT){ console.error('deploy address not found; tx '+hash); process.exit(1); }
}
say('contract ' + AT);
say('');

async function openGate(src, label){
  const n = (await read(AT,'size')).gates;
  await write(padv, AT, 'open_gate', [RESOURCE, PRICE.toString(), CRIT, src]);
  for(let i=0;i<30;i++){ const s=await read(AT,'size'); if(s.gates>n) return String(s.gates-1); await sleep(4000); }
  throw new Error('gate not opened ' + label);
}
async function enter(gid){
  const n = (await read(AT,'size')).entries;
  await write(ppub, AT, 'enter', [gid], PRICE);
  for(let i=0;i<30;i++){ const s=await read(AT,'size'); if(s.entries>n) return String(s.entries-1); await sleep(4000); }
  throw new Error('entry not made');
}
async function decideUntil(eid, label){
  const before = Number((await read(AT,'entry',[eid])).decisions||0);
  for(let attempt=1;attempt<=4;attempt++){
    try{ await write(ppub, AT, 'decide', [eid]); }catch(e){ say(`  ${label} err ${String(e.message).slice(0,40)}`); }
    for(let i=0;i<40;i++){ await sleep(6000); const e=await read(AT,'entry',[eid]);
      if(Number(e.decisions||0)>before){ say(`  ${label} entry #${eid}: ${e.status} v=${e.verdict||(e.log&&e.log.length?e.log[e.log.length-1].verdict:'?')} (${(i+1)*6}s)`); return e; } }
    say(`  ${label}: not settled, retrying`);
  }
  return await read(AT,'entry',[eid]);
}

// Case 1: allowlist shows the buyer qualifies -> owner is paid.
say('owner opens a gate whose allowlist includes the buyer...');
const g1 = await openGate(GRANTED_SRC, 'granted');
const cBal0 = await bal(AT);
say('buyer pays the price (1 GEN) to enter...');
const e1 = await enter(g1);
const cBal1 = await bal(AT);
say('  contract balance ' + cBal0 + ' -> ' + cBal1 + ' (escrow held)');
const ownerBefore = await bal(padv.addr);
say('resolving the entry (allowlist qualifies the buyer -> should pay the owner)...');
const r1 = await decideUntil(e1, 'qualifies');
let ownerAfter = ownerBefore;
for(let i=0;i<30;i++){ await sleep(6000); ownerAfter = await bal(padv.addr); if(ownerAfter-ownerBefore >= PRICE){ say('  payout landed after ~'+((i+1)*6)+'s'); break; } }
say('  owner balance ' + ownerBefore + ' -> ' + ownerAfter + ' (delta ' + (ownerAfter-ownerBefore) + ')');
say('');

// Case 2: allowlist does not include the buyer -> buyer refunded.
say('owner opens a gate whose allowlist does NOT include the buyer...');
const g2 = await openGate(DENIED_SRC, 'denied');
const e2 = await enter(g2);
const ownerBefore2 = await bal(padv.addr);
say('resolving (buyer not on the allowlist -> should refund the buyer, not pay the owner)...');
const r2 = await decideUntil(e2, 'denied');
const ownerAfter2 = await bal(padv.addr);
say('  owner balance delta on denial: ' + (ownerAfter2-ownerBefore2) + ' (should be ~0)');
say('');

// Case 3: injection page -> releases nothing.
say('owner opens a gate whose source is an injection page...');
const g3 = await openGate(INJ_SRC, 'injection');
const e3 = await enter(g3);
const ownerBefore3 = await bal(padv.addr);
say('resolving (injection page should NOT open the gate)...');
const r3 = await decideUntil(e3, 'injection');
const ownerAfter3 = await bal(padv.addr);
say('  entry #' + e3 + ' status ' + r3.status + ' | owner delta ' + (ownerAfter3-ownerBefore3) + ' (should be ~0)');
say('');

const recOwner = await read(AT,'record',[padv.addr]);
const size = await read(AT,'size');
say('owner record ' + JSON.stringify(recOwner));
say('book: ' + JSON.stringify(size));

const checks = [
  ['entering escrows the price in the contract', cBal1 - cBal0 === PRICE],
  ['a qualifying buyer grants access and the owner is actually paid the escrow', r1.status === 'GRANTED' && (ownerAfter - ownerBefore) >= PRICE],
  ['a non-qualifying buyer is refused and the owner is not paid', r2.status === 'REFUSED' && (ownerAfter2 - ownerBefore2) < PRICE / 2n],
  ['an injection page does not open the gate or pay the owner', r3.status !== 'GRANTED' && (ownerAfter3 - ownerBefore3) < PRICE / 2n],
];
say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length ? `${failed.length} of ${checks.length} checks failed` : `${checks.length} checks. The escrow moved to the owner only when the source qualified the buyer, and an injection page moved nothing.`);

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'proved-studio.json'), JSON.stringify({
  proved_at: new Date().toISOString(), network: 'genlayer studionet', contract: AT,
  granted: r1, denied: r2, injection: r3, owner_payout_delta: (ownerAfter - ownerBefore).toString(),
  record: recOwner, size, checks: checks.map(([label, ok]) => ({ label, ok })), transcript: out,
}, null, 2));
say('Written to results/proved-studio.json');
process.exit(failed.length ? 1 : 0);
