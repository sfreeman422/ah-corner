#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
port=39091
MODE=demo DATABASE_URL= DATA_DIR="$work" PORT="$port" HOST=127.0.0.1 node --experimental-strip-types src/server.ts >"$work/server.log" 2>&1 &
pid=$!
cleanup(){ kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT
for _ in $(seq 1 50); do if curl -fsS "http://127.0.0.1:$port/api/status" > /dev/null 2>&1; then break; fi; sleep .2; done
PORT="$port" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const root=`http://127.0.0.1:${process.env.PORT}`;
const base=`${root}/api/`;
async function req(path,body){const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,`${path}: ${r.status}`);return r.json();}
const s=await req('status');assert.equal(s.mode,'demo');assert.equal(s.snapshots,13);assert.equal(s.collector.busy,false);
assert.equal((await fetch(`${root}/livez`)).status,200);assert.equal((await fetch(`${root}/readyz`)).status,200);
const {rows}=await req('opportunities?bankroll=35&roi=30');assert.ok(rows.length>0);assert.ok(rows.every(r=>r.cost<=122500));
assert.ok((await req(`history?id=${rows[0].itemId}`)).length>0);
assert.ok(Array.isArray(await req('backtest')));assert.deepEqual(await req('alerts'),[]);
await req('watch',{itemId:4402});assert.ok((await req('status')).watch.includes(4402));
const stamp=Math.floor(Date.now()/1000);const text=`AHCornerJournal = {records={"AHC1|smoke-1|buy|4402|3|1200|0|${stamp}"}}`;
assert.equal((await req('journal',{text})).imported,1);assert.equal((await req('journal',{text})).imported,0);
await req('trade',{side:'sell',itemId:4402,quantity:2,total:2000,fee:100,at:Date.now(),note:'Smoke test'});
const {positions}=await req('portfolio');assert.equal(positions[0].quantity,1);assert.equal(positions[0].realized,1100);
const invalid=await fetch(base+'trade',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({side:'sell',itemId:1,quantity:1,total:100,fee:101,at:Date.now(),note:''})});assert.equal(invalid.status,422);assert.equal((await invalid.json()).error.code,'INVALID_TRADE');
const plan=await (await fetch(base+'addon.lua')).text();assert.ok(plan.includes('rows={\n\n}}'));
console.log('PASS: health, status, opportunities, history, backtest, watchlist, idempotent import, safe validation errors, trades, portfolio, alert isolation, empty demo plan');
JS
