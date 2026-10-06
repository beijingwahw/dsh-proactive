import { h1Persistence } from '../dsh-proactive/src/core/persistent-homology.ts';
import { localOutlierFactor, mulberry32, gaussianNoise } from '../dsh-proactive/src/core/novelty-detection.ts';
// 方框代表圈
const r2 = h1Persistence(['a','b','c','d'], [
  { source: 'a', target: 'b', weight: 0.9 }, { source: 'b', target: 'c', weight: 0.9 },
  { source: 'c', target: 'd', weight: 0.9 }, { source: 'd', target: 'a', weight: 0.9 }]);
console.log('square rep:', r2.bars[0].representative);
// 双密度世界 kth 均值对比
const rng = mulberry32(20261001);
const dense = Array.from({length: 120}, () => [gaussianNoise(rng) * 0.15, gaussianNoise(rng) * 0.15]);
const sparse = Array.from({length: 120}, () => [5 + gaussianNoise(rng) * 0.6, gaussianNoise(rng) * 0.6]);
const ref = [...dense, ...sparse];
const kth = (p) => ref.map((q) => Math.hypot(p[0]-q[0], p[1]-q[1])).sort((a,b)=>a-b)[7];
const mean = a => a.reduce((x,y)=>x+y,0)/a.length;
const dMean = mean(dense.slice(0,40).map(kth)), sMean = mean(sparse.slice(0,40).map(kth));
console.log('mean kth: dense', dMean.toFixed(4), 'sparse', sMean.toFixed(4), 'ratio', (sMean/dMean).toFixed(2));
