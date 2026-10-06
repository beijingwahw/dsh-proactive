import { localOutlierFactor, lofAUC, halfspaceDepth1D, mulberry32, gaussianNoise } from '../dsh-proactive/src/core/novelty-detection.ts';

// ① 双密度世界: 密簇 (σ=0.15, 中心 0) + 疏簇 (σ=0.6, 中心 5) + 孤立外点
const rng = mulberry32(20261001);
const dense = Array.from({length: 120}, () => [gaussianNoise(rng) * 0.15, gaussianNoise(rng) * 0.15]);
const sparse = Array.from({length: 120}, () => [5 + gaussianNoise(rng) * 0.6, gaussianNoise(rng) * 0.6]);
const ref = [...dense, ...sparse];
const outlier = [2.5, 2.5];
const lofOut = localOutlierFactor(ref, outlier, { k: 8 });
const lofDense = dense.slice(0, 40).map(p => localOutlierFactor(ref, p, { k: 8 }).lof);
const lofSparse = sparse.slice(0, 40).map(p => localOutlierFactor(ref, p, { k: 8 }).lof);
console.log('outlier LOF:', lofOut.lof.toFixed(2), 'dense max:', Math.max(...lofDense).toFixed(2), 'sparse max:', Math.max(...lofSparse).toFixed(2));
// kNN 全局口径对照: 疏簇成员的第 k 近邻距离 vs 密簇
const kth = (p, k=8) => ref.map(q => Math.hypot(p[0]-q[0], p[1]-q[1])).sort((a,b)=>a-b)[k-1];
console.log('kNN 口径: 疏簇典型第k距', kth(sparse[0]).toFixed(3), 'vs 密簇', kth(dense[0]).toFixed(3), '(全局口径下疏簇被误伤)');
const auc = lofAUC(ref, [...dense.slice(40,80), ...sparse.slice(40,80)], Array.from({length: 30}, (_, i) => [2.5 + Math.cos(i)*0.3, 2.5 + Math.sin(i)*0.3]), { k: 8 });
console.log('lofAUC:', auc.auc.toFixed(3), 'inlierMax', auc.inlierMaxLof.toFixed(2), 'outlierMin', auc.outlierMinLof.toFixed(2));

// ② 对称注入 200 种子
let detected = 0, seeds = 200;
for (let s = 1; s <= seeds; s++) {
  const r2 = mulberry32(s * 7919);
  const cloud = Array.from({length: 100}, () => [gaussianNoise(r2), gaussianNoise(r2), gaussianNoise(r2), gaussianNoise(r2)]);
  const theta = 2 * Math.PI * r2(), phi = Math.acos(2 * r2() - 1);
  const R = 5;
  const injected = [R * Math.sin(phi) * Math.cos(theta), R * Math.sin(phi) * Math.sin(theta), R * Math.cos(phi), 0];
  const lofIn = cloud.map(p => localOutlierFactor(cloud, p, { k: 6 }).lof);
  const lofOut2 = localOutlierFactor(cloud, injected, { k: 6 }).lof;
  if (lofOut2 > Math.max(...lofIn)) detected += 1;
}
console.log(`对称注入: ${detected}/${seeds} 种子 LOF(外点) > max LOF(内点)`);

// ③ Tukey 深度
const ref1 = Array.from({length: 101}, (_, i) => i - 50);
console.log('depth(median=0):', halfspaceDepth1D(ref1, 0), 'depth(25):', halfspaceDepth1D(ref1, 25), 'depth(100):', halfspaceDepth1D(ref1, 100));
// 确定性
console.log('确定性:', JSON.stringify(localOutlierFactor(ref, outlier, {k:8})) === JSON.stringify(localOutlierFactor(ref, outlier, {k:8})));
