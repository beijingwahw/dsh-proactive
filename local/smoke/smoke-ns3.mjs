import { noveltySearch, deceptiveMaze } from '../dsh-proactive/src/core/novelty-search.ts';
const dm = deceptiveMaze();
let dW = 0, rW = 0, dCells = [], rCells = [], dDia = [], rDia = [], dFirst = [], rFirst = [];
const N = 30;
for (let seed = 1; seed <= N; seed++) {
  const d = noveltySearch({ genomeSpace: dm.genomeSpace, behaviorOf: dm.behaviorOf, generations: 120, popSize: 40, k: 10, archiveCap: 40, seed, archivePolicy: 'density', solved: dm.solved, stopWhenSolved: true });
  const r = noveltySearch({ genomeSpace: dm.genomeSpace, behaviorOf: dm.behaviorOf, generations: 120, popSize: 40, k: 10, archiveCap: 40, seed, archivePolicy: 'random', solved: dm.solved, stopWhenSolved: true });
  if (d.firstSolvedGeneration !== null) { dW++; dFirst.push(d.firstSolvedGeneration); }
  if (r.firstSolvedGeneration !== null) { rW++; rFirst.push(r.firstSolvedGeneration); }
  dCells.push(d.noveltyTrace.at(-1).cellsCovered); rCells.push(r.noveltyTrace.at(-1).cellsCovered);
  dDia.push(d.noveltyTrace.at(-1).archiveDiameter); rDia.push(r.noveltyTrace.at(-1).archiveDiameter);
}
const sum = a => a.reduce((x,y)=>x+y,0);
console.log(`欺骗迷宫(cap=40): density ${dW}/${N} vs random ${rW}/${N}`);
console.log('cells: density mean', (sum(dCells)/N).toFixed(1), 'vs random', (sum(rCells)/N).toFixed(1), '| density ≥ random 种子数', dCells.filter((c,i)=>c>=rCells[i]).length, '/', N);
console.log('diam : density mean', (sum(dDia)/N).toFixed(2), 'vs random', (sum(rDia)/N).toFixed(2));
console.log('平均首解代数: density', dFirst.length?(sum(dFirst)/dFirst.length).toFixed(1):'-', 'vs random', rFirst.length?(sum(rFirst)/rFirst.length).toFixed(1):'-');
