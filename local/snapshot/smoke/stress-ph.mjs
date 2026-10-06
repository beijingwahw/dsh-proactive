import { h1Persistence, complexBetti, h0Persistence } from '../dsh-proactive/src/core/persistent-homology.ts';
function mulberry32(seed){let a=seed>>>0;return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

// 1) 随机图：两引擎逐条对照
let mism = 0, checks = 0, clearingOpsLess = 0;
for (let s = 1; s <= 60; s += 1) {
  const rng = mulberry32(s * 7919);
  const n = 5 + Math.floor(rng() * 10);
  const nodes = Array.from({length: n}, (_, i) => `v${i}`);
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (rng() < 0.5) edges.push({ source: `v${i}`, target: `v${j}`, weight: Math.round(rng() * 100) / 100 + 0.005 });
  }
  const c = h1Persistence(nodes, edges, { engine: 'clearing' });
  const mtx = h1Persistence(nodes, edges, { engine: 'matrix' });
  const key = (b) => `${b.birth.toFixed(6)}>${b.death.toFixed(6)}:${b.essential}`;
  const kc = c.bars.map(key).sort().join('|');
  const km = mtx.bars.map(key).sort().join('|');
  checks += 1;
  if (kc !== km) { mism += 1; console.log('MISMATCH seed', s, '\n clear:', kc, '\n mtx  :', km); }
  if (c.beta0 !== mtx.beta0) { mism += 1; console.log('BETA0 MISMATCH', s, c.beta0, mtx.beta0); }
  if (c.reductionOps <= mtx.reductionOps) clearingOpsLess += 1;
  // h0 互证
  const h0 = h0Persistence(nodes, edges, 0);
  if (h0.islands.length !== c.beta0) { mism += 1; console.log('H0 MISMATCH', s); }
  // Euler 一致性
  const cb = complexBetti(nodes, edges, 0);
  if (cb.beta2 < 0) { mism += 1; console.log('BETA2 NEG', s); }
}
console.log(`随机图引擎对照: ${checks} 例, 不一致 ${mism}, clearing ops ≤ matrix ops: ${clearingOpsLess}/${checks}`);

// 2) 圆环锚点（80 点，β1 = 1 essential）
function annulus(n, r1, r2, seed) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(r1*r1 + rng()*(r2*r2 - r1*r1));
    const t = 2*Math.PI*rng();
    out.push([r*Math.cos(t), r*Math.sin(t)]);
  }
  return out;
}
const ring = annulus(80, 1, 2, 7);
const ids = ring.map((_, i) => `p${i}`);
const edges = [];
for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
  const d = Math.hypot(ring[i][0]-ring[j][0], ring[i][1]-ring[j][1]);
  if (d < 0.8) edges.push({ source: ids[i], target: ids[j], weight: 1 - d / 2 });
}
const t0 = Date.now();
const rc = h1Persistence(ids, edges, { engine: 'clearing' });
const t1 = Date.now();
const rm = h1Persistence(ids, edges, { engine: 'matrix' });
const t2 = Date.now();
console.log(`annulus(80): simplices ${JSON.stringify(rc.simplexCounts)}, beta0=${rc.beta0}, essential=${rc.essentialBars}, finite=${rc.finiteBars}`);
console.log(`  最持久 essential 条: birth=${rc.bars.filter(b=>b.essential).map(b=>b.birth).sort((a,b)=>b-a)[0]}, 代表圈长 ${rc.bars.filter(b=>b.essential).sort((a,b)=>b.birth-a.birth)[0]?.representative.length}`);
console.log(`  clearing ops=${rc.reductionOps} (${t1-t0}ms), matrix ops=${rm.reductionOps} (${t2-t1}ms)`);
const key = (b) => `${b.birth.toFixed(9)}>${b.death.toFixed(9)}:${b.essential}`;
console.log('  两引擎条一致:', rc.bars.map(key).sort().join('|') === rm.bars.map(key).sort().join('|'));
const cb = complexBetti(ids, edges, 0.6);
console.log('  betti@0.6:', JSON.stringify(cb));
