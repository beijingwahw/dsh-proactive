import { wolfLyapunov, largestLyapunov } from '../dsh-proactive/src/core/nonlinear-dynamics.ts';
function mulberry32(seed){let a=seed>>>0;return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

const logisticSeries = (r, seed, n=2048, burn=300) => {
  const rng = mulberry32(seed);
  let x = 0.2 + rng() * 0.6;
  const out = [];
  for (let i = 0; i < n + burn; i++) { x = r * x * (1 - x); if (i >= burn) out.push(x); }
  return out;
};
// 解析对照：轨迹平均 ln|r(1-2x)|（对 logistic 收敛到真 λ）
const analyticLambda = (r, series) => series.reduce((s, x) => s + Math.log(Math.abs(r * (1 - 2 * x))), 0) / series.length;

for (const r of [2.5, 3.2, 3.5, 3.7, 3.83, 3.9, 4.0]) {
  const s = logisticSeries(r, 101);
  const w = wolfLyapunov(s);
  const rr = largestLyapunov(s);
  console.log(`r=${r}: wolf λ=${w ? w.lambda.toFixed(3) : '—'} (repl=${w?.replacements}, steps=${w?.steps}) | rosenstein=${rr ? rr.lambda.toFixed(3) : '—'} | analytic=${analyticLambda(r, s).toFixed(3)}`);
}
// 符号扫描: 40 参数 × 5 种子 = 200 输入
let agree = 0, borderline = 0, total = 0;
for (let i = 0; i < 40; i++) {
  const r = 3.6 + (i / 39) * 0.4;
  for (let seed = 1; seed <= 5; seed++) {
    const s = logisticSeries(r, seed * 77 + 13, 1500);
    const a = analyticLambda(r, s);
    const w = wolfLyapunov(s);
    total += 1;
    if (Math.abs(a) < 0.03) { borderline += 1; continue; }
    if (w && Math.sign(w.lambda) === Math.sign(a)) agree += 1;
    else console.log('  DISAGREE r=', r.toFixed(3), 'a=', a.toFixed(3), 'w=', w?.lambda.toFixed(3));
  }
}
console.log(`符号对照: ${agree}/${total - borderline} 一致（${total} 输入，${borderline} 边界跳过）`);
// 确定性
const s1 = logisticSeries(4.0, 55);
console.log('确定性:', JSON.stringify(wolfLyapunov(s1)) === JSON.stringify(wolfLyapunov(s1)));
// 白噪声
const rng = mulberry32(9);
const noise = Array.from({length: 2000}, () => rng());
console.log('白噪声 wolf:', wolfLyapunov(noise)?.lambda.toFixed(3), '(应为正——无穷维混沌口径,须过噪声门)');
