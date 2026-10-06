import { complexBetti, h1Persistence } from '../dsh-proactive/src/core/persistent-homology.ts';
import { annulus } from '../dsh-proactive/src/core/mapper-graph.ts';
for (const seed of [7, 11, 23]) {
  const ring = annulus(60, 1, 1.15, seed);
  const ids = ring.map((_, i) => `p${i}`);
  const edges = [];
  for (let i = 0; i < 60; i++) for (let j = i + 1; j < 60; j++) {
    const d = Math.hypot(ring[i][0]-ring[j][0], ring[i][1]-ring[j][1]);
    if (d < 0.26) edges.push({ source: ids[i], target: ids[j], weight: 1 - d / 2 });
  }
  const cb = complexBetti(ids, edges, 0.87);
  const r = h1Persistence(ids, edges, { floor: 0.87 });
  const ess = r.bars.filter(b => b.essential);
  console.log(`seed=${seed}: V=${cb.vertices} E=${cb.edges} F=${cb.faces} χ=${cb.chi} β0=${cb.beta0} β1=${cb.beta1} β2=${cb.beta2} | essential bars=${ess.length} 最持久 birth=${ess.length ? Math.max(...ess.map(b=>b.birth)).toFixed(3) : '-'} 圈长=${ess.length ? ess.sort((a,b)=>b.birth-a.birth)[0].representative.length : '-'}`);
}
