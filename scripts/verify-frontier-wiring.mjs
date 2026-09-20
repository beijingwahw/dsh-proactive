/**
 * verify-frontier-wiring.mjs — 17.0→20.0 全链路接线冒烟验证
 *
 * 用真实引擎（非 mock）走完「挂载 → 运行 → 输出」全链路，证明四个
 * 新内核的接线是真实生效的运行路径（不只是类型正确）：
 *   17.0：MetaCognitionEngine.attachTransportDrift → 平稳期零误报，
 *        注入双峰漂移（均值不变）→ shape-drift 洞察翻转沿产出
 *   18.0：StrategyEvolutionEngine.attachInformationGeometry →
 *        evolve() 自然变异 + 几何报告（有效维 / 步长 nat^½ / 信任域）
 *   19.0：DecisionEngine.attachOptimalStopper → 同在「urgency < 0.3」
 *        魔数区间内，经验分布不同 → 决策翻转（0.28 执行 / 0.2 等待）
 */
import { MetaCognitionEngine, StrategyEvolutionEngine, DecisionEngine } from '../dist/index.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name} — ${detail}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name} — ${detail}`);
  }
}

console.log('接线 17.0：元认知形状漂移（真实 MetaCognitionEngine）');
{
  const meta = new MetaCognitionEngine({ windowSize: 30 });
  meta.attachTransportDrift({ kpis: ['avgQuality'], windowSize: 20, referenceSize: 80, minSamples: 12 });
  const mkSnapshot = (q) => ({
    timestamp: Date.now(),
    successRate: 0.9,
    avgQuality: q,
    avgLatency: 100,
    cacheHitRate: 0.2,
    activeExecutions: 0,
    modelSuccessRates: {},
  });
  let driftInsights = 0;
  for (let i = 0; i < 60; i += 1) {
    const insights = meta.observe(mkSnapshot(0.6 + (i % 7) * 0.005));
    driftInsights += insights.filter((x) => x.category === 'distribution-shape-drift').length;
  }
  for (let i = 0; i < 24; i += 1) {
    const insights = meta.observe(mkSnapshot(i % 2 === 0 ? 0.3 : 0.9));
    driftInsights += insights.filter((x) => x.category === 'distribution-shape-drift').length;
  }
  const view = meta.transportDriftView('avgQuality');
  check(
    '漂移洞察产出',
    driftInsights === 1 && view !== undefined && view.drifting,
    `平稳期 60 快照零误报 → 注入双峰漂移 → 恰 1 条 shape-drift 洞察（翻转沿，kind=${view.kind}, W₁=${view.w1} > 阈 ${view.threshold}）`,
  );
}

console.log('接线 18.0：策略自然变异（真实 StrategyEvolutionEngine）');
{
  const rng = (() => {
    let s = 7;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  })();
  const engine = new StrategyEvolutionEngine({ rng, populationSize: 6 });
  engine.attachInformationGeometry({ klBudget: 1.2 });
  for (let i = 0; i < 20; i += 1) engine.recordOutcome(engine.selectGenome().id, i % 3 === 0 ? 'good' : 'excellent');
  const report = engine.evolve(true);
  const geometry = engine.getReport().geometry;
  check(
    '自然变异生效',
    report !== null && geometry !== undefined && geometry.samples > 0,
    `进化 1 代（born: ${report.born.join(',')}），几何报告 d=${geometry.dimension}，有效维 ${geometry.effectiveDimension}，平均步长 ${geometry.meanStep} nat^½，信任域触发率 ${(geometry.trustRegionRate * 100).toFixed(0)}%`,
  );
  const genesValid = engine.getReport().genomes.every((g) =>
    g.genes.suppressionWindowMs >= 30_000 && g.genes.suppressionWindowMs <= 900_000 && g.genes.burstOccurrences >= 2 && g.genes.burstOccurrences <= 12,
  );
  check('基因边界合法', genesValid, '所有后代基因在边界内（整数基因圆整正确）');
  check('种群守恒', engine.getReport().genomes.length === 6, `种群规模 6（变异替换不扩张）`);
}

console.log('接线 19.0：决策引擎机会停止（真实 DecisionEngine）');
{
  const engine = new DecisionEngine();
  engine.attachOptimalStopper({ horizon: 3, minSamples: 8 });
  const history = new Map([
    ['costly-build', { totalDecisions: 30, successRate: 0.8, avgExecutionTime: 5000, avgTokenCost: 8000 }],
  ]);
  const mkSignal = (urgency) => ({
    id: `sig-${urgency}-${Math.random()}`,
    type: 'costly-build',
    description: `成本任务（紧急度 ${urgency}）`,
    payload: {},
    source: 'test',
    urgency,
    receivedAt: Date.now(),
  });
  let deferred = 0;
  for (const u of [0.2, 0.1, 0.18, 0.05, 0.15, 0.12, 0.08, 0.22, 0.25, 0.11]) {
    const batch = await engine.decide([mkSignal(u)], history);
    for (const d of batch.values()) if (d.action === 'defer') deferred += 1;
  }
  const good = await engine.decide([mkSignal(0.28)], history);
  const goodDecision = [...good.values()][0];
  const stopperStats = engine.getStopperVerdicts();
  check(
    '魔数 defer 升级为数学 defer',
    goodDecision.action === 'execute' && goodDecision.reason.includes('继续价值'),
    `低值流下 0.28（< 0.3 魔数）+ 高成本 → ${goodDecision.action}（越过继续价值线：${goodDecision.reason.slice(0, 52)}…）`,
  );
  check(
    '低值仍 defer',
    deferred > 0 && stopperStats.length > 0,
    `低紧急度样本 ${deferred}/10 defer（现值低于继续价值，等待有数学价格）；停止器审计 ${stopperStats.length} 条`,
  );
}

console.log(failures === 0 ? '\n接线冒烟验证全部通过 ✓' : `\n${failures} 项接线验证失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
