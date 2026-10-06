import { noveltySearch } from '../dsh-proactive/src/core/novelty-search.ts';
// 合成均匀行为空间: 行为 = 基因组本身（dim 2, geneRange [0,100]）
const space = { dim: 2, geneRange: [0, 100] };
const behaviorOf = (g) => [g[0], g[1]];
const spread = (archive) => {
  let minPd = Infinity, nnSum = 0;
  for (let i = 0; i < archive.length; i++) {
    let nn = Infinity;
    for (let j = 0; j < archive.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(archive[i].behavior[0]-archive[j].behavior[0], archive[i].behavior[1]-archive[j].behavior[1]);
      if (d < minPd) minPd = d;
      if (d < nn) nn = d;
    }
    nnSum += nn;
  }
  return { minPd, meanNn: nnSum / archive.length };
};
let dMin = [], rMin = [], dNn = [], rNn = [];
for (let seed = 1; seed <= 15; seed++) {
  const d = noveltySearch({ genomeSpace: space, behaviorOf, generations: 80, popSize: 30, k: 5, archiveCap: 20, seed, archivePolicy: 'density', cellSize: 5 });
  const r = noveltySearch({ genomeSpace: space, behaviorOf, generations: 80, popSize: 30, k: 5, archiveCap: 20, seed, archivePolicy: 'random', cellSize: 5 });
  const sd = spread(d.archive), sr = spread(r.archive);
  dMin.push(sd.minPd); rMin.push(sr.minPd); dNn.push(sd.meanNn); rNn.push(sr.meanNn);
}
const sum = a => a.reduce((x,y)=>x+y,0);
console.log('档案最小点对距: density', (sum(dMin)/15).toFixed(2), 'vs random', (sum(rMin)/15).toFixed(2), '| density ≥ random:', dMin.filter((v,i)=>v>=rMin[i]).length, '/15');
console.log('档案平均最近邻距: density', (sum(dNn)/15).toFixed(2), 'vs random', (sum(rNn)/15).toFixed(2), '| density ≥ random:', dNn.filter((v,i)=>v>=rNn[i]).length, '/15');
