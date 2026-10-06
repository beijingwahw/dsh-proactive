import { wolfLyapunov, determinismScore } from '../dsh-proactive/src/core/nonlinear-dynamics.ts';
function mulberry32(seed){let a=seed>>>0;return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const logisticSeries = (r, seed, n=1500, burn=300) => {
  const rng = mulberry32(seed); let x = 0.2 + rng() * 0.6; const out = [];
  for (let i = 0; i < n + burn; i++) { x = r * x * (1 - x); if (i >= burn) out.push(x); }
  return out;
};
const analyticLambda = (r, series) => series.reduce((s, x) => s + Math.log(Math.abs(r * (1 - 2 * x))), 0) / series.length;
let agree = 0, total = 0;
for (let i = 0; i < 40; i++) {
  const r = 3.6 + (i / 39) * 0.4;
  for (let seed = 1; seed <= 5; seed++) {
    const s = logisticSeries(r, seed * 77 + 13);
    const a = analyticLambda(r, s);
    const w = wolfLyapunov(s);
    total += 1;
    const clsA = a > 0.05, clsW = w !== undefined && w.lambda > 0.05;
    if (clsA === clsW) agree += 1; else console.log('DIS', r.toFixed(3), a.toFixed(3), w?.lambda.toFixed(3));
  }
}
console.log(`阈值化混沌判定一致: ${agree}/${total}`);
// 噪声门
const rng = mulberry32(9);
const noise = Array.from({length: 2000}, () => rng());
const w = wolfLyapunov(noise);
console.log('白噪声: wolf λ=', w.lambda.toFixed(2), 'determinismScore=', determinismScore(noise).toFixed(3), '(>0.5 → 噪声门拦下)');
const s4 = logisticSeries(4.0, 5);
console.log('logistic r=4: wolf λ=', wolfLyapunov(s4).lambda.toFixed(3), 'determinismScore=', determinismScore(s4).toFixed(3), '(<0.5 → 过门判混沌)');
