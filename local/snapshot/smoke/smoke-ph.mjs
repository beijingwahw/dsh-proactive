import { h1Persistence, complexBetti, h0Persistence } from '../dsh-proactive/src/core/persistent-homology.ts';

// 方框 + 一条对角线：圈在对角线出现时诞生，再被三角形填死
const nodes = ['a','b','c','d'];
const edges = [
  { source: 'a', target: 'b', weight: 0.9 },
  { source: 'b', target: 'c', weight: 0.9 },
  { source: 'c', target: 'd', weight: 0.9 },
  { source: 'd', target: 'a', weight: 0.9 },
  { source: 'a', target: 'c', weight: 0.5 },
];
const r = h1Persistence(nodes, edges);
console.log('bars:', JSON.stringify(r.bars, null, 1));
console.log('beta0', r.beta0, 'essential', r.essentialBars, 'finite', r.finiteBars, 'ops', r.reductionOps);
const rm = h1Persistence(nodes, edges, { engine: 'matrix' });
console.log('matrix bars weights:', rm.bars.map(b=>[b.birth,b.death,b.essential]), 'beta0', rm.beta0, 'ops', rm.reductionOps);
console.log('betti:', JSON.stringify(complexBetti(nodes, edges, 0.6)));
console.log('h0 islands:', h0Persistence(nodes, edges, 0.6).islands.length);
// 无三角形纯方框：essential H1 = 1
const r2 = h1Persistence(nodes, edges.slice(0,4));
console.log('pure square essential:', r2.essentialBars, 'rep:', r2.bars[0].representative);
console.log('betti square:', JSON.stringify(complexBetti(nodes, edges.slice(0,4), 0)));
