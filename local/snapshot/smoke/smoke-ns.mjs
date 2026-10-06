import { noveltySearch, deceptiveMaze, openFieldMaze } from '../dsh-proactive/src/core/novelty-search.ts';

// density vs random 档案策略对照（开阔地, 覆盖导向）
const task = openFieldMaze();
let densCells = [], randCells = [], densDia = [], randDia = [], densFirst = [], randFirst = [];
for (let seed = 1; seed <= 12; seed++) {
  const d = noveltySearch({ genomeSpace: task.genomeSpace, behaviorOf: task.behaviorOf, generations: 60, popSize: 40, k: 8, archiveCap: 60, seed, archivePolicy: 'density', solved: task.solved, stopWhenSolved: false });
  const r = noveltySearch({ genomeSpace: task.genomeSpace, behaviorOf: task.behaviorOf, generations: 60, popSize: 40, k: 8, archiveCap: 60, seed, archivePolicy: 'random', solved: task.solved, stopWhenSolved: false });
  densCells.push(d.noveltyTrace.at(-1).cellsCovered); randCells.push(r.noveltyTrace.at(-1).cellsCovered);
  densDia.push(d.noveltyTrace.at(-1).archiveDiameter); randDia.push(r.noveltyTrace.at(-1).archiveDiameter);
  densFirst.push(d.firstSolvedGeneration); randFirst.push(r.firstSolvedGeneration);
}
const sum = a => a.reduce((x,y)=>x+y,0);
console.log('cells  density:', densCells.join(','), 'mean', (sum(densCells)/12).toFixed(1));
console.log('cells  random :', randCells.join(','), 'mean', (sum(randCells)/12).toFixed(1));
console.log('diam   density mean', (sum(densDia)/12).toFixed(1), 'random mean', (sum(randDia)/12).toFixed(1));
console.log('firstSol density:', densFirst.map(x=>x??'-').join(','), 'random:', randFirst.map(x=>x??'-').join(','));
// 欺骗迷宫命中率对照
const dm = deceptiveMaze();
let dWins = 0, rWins = 0, n = 20;
for (let seed = 1; seed <= n; seed++) {
  const d = noveltySearch({ genomeSpace: dm.genomeSpace, behaviorOf: dm.behaviorOf, generations: 120, popSize: 40, k: 10, archiveCap: 60, seed, archivePolicy: 'density', solved: dm.solved, stopWhenSolved: true });
  const r = noveltySearch({ genomeSpace: dm.genomeSpace, behaviorOf: dm.behaviorOf, generations: 120, popSize: 40, k: 10, archiveCap: 60, seed, archivePolicy: 'random', solved: dm.solved, stopWhenSolved: true });
  if (d.firstSolvedGeneration !== null) dWins++;
  if (r.firstSolvedGeneration !== null) rWins++;
}
console.log(`欺骗迷宫: density ${dWins}/${n} vs random ${rWins}/${n}`);
// 缺省行为不变（random = 旧路径）：跑两次比较
const a1 = noveltySearch({ genomeSpace: task.genomeSpace, behaviorOf: task.behaviorOf, generations: 10, popSize: 20, k: 5, archiveCap: 10, seed: 9, solved: task.solved });
const a2 = noveltySearch({ genomeSpace: task.genomeSpace, behaviorOf: task.behaviorOf, generations: 10, popSize: 20, k: 5, archiveCap: 10, seed: 9, archivePolicy: 'random', solved: task.solved });
console.log('缺省=random 逐位一致:', JSON.stringify(a1.noveltyTrace) === JSON.stringify(a2.noveltyTrace));
