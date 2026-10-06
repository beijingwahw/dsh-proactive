import { complexBetti, bottleneckDistance } from '../dsh-proactive/src/core/persistent-homology.ts';
import { annulus } from '../dsh-proactive/src/core/mapper-graph.ts';
function mulberry32(seed){let a=seed>>>0;return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

// 1) annulus: 找 beta2=0 且 beta1=1 的阈值
for (const [n, floor] of [[60, 0.72], [60, 0.75], [60, 0.78], [80, 0.75], [80, 0.78], [80, 0.8]]) {
  const ring = annulus(n, 1, 2, 7);
  const ids = ring.map((_, i) => `p${i}`);
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = Math.hypot(ring[i][0]-ring[j][0], ring[i][1]-ring[j][1]);
    if (d < 0.8) edges.push({ source: ids[i], target: ids[j], weight: 1 - d / 2 });
  }
  const cb = complexBetti(ids, edges, floor);
  console.log(`annulus(${n}) floor=${floor}: V=${cb.vertices} E=${cb.edges} F=${cb.faces} χ=${cb.chi} β0=${cb.beta0} β1=${cb.beta1} β2=${cb.beta2}`);
}

// 2) 瓶颈距离度量公理 200 种子
let bad = 0;
const t0 = Date.now();
for (let s = 1; s <= 200; s++) {
  const rng = mulberry32(s * 104729 + 7);
  const mk = () => Array.from({length: 3 + Math.floor(rng() * 6)}, () => ({ birth: Math.round(rng()*100)/100, death: Math.round(rng()*100)/100 }));
  const A = mk(), B = mk(), C = mk();
  const dAA = bottleneckDistance(A, A);
  const dBB = bottleneckDistance(B, B);
  const dAB = bottleneckDistance(A, B), dBA = bottleneckDistance(B, A);
  const dAC = bottleneckDistance(A, C), dBC = bottleneckDistance(B, C);
  if (dAA !== 0 || dBB !== 0) { bad++; console.log('refl fail', s, dAA, dBB); }
  if (Math.abs(dAB - dBA) > 1e-12) { bad++; console.log('sym fail', s, dAB, dBA); }
  if (dAC > dAB + dBC + 1e-9) { bad++; console.log('tri fail', s, dAC.toFixed(4), dAB.toFixed(4), dBC.toFixed(4)); }
}
console.log(`瓶颈公理: 200 种子违例 ${bad}, 耗时 ${Date.now()-t0}ms`);
