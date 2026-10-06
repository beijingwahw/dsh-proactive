import { complexBetti, h1Persistence } from '../dsh-proactive/src/core/persistent-homology.ts';
// 圆周 24 点（格距 2π/24≈0.262; 邻距 1 跳 0.262 / 2 跳 0.518）
const n = 24;
const ids = Array.from({length: n}, (_, i) => `v${i}`);
const xy = ids.map((_, i) => [Math.cos(2*Math.PI*i/n), Math.sin(2*Math.PI*i/n)]);
for (const range of [0.30, 0.55]) {
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = i+1; j < n; j++) {
    const d = Math.hypot(xy[i][0]-xy[j][0], xy[i][1]-xy[j][1]);
    if (d < range) edges.push({ source: ids[i], target: ids[j], weight: 1 - d / 2 });
  }
  const floor = 1 - range / 2;
  const cb = complexBetti(ids, edges, floor);
  const r = h1Persistence(ids, edges, { floor });
  const ess = r.bars.filter(b => b.essential);
  console.log(`range=${range}: V=${cb.vertices} E=${cb.edges} F=${cb.faces} χ=${cb.chi} β0=${cb.beta0} β1=${cb.beta1} β2=${cb.beta2} | ess H1=${ess.length} 最持久圈长=${ess.length ? ess.sort((a,b)=>b.birth-a.birth)[0].representative.length : '-'}`);
}
// K4 锚点
const k4 = ['a','b','c','d'];
const e4 = [];
for (let i = 0; i < 4; i++) for (let j = i+1; j < 4; j++) e4.push({ source: k4[i], target: k4[j], weight: 0.9 });
console.log('K4:', JSON.stringify(complexBetti(k4, e4, 0)));
// 纯方框
const sq = [['a','b',0.9],['b','c',0.9],['c','d',0.9],['d','a',0.9]].map(([s,t,w]) => ({source:s,target:t,weight:w}));
console.log('square:', JSON.stringify(complexBetti(['a','b','c','d'], sq, 0)));
