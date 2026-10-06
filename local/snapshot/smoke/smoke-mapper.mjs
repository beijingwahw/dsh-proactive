import { buildMapper, quantileCover, singleLinkage, singleLinkageFast, annulus, blobs, euclidean } from '../dsh-proactive/src/core/mapper-graph.ts';
function mulberry32(seed){let a=seed>>>0;return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function gaussian(rng){return Math.sqrt(-2*Math.log(1-rng()))*Math.cos(2*Math.PI*rng());}

// 1) 网格加速等价性：多种子/维度/规模
let eq = 0, tot = 0;
for (const seed of [1,2,3,4,5,6,7,8]) {
  const rng = mulberry32(seed);
  for (const [n, dim] of [[50,2],[200,2],[300,3],[120,1],[60,3]]) {
    const pts = Array.from({length:n},()=>Array.from({length:dim},()=>rng()*4));
    for (const eps of [0.1, 0.5, 1.2, 0]) {
      const a = JSON.stringify(singleLinkage(pts, eps));
      const b = JSON.stringify(singleLinkageFast(pts, eps));
      tot += 1;
      if (a === b) eq += 1; else console.log('MISMATCH', seed, n, dim, eps);
    }
  }
}
console.log(`网格加速等价: ${eq}/${tot}`);

// 自定义度量回退
const manhattan = (a,b)=>a.reduce((s,v,i)=>s+Math.abs(v-b[i]),0);
const pts2 = [[0,0],[1,1],[3,3]];
console.log('自定义度量回退一致:', JSON.stringify(singleLinkageFast(pts2,2,manhattan)) === JSON.stringify(singleLinkage(pts2,2,manhattan)));
// 4 维回退
const pts4 = Array.from({length:10},(_,i)=>[i,i,i,i]);
console.log('4 维回退一致:', JSON.stringify(singleLinkageFast(pts4,3)) === JSON.stringify(singleLinkage(pts4,3)));

// 2) 平衡覆盖 vs 等宽覆盖：偏斜滤镜值域
const rngS = mulberry32(42);
const skew = Array.from({length:600},()=>Math.exp(gaussian(rngS)*1.2)); // 对数正态
const vals = skew.slice();
const uni = buildMapper({ points: skew.map(v=>[v, v*0.5]), filter:(p)=>p[0], intervals:8, overlap:0.3, clusterEps:0.5, cover:'uniform' });
const bal = buildMapper({ points: skew.map(v=>[v, v*0.5]), filter:(p)=>p[0], intervals:8, overlap:0.3, clusterEps:0.5, cover:'balanced' });
// 纤维规模对比：从 intervalHistogram 只能看到节点数——直接用 quantileCover 看纤维点数
const qc = quantileCover(vals, 8, 0.3);
console.log('平衡纤维点数:', qc.map(q=>q.members.length).join(','));
console.log('uniform intervalWidth:', uni.stats.intervalWidth.toFixed(3), 'coverKind:', uni.stats.coverKind, bal.stats.coverKind);
console.log('uniform:', uni.stats.nodeCount, 'nodes', uni.stats.components, 'comp;', 'balanced:', bal.stats.nodeCount, 'nodes', bal.stats.components, 'comp');

// 3) 圆环 + 平衡覆盖仍含 1 环
const ring = annulus(300, 1, 2, 7);
for (const cov of ['uniform','balanced']) {
  const m = buildMapper({ points: ring, filter:(p)=>p[1], intervals:10, overlap:0.3, clusterEps:0.6, cover:cov });
  console.log(`ring ${cov}: C=${m.stats.components} cycleRank=${m.stats.cycleRank} coverage=${m.stats.coverage}`);
}

// 4) 网格性能对照
const big = Array.from({length:2000},()=>[rngS()*100, rngS()*100]);
let t0=Date.now(); singleLinkage(big, 1.0); let t1=Date.now();
singleLinkageFast(big, 1.0); let t2=Date.now();
console.log(`n=2000: 逐对 ${t1-t0}ms vs 网格 ${t2-t1}ms`);

// 5) 平局确定性
const ties = [1,1,1,2,2,2,2,3,3,3,3,3];
const qc2 = quantileCover(ties, 4, 0.3);
console.log('平局纤维:', qc2.map(q=>q.members.length).join(','), 'min/max:', qc2.map(q=>[q.minValue,q.maxValue].join('-')).join(' '));
