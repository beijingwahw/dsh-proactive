import { noveltySearch, openFieldMaze } from '../dsh-proactive/src/core/novelty-search.ts';
const task = openFieldMaze();
let densCells = [], randCells = [], densDia = [], randDia = [];
for (let seed = 1; seed <= 12; seed++) {
  const d = noveltySearch({ genomeSpace: task.genomeSpace, behaviorOf: task.behaviorOf, generations: 100, popSize: 40, k: 8, archiveCap: 50, seed, archivePolicy: 'density' });
  const r = noveltySearch({ genomeSpace: task.genomeSpace, behaviorOf: task.behaviorOf, generations: 100, popSize: 40, k: 8, archiveCap: 50, seed, archivePolicy: 'random' });
  densCells.push(d.noveltyTrace.at(-1).cellsCovered); randCells.push(r.noveltyTrace.at(-1).cellsCovered);
  densDia.push(d.noveltyTrace.at(-1).archiveDiameter); randDia.push(r.noveltyTrace.at(-1).archiveDiameter);
}
const sum = a => a.reduce((x,y)=>x+y,0);
const wins = densCells.map((c,i)=>c - randCells[i]);
console.log('cells density:', densCells.join(','), 'mean', (sum(densCells)/12).toFixed(1));
console.log('cells random :', randCells.join(','), 'mean', (sum(randCells)/12).toFixed(1));
console.log('逐种子差:', wins.join(','));
console.log('diameter density mean', (sum(densDia)/12).toFixed(2), 'vs random', (sum(randDia)/12).toFixed(2));
// 描述子消融: 2D vs 1D 投影（开阔地 6 种子）
let cov2d = 0, cov1d = 0;
for (let seed = 1; seed <= 6; seed++) {
  const b2 = noveltySearch({ genomeSpace: task.genomeSpace, behaviorOf: task.behaviorOf, generations: 50, popSize: 30, k: 6, archiveCap: 40, seed });
  const b1 = noveltySearch({ genomeSpace: task.genomeSpace, behaviorOf: g => task.behaviorOf(g).slice(0, 1), cellSize: 1, generations: 50, popSize: 30, k: 6, archiveCap: 40, seed });
  cov2d += b2.noveltyTrace.at(-1).cellsCovered; cov1d += b1.noveltyTrace.at(-1).cellsCovered;
}
console.log('消融: 2D 描述子平均覆盖', (cov2d/6).toFixed(0), 'vs 1D 投影', (cov1d/6).toFixed(0));
