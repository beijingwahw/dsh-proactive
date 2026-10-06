import { parallelTempering, lubySequence, annealWithRestarts, anneal, tspInstance, tspAdjacentSwapNeighbor, tspTourLength, tspExactOptimum, wellDepth } from '../dsh-proactive/src/core/simulated-annealing.ts';
import { mulberry32 } from '../dsh-proactive/src/core/novelty-detection.ts';

console.log('luby:', lubySequence(20).join(','));
// PT vs 单链几何降温（同总预算: steps×replicas）
const inst = tspInstance(6, 42);
const exact = tspExactOptimum(inst);
// d* 计算（照抄既有脚本口径）
const permutations = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permutations([...arr.slice(0,i), ...arr.slice(i+1)]).map(p => [x, ...p]));
const tours = permutations([0,1,2,3,4,5]);
const energies = {}, adjacency = {};
for (const t of tours) {
  const key = t.join(''); energies[key] = tspTourLength(inst, t);
  const nb = new Set();
  for (let i = 0; i < 5; i++) { const sw = [...t]; [sw[i], sw[i+1]] = [sw[i+1], sw[i]]; nb.add(sw.join('')); }
  adjacency[key] = [...nb];
}
const { criticalDepth: dStar } = wellDepth(energies, adjacency);
console.log('exact', exact.length.toFixed(4), 'dStar', dStar.toFixed(4));

const energy = (t) => tspTourLength(inst, t);
const neighbor = (t, rng) => tspAdjacentSwapNeighbor(t, rng);
const randomTour = (seed) => { const r = mulberry32(seed); const a = [0,1,2,3,4,5]; for (let i = 5; i > 0; i--) { const j = Math.floor(r()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };

const TRIALS = 60, STEPS = 150, R = 4;
let ptHits = 0, geoHits = 0, greedyHits = 0, arHits = 0;
for (let i = 0; i < TRIALS; i++) {
  const x0 = randomTour(31001 + i * 7919);
  const pt = parallelTempering({ energy, neighbor, x0, replicas: R, ladder: { tMin: 0.02, tMax: dStar * 2 }, steps: STEPS, swapEvery: 10, seed: 31001 + i * 104729 });
  if (Math.abs(pt.bestEnergy - exact.length) < 1e-9) ptHits++;
  const geo = anneal({ energy, neighbor, x0, schedule: { kind: 'geometric', T0: dStar * 2, rate: 0.992 }, steps: STEPS * R, seed: 31001 + i * 104729 });
  if (Math.abs(geo.bestEnergy - exact.length) < 1e-9) geoHits++;
  const gr = anneal({ energy, neighbor, x0, schedule: { kind: 'constant', T: 1e-12 }, steps: STEPS * R, seed: 31001 + i * 104729 });
  if (Math.abs(gr.bestEnergy - exact.length) < 1e-9) greedyHits++;
  const ar = annealWithRestarts({ energy, neighbor, x0, schedule: { kind: 'geometric', T0: dStar * 2, rate: 0.995 }, totalSteps: STEPS * R, baseRun: 500, seed: 31001 + i * 104729 });
  if (Math.abs(ar.bestEnergy - exact.length) < 1e-9) arHits++;
}
console.log(`PT ${ptHits}/${TRIALS} vs 单链几何 ${geoHits}/${TRIALS} vs 贪心 ${greedyHits}/${TRIALS} vs Luby重启 ${arHits}/${TRIALS}（同总预算 ${STEPS * R} 步）`);
// 副本能级排序 + 交换率 + 确定性
const pt = parallelTempering({ energy, neighbor, x0: randomTour(5150), replicas: 5, ladder: { tMin: 0.01, tMax: dStar * 2 }, steps: 8000, swapEvery: 5, seed: 777 });
console.log('meanEnergies:', pt.meanEnergies.map(e=>e.toFixed(2)).join(' < '), 'sorted?', JSON.stringify(pt.meanEnergies) === JSON.stringify([...pt.meanEnergies].sort((a,b)=>a-b)));
console.log('swapRate:', pt.swapRate.toFixed(3), 'acceptanceRates:', pt.replicasFinal.map(r=>r.acceptanceRate.toFixed(2)).join(','));
const pt2 = parallelTempering({ energy, neighbor, x0: randomTour(5150), replicas: 5, ladder: { tMin: 0.01, tMax: dStar * 2 }, steps: 8000, swapEvery: 5, seed: 777 });
console.log('确定性:', JSON.stringify(pt) === JSON.stringify(pt2));
// 断开阶梯的对照：温差过大 → swapRate 接近 0
const ptCold = parallelTempering({ energy, neighbor, x0: randomTour(5150), replicas: 2, ladder: [0.001, 50], steps: 4000, swapEvery: 5, seed: 7 });
console.log('断开阶梯 swapRate:', ptCold.swapRate.toFixed(4));
