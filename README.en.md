# dsh-proactive

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.json)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.18-339933?logo=nodedotjs&logoColor=white)](#installation)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-8250df)](https://github.com/topics/dsh-plugin)

> **Proactive Intelligence scheduling plugin** — a multi-model collaborative scheduling system for the DeepSeek Harness (DSH) ecosystem: it perceives, decides, and evolves on its own, with a built-in **Scientist / Theorist dual mind**, a **cognitive energy symbiosis economy**, and **twenty-eight phase-change kernels (evidence → geometry-topology / genesis / prophet layers: anytime-valid / conformal / optimal transport / information geometry / sheaf consensus / Gittins / robust statistics / differential privacy / capacity planning / Gaussian process / Kalman filtering / extreme value theory / Monte-Carlo tree search / submodular optimization)**.
>
> English | [中文](./README.md)

## What is Proactive Intelligence?

Traditional schedulers are **reactive**: they respond only when a signal arrives and idle otherwise. On top of the "perceive → decide → execute → reflect → consolidate" loop, this plugin adds an autonomy layer so the system:

- **When idle**, actively observes its own runtime state, discovers bottlenecks, and generates improvement goals
- **Facing unknown territory**, actively launches explorations, turning "unknown" into "experienced"
- **Anticipating future load**, actively predicts signal arrival trends and reserves capacity ahead of time
- **On anomalies**, actively trips circuit breakers, rate-limits, and degrades — instead of waiting to crash

## Architecture Overview

The system has three tiers: the **kernel stack** (a substrate of minds sharing one statistical language), **three-loop autonomy** (operational loop / evolution loop / meta-cognition outer loop), and the **symbiosis economy layer** (a cognitive energy market).

```
┌─ Symbiosis Economy (symbiosis/) ─────────────────────────────┐
│  Energy Ledger (double-entry · chained audit)                │
│  Knowledge Market (continuous double auction · royalties)    │
│  Belief Market (LMSR · market as mind)                       │
│  Agents (reputation · legislation/enforcement split)         │
│  Symbiosis Runtime (survive→propose→veto→match→execute)      │
├─ Three-Loop Autonomy ────────────────────────────────────────┤
│  Operational: signal→decide→execute→reflect 10-step pipeline │
│  Evolution: policy evolver + sandbox + canary (policy/)      │
│  Meta outer: self-model → conservative tune → rollback (meta/)│
├─ Kernel Stack (core/) — twenty-eight kernels, 3.0 → 30.0 ──┤
│  Evidence 3.0  Resilience 4.0  Causal 5.0  Free-Energy 6.0   │
│  Deliberation 7.0  Metareasoning 8.0  Abstraction 9.0        │
│  Scientist 10.0  Theorist 11.0                               │
│  Anytime Evidence 12.0  Conformal 13.0  Quality-Diversity 14.0│
│  Runtime Verification 15.0  Shapley Attribution 16.0          │
│  Optimal Transport 17.0  Info-Geometry 18.0                  │
│  Optimal Stopping 19.0  Sheaf Consensus 20.0                  │
│  Gittins 21.0  Budget Knapsack 22.0   (genesis layer)         │
│  Robust Stats 23.0  Diff-Privacy 24.0  Capacity 25.0          │
│  Gaussian Process 26.0  Kalman 27.0  Extreme Value 28.0       │
│  MCTS 29.0  Submodular 30.0            (prophet layer)        │
└──────────────────────────────────────────────────────────────┘
```

## Core Features

### Proactive Perception & Autonomous Decision-Making
- Sentinel multi-source signal ingestion (webhook / filesystem watch / polling / manual injection), aggregation-window dedup and urgency ranking
- Strategic decision engine: execute / defer / dismiss / ask-user, continuously calibrated by statistical learning (time decay + Wilson lower bound + UCB cold start)
- Experience retrieval + DAG plan generation + multi-model parallel execution, a 10-step unidirectional pipeline

### Scientist / Theorist Dual Mind
- **Scientist kernel** ([core/scientist.ts](./src/core/scientist.ts)): Bayesian optimal experiment design — pricing "knowledge acquisition itself". True EIG (nats) to value an experiment's information, confounding bonus (experiment-exclusive value), budget arbitration (netValue = EIG − cost), information-ledger calibration, knowledge-frontier contraction
- **Theorist kernel** ([core/theorist.ts](./src/core/theorist.ts)): hierarchical Bayes + MDL (understanding as compression) — compressing data into laws. Same-family edges converge into laws (borrowing-strength shrinkage), compression pricing (log Bayes factor), zero-shot prediction, anomaly detection, paradigm shifts (Kuhn leap)

### Anytime Evidence / Conformal / Diversity / Formal Safety / Fair Attribution (12.0 → 16.0)
- **Anytime-evidence kernel** ([core/anytime-evidence.ts](./src/core/anytime-evidence.ts)): confidence sequences + e-processes — **peeking is legal at any moment**. Time-uniform confidence intervals (stitched CS) are valid whenever read; e-process capital adjudicates hypotheses via Ville's inequality, and genome eliminations go through the e-BH process with an FDR cap (a mathematical bound on wrongful eliminations); once mounted on the meta-cognition KPI guarantee layer, degradation/recovery verdicts upgrade to an episodic regime state machine (evidence accumulates separately on each side of the watermark, resetting on crossing — peeking-immune, recovery-detectable)
- **Conformal kernel** ([core/conformal.ts](./src/core/conformal.ts)): distribution-free exact coverage — **prediction intervals with zero distributional assumptions**. Split conformal intervals give finite-sample exact guarantees (P(actual ∈ interval) ≥ 1−α); a coverage-drift monitor detects miscalibration via a predictable-λ betting e-process; threshold self-calibration upgrades to risk-controlled selection (empirical Bernstein upper bounds + Bonferroni, P(future retry rate ≤ target) ≥ confidence)
- **Quality-diversity kernel** ([core/quality-diversity.ts](./src/core/quality-diversity.ts)): MAP-Elites behavioral archive — **diversity collapse is structurally blocked**. Strategy genomes fall into niche grids by behavioral descriptors (daring / frugal / vigilant), every school gets an equal trial budget (uniform frontier sampling); the QD-score measures quality and coverage together, so evolution no longer converges to a single solution
- **Runtime-verification kernel** ([core/runtime-verification.ts](./src/core/runtime-verification.ts)): LTLf specification monitoring — **safety specs made formal, verdicts carry proofs**. The default spec set (no failure storms / commands must be answered / periodic heartbeat / authorize-before-execute) compiles into four monitor atoms; violation reports carry full evidence traces and counterexample witnesses; severity-based escalation (critical → Kill Switch, warn → circuit breaker, info → audit)
- **Shapley kernel** ([core/shapley.ts](./src/core/shapley.ts)): axiomatic fair attribution — **value split backed by a mathematical theorem**. Efficiency / symmetry / dummy / additivity axioms all hold exactly; permutation sampling with anytime-valid confidence intervals (bounds while you sample, guaranteed whether you stop or not); synergy detection automatically flags 1+1>2 positive synergies and free-riding negative ones

### Optimal Transport / Information Geometry / Optimal Stopping / Sheaf Consensus (17.0 → 20.0)
- **Optimal-transport kernel** ([core/optimal-transport.ts](./src/core/optimal-transport.ts)): Wasserstein distance + Sinkhorn — **drift detection sees the shape of the distribution**. Exact 1-D W₁ (quantile coupling, O(n log n)), log-domain stabilized Sinkhorn (arbitrary cost matrices), Wasserstein barycenter (shape-preserving distribution fusion); once the shape-aware drift monitor (sliding window vs disjoint reference + adaptive quantile threshold) is mounted on meta-cognition — **"the mean didn't move but the world changed" becomes visible for the first time** (fills the blind spot of the 12.0 watermark detectors, tripwire for 13.0 conformal validity)
- **Information-geometry kernel** ([core/information-geometry.ts](./src/core/information-geometry.ts)): Fisher metric + KL trust region — **evolution walks on the manifold**. Strategy mutation upgrades from per-coordinate noise to joint correlated steps along the population-covariance principal axes (favorable gene combinations transfer whole); step size is priced in nats (Mahalanobis-capped KL trust region) and **strictly invariant under affine reparameterization** (numerically verified: identical to 6 decimals after 100×/0.01× coordinate rescaling); condition number / effective dimension make the search geometry itself observable
- **Optimal-stopping kernel** ([core/optimal-stopping.ts](./src/core/optimal-stopping.ts)): prophet inequality + backward induction — **waiting has a mathematical price**. Exact stopping-value recursion over the empirical distribution (V_k = E[max(X, V_{k+1})]), prophet benchmark (exact order-statistics E[max]), Samuel-Cahn single-threshold rule (≥ ½ of prophet for any distribution), secretary 1/e rule and Bruss' odds algorithm; once mounted on decision-engine Rule C, **defer/execute for costly signals upgrades from the "urgency < 0.3" magic number to a continuation-value verdict** (act iff current value ≥ V_{horizon} — mathematically optimal to grab the slot, otherwise waiting pays)
- **Sheaf-consensus kernel** ([core/sheaf-consensus.ts](./src/core/sheaf-consensus.ts)): cellular-sheaf Laplacian + harmonic consensus — **the shape of disagreement is visible**. "Who must agree with whom, on which claims" becomes a first-class mathematical object (vertex stalks + edge restriction maps); weighted harmonic consensus (dual solve: soft mediation + best fit on the perfect-consensus manifold) reports the consensus assignment, per-source walk-back distances (outlier localization), and **structural-obstruction detection** — under circular hard constraints with contradictory observations (0.9/0.1/0.5) averaging says a happy 0.5, this kernel says "no solution exists, resolve the contradiction first"; the `sheaf_consensus` Tool lets the LLM call structured belief fusion at reasoning time

### Genesis Layer (21.0 → 25.0)
- **Index-scheduling kernel** ([core/index-scheduling.ts](./src/core/index-scheduling.ts)): exact Gittins index computation — **model scheduling gets its first provably-optimal policy**. Retired-MDP backward induction over the (α,β) triangle yields exact discounted-bandit optimal indices; the learning premium ν − p̂ self-terminates as evidence accumulates (no hand-tuned exploration budget)
- **Budget-optimal routing kernel** ([core/bandit-knapsack.ts](./src/core/bandit-knapsack.ts)): Bandits with Knapsacks — **shadow prices emerge endogenously from budget scarcity**. Empirical-Bernstein optimism for quality, feasibility from remaining-budget-per-round, the shadow price λ solved live from a mixed-LP vertex of infeasible-high-quality arms vs selected arms
- **Robust-statistics kernel** ([core/robust-statistics.ts](./src/core/robust-statistics.ts)): Catoni estimator + median-of-means — **heavy-tailed latencies no longer kidnap the mean**. Sub-Gaussian confidence under finite variance only (5% contamination at 1e6 magnitude drags the plain mean to 50000, Catoni holds it at 2.69 — four orders of magnitude of robustness); per-model latency streams adapt mean → MoM → Catoni with sample size
- **Differential-privacy kernel** ([core/differential-privacy.ts](./src/core/differential-privacy.ts)): Laplace/Gaussian mechanisms + Rényi-DP accounting — **telemetry never exposes individuals**. Halving budget allocation never overspends (Σε ≤ ε), ids/timestamps auto-skipped, analytic RDP→(ε,δ) conversion
- **Capacity-planning kernel** ([core/capacity-planning.ts](./src/core/capacity-planning.ts)): Erlang-C / Kingman inversion — **concurrency limits are computed from queueing theory**. Heartbeat phase 2.5 feeds the world-model predicted arrival rate × robust mean latency into the planner, inverting the minimum concurrency that holds the target wait; honestly returns infeasible when ρ ≥ 1

### Prophet Layer (26.0 → 30.0)
- **Gaussian-process kernel** ([core/gaussian-process.ts](./src/core/gaussian-process.ts)): RBF/Matérn Bayesian regression + expected improvement — **prediction bias itself becomes a learnable curve**. The world-model calibration history's actual/predicted ratio series feeds a GP regression that returns a multiplicative correction factor with uncertainty (the 1.25/0.75 trend magic numbers are taken over by learned corrections); the analytic-EI acquisition function (verified against Monte Carlo) powers discrete-candidate Bayesian optimization
- **Kalman-filter kernel** ([core/kalman-filter.ts](./src/core/kalman-filter.ts)): local-linear-trend filtering + RTS smoothing + NIS gating — **anomaly detection upgrades from heuristics to a hypothesis test**. The full KPI history compresses into (level, slope) sufficient statistics; an alarm fires only when the normalized innovation squared exceeds the χ²(1) 99.7% quantile; slow drifts get early readings from the filtered slope; the random-walk steady state matches the closed form P∞=(√(q²+4qr)−q)/2 exactly
- **Extreme-value-theory kernel** ([core/extreme-value.ts](./src/core/extreme-value.ts)): POT/GPD + Hill estimation — **p99.9 is no longer the luck of the sample maximum**. Pickands–Balkema–de Haan guarantees threshold exceedances converge to a GPD; Grimshaw profile likelihood reduces the 2-D MLE to a 1-D search; tail quantiles are extrapolated with theorem backing (plus bootstrap CIs); heartbeat phase 2.7 assesses latency tail risk and emits tail-risk insights beyond target
- **Monte-Carlo-tree-search kernel** ([core/mcts.ts](./src/core/mcts.ts)): UCT + discounted returns — **the allocation of search budget itself becomes a sequential decision**. Transition edges sample Bernoulli outcomes from Beta posteriors, UCB1 balances exploit/explore, node-local returns backpropagate without depth bias, and any exhausted iteration/time budget reads out immediately (anytime property); the deliberation engine's `searchMcts` cross-checks beam search under one shared report format
- **Submodular-optimization kernel** ([core/submodular.ts](./src/core/submodular.ts)): weighted coverage + lazy greedy (CELF) — **exploration-budget allocation gets its first approximation-ratio guarantee** (≥ (1−1/e)·OPT, Nemhauser–Wolsey–Fisher). Knowledge items are themes of their own with similar items partially covering them: a redundant second pick's marginal decays to (1−c)·w, complementary blind spots get picked first; a curvature refinement tightens the guarantee to (1−e^−c)/c·OPT

### Kernel Stack (core/, 3.0 → 30.0)
| Kernel | Version | In one line |
|------|------|--------|
| evidence.ts | 3.0 | Unified evidence language: Wilson bounds / time decay / evidence ranking, spread across all memory layers |
| resilience.ts | 4.0 | Resilient execution: circuit-breaker state machine / full-jitter exponential backoff / error typing |
| causal-kernel.ts | 5.0 | Causal inference: Pearl do-intervention ATE / confounding detection / counterfactual queries |
| free-energy.ts | 6.0 | Active inference: Friston free energy, one formula unifying exploit/explore/curiosity/health |
| deliberation.ts | 7.0 | Planning as inference: imagined rollouts + beam search × skill macros + dream reconciliation |
| metareasoning.ts | 8.0 | Rational metareasoning: dual-process arbitration / anytime stable stopping / thinking priced in nats |
| abstraction.ts | 9.0 | Abstraction: state-skeleton decomposition + structural analogy, cross-domain "learning by analogy" |
| scientist.ts | 10.0 | Scientist mind: Bayesian optimal experiment design (see above) |
| theorist.ts | 11.0 | Theorist mind: hierarchical Bayes + MDL law induction (see above) |
| anytime-evidence.ts | 12.0 | Anytime evidence: confidence sequences + e-processes + e-BH FDR (see above) |
| conformal.ts | 13.0 | Conformal: distribution-free intervals + risk-controlled thresholds (see above) |
| quality-diversity.ts | 14.0 | Quality-diversity: MAP-Elites behavioral archive (see above) |
| runtime-verification.ts | 15.0 | Runtime verification: LTLf spec monitoring + proof-carrying verdicts (see above) |
| shapley.ts | 16.0 | Shapley: axiomatic fair attribution + anytime-valid confidence intervals (see above) |
| optimal-transport.ts | 17.0 | Optimal transport: Wasserstein drift + Sinkhorn + barycenter (see above) |
| information-geometry.ts | 18.0 | Information geometry: Fisher-metric natural mutation + KL trust region (see above) |
| optimal-stopping.ts | 19.0 | Optimal stopping: prophet inequality + backward induction + opportunity stopper (see above) |
| sheaf-consensus.ts | 20.0 | Sheaf consensus: cellular-sheaf Laplacian + harmonic consensus + obstruction detection (see above) |
| index-scheduling.ts | 21.0 | Index scheduling: exact Gittins index (retired-MDP triangle backward induction), provably-optimal model scheduling (see above) |
| bandit-knapsack.ts | 22.0 | Budget-optimal routing: Bandits with Knapsacks, shadow prices from budget scarcity (see above) |
| robust-statistics.ts | 23.0 | Robust statistics: Catoni + MoM, sub-Gaussian bounds under heavy tails (see above) |
| differential-privacy.ts | 24.0 | Differential privacy: Laplace/Gaussian mechanisms + Rényi-DP accounting (see above) |
| capacity-planning.ts | 25.0 | Capacity planning: Erlang-C / Kingman minimum-concurrency inversion + Little's-law check (see above) |
| gaussian-process.ts | 26.0 | Gaussian process: RBF/Matérn regression + EI Bayesian optimization, learnable prediction bias (see above) |
| kalman-filter.ts | 27.0 | Kalman filtering: local-linear-trend + RTS smoothing + NIS gating (see above) |
| extreme-value.ts | 28.0 | Extreme value theory: POT/GPD tail extrapolation + Hill estimation + risk measures (see above) |
| mcts.ts | 29.0 | Monte-Carlo tree search: UCT + discounted returns + anytime readout (see above) |
| submodular.ts | 30.0 | Submodular optimization: weighted coverage + CELF lazy greedy + curvature-refined guarantee (see above) |

### Cognitive Energy Symbiosis Economy (symbiosis/)
- **Energy ledger** (ledger.ts): cognitive energy cannot be forged — global conservation via double-entry bookkeeping, every transfer sha256-chained for audit and replay, a Gini coefficient measures ecosystem health
- **Knowledge market** (market.ts): knowledge as a tradeable asset in a continuous double auction; listing fees burned against spam, central bank pays post-sale royalties, low-quality knowledge is naturally eliminated by evidence calibration
- **Belief market** (belief.ts): an LMSR market maker turns "judgments about the future" into tradeable assets — the market as a mind; informed agents arbitrage the wrong, settlement is the audit, incentives are compatible
- **Agent contracts** (agent.ts): perception / proposal / execution separated (legislation–enforcement split), reputation reuses the Wilson lower bound — contribution determines dividends, poor performers starve into dormancy
- **Symbiosis runtime** (runtime.ts): heartbeat orchestration (survive → perceive → propose → regulator veto → match → authorized execute), successful tasks mint dividends weighted by Wilson, balances below the survival line trigger dormancy, regulator holds a one-vote veto; **mounted in shadow mode, never taking over the main pipeline**
- **Host fusion bridge** (bridge.ts): three thin touchpoints — KPI injection into the energy economy, task settlement minting dividends, futarchy evolution voting — off by default, zero drift
- **First agents** (wrappers.ts): MemoryAgent (seller + maintainer) / OptimizerAgent (buyer) / EvolverAgent (strategy-gene seller), forming the minimal closed cognitive economy
- **Observability** (observability.ts): aggregates ledger vouchers into a Sankey panorama of energy flows, rendered offline as self-contained HTML (see [symbiosis-sankey-demo.html](./symbiosis-sankey-demo.html))

### Self-Reflection & Evolution
- Goal engine: generates goals from insights and decomposes them into subtasks
- Quality reflection engine: auto-retry / model switching below threshold, with the threshold self-calibrating against the quality distribution
- Meta-cognition layer (meta/): the self-model engine produces four-view mental reports (strategy performance / memory health / evolution efficiency / system stability); the meta-controller tunes conservatively (one step per round, observation window, rollback on regression)
- Strategy evolution: genetic algorithms evolve decision genes + the policy evolver (policy/) with population evolution, multi-seed sandbox evaluation, LCB gating, canary hot-swap, and automatic rollback
- Long-term memory: task patterns, model profiles, and lessons persisted across sessions

### Memory System & Retrieval Augmentation
- **Three-layer memory + knowledge distillation**: episodic → semantic / procedural memory, watermark-gated distillation, stable ids, evidence merging with conflict resolution
- **SQLite persistence**: zero-dependency on Node's built-in `node:sqlite` — relational tables (`task_patterns` / `model_profiles` / `decision_feedback` + `distilled_strategies` / `meta`), WAL, versioned migrations, and maintenance APIs (integrity check / hot backup / vacuum / read-only SQL channel); automatically falls back to a JSON atomic-write backend when encryption is on or the host lacks `node:sqlite` ([memory/backend.ts](./src/memory/backend.ts))
- **Hybrid retrieval**: FTS5 dual tokenization (trigram Chinese substrings + token-level) + sparse TF-vector cosine + memory-graph association, merged via four-way recall (`optimizer.hybridSearch`)
- **Memory graph**: co-occurrence network and topic tree serialized to JSON across restarts ([memory/memory-graph.ts](./src/memory/memory-graph.ts))
- **Anti-hallucination short indices**: long IDs become `#1…` short indices before LLM injection and are decoded back afterwards ([memory/alias-map.ts](./src/memory/alias-map.ts))

### Engineering Infrastructure
- Raft consensus, distributed sync, hot reload, AES-256-GCM encrypted storage
- Multi-tenancy, benchmark engine, zero-dependency WebSocket progress (native RFC 6455), visual dashboard
- 18 registered tools, plus a host-fusion layer for whole-host observability and safety governance

## Autonomy Loop

Each heartbeat runs an 11-step orchestration ([autonomy-loop.ts](./src/autonomy-loop.ts)):

1. **Meta-cognition observation** — collect KPIs, surface anomaly insights
2. **1.5 Symbiosis heartbeat** — inject KPIs into the energy economy + belief market
3. **World-model foresight** — predict signal arrivals, capture rising trends
4. **Merge reflection lessons** — consolidate lessons from the reflection engine, skipping digested ones
5. **Goal generation** — auto-create improvement goals from insights and decompose subtasks
6. **Subtask dispatch** — inject into execution after safety governance review
7. **Curiosity exploration** — spare budget spent on knowledge-gap exploration
8. **Strategy evolution** — evolve decision strategies via genetic algorithm
9. **7.5 Policy evolver** — scheduling policies sandbox-verified, then canary hot-swapped
10. **7.7 Meta-cognition loop** — self-model → conservative adjustment → observe / rollback (low frequency)
11. **8. Memory maintenance** — experience distillation + forgetting curve (low-frequency background)

## Three Pathways to "Smarter with Use" (missing any one degrades to a static system)

1. **Experience-driven model selection**: recommended model combinations actually participate in node assignment by node type (`Optimizer.lookupExperience → ModelScheduler.assignModel`), not merely as prompt hints
2. **Strategy feedback calibration**: distilled strategies write back application success rates by execution outcome — effective strategies grow stronger with use, ineffective ones are naturally eliminated
3. **Experience fast path**: matching a high-confidence pattern (default ≥ 0.9, tunable via `memoryFastPathThreshold`) directly recalls the best historical successful plan (`Optimizer.recallPlan`), skipping LLM re-planning — faster, more stable, and cheaper on tokens with every use

Three hedging mechanisms (safety valves against "learning the wrong things"):

1. **Forgetting curve**: long-unused memories decay in confidence per an Ebbinghaus model until fully forgotten; decay is idempotent on a `lastDecayAt` baseline
2. **Confidence decay**: successes add, failures subtract; long-unverified strategies decay and are pruned
3. **Threshold self-calibration**: high quality distributions tighten the threshold, low ones relax it, avoiding futile retry storms

## Installation

Requirements: Node.js `^22.18.0 || >=24.11.0`, pnpm.

```bash
git clone https://github.com/beijingwahw/dsh-proactive.git
cd dsh-proactive
pnpm install
pnpm build
```

## Configuration (Zero Manual Setup)

**Works out of the box — no manual model or key configuration required, and the plugin itself never holds an API Key.**

- The bundled [cordis.patch.yml](./cordis.patch.yml) already packages all domestic models (DeepSeek / Qwen / Zhipu GLM / Kimi / MiniMax / iFlytek Spark / Tencent Hunyuan / Baidu ERNIE / SenseTime SenseChat); load and run;
- At runtime the plugin obtains the configured LLM client from the ctx context, and DSH automatically injects the user-configured Key (Web UI or environment variables) into request headers;
- **Automatic key pickup**: the plugin also reads host-local keys and fills them into request headers by vendor, with priority host ctx injection → process environment variables (e.g. `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY`, matched by model id prefix) → DSH local config files (`~/.dsh/config.json`, etc., hot-reloaded on mtime change and re-probed periodically when absent); keys stay in memory only — never persisted or logged;
- **Multi-key failover**: when several candidate keys exist for a vendor, auth failures (401/403) or quota exhaustion (429) automatically rotate to the next candidate key, upgraded with **health-aware routing** — keys are selected by success/failure statistics, with a 1-minute cooldown for 429 and a 5-minute cooldown for 401/403, auto-recovering on success; users can reorder key usage via the `manage_keys` tool (persisted across restarts); startup logs report each model's key sources (never the key values), and runtime key health is inspectable via `query_memory keys`;
- For a single vendor only, use the per-vendor patches under `patches/domestic-models/`; regenerate with `pnpm generate:patches`.

All runtime options (sentinel / encryption / sync / consensus / hot reload / tenants / autonomy loop `autonomy` / host fusion `hostFusion`) are likewise built into [cordis.patch.yml](./cordis.patch.yml) and need no changes; symbiosis options live under `autonomy.symbiosis` (futarchy voting, energy feedback, etc., off by default). Guarantee-layer kernel options 12.0-16.0 and geometry/topology-layer options 17.0-20.0 are also off by default (zero drift): `autonomy.anytimeEvidence` (α / reference watermark), `autonomy.conformal` (α / calibration capacity / threshold risk & confidence), `autonomy.qualityDiversity` (explore rate), `autonomy.runtimeVerification` (additional `specs`), `autonomy.optimalTransport` (monitored KPIs / windows / threshold quantile), `autonomy.informationGeometry` (KL budget / step scale), `autonomy.optimalStopping` (opportunity horizon / min samples), `autonomy.sheafConsensus` (obstruction misfit tolerance).

## Tool Catalog (18 + sheaf consensus Tool, off by default)

| Group | Tools |
|------|------|
| Execution & scheduling | `autonomous_execute` · `model_dashboard` · `run_benchmark` |
| Memory & knowledge | `query_memory` · `query_experience` · `distill_knowledge` · `maintain_memory` · `memory_migration` |
| Meta-cognition | `mental_report` · `self_knowledge` · `meta_cognition` |
| Autonomy governance | `manage_autonomy` · `manage_keys` |
| Infrastructure | `manage_tenants` · `manage_encryption` · `manage_sync` · `manage_consensus` · `manage_hot_reload` |
| Sheaf consensus (off by default) | `sheaf_consensus` (20.0: structured multi-source belief fusion + structural-disagreement detection, enable via `autonomy.sheafConsensus.enabled`) |

Get the seven-dimension introspection report via `manage_autonomy`:

```jsonc
// Call: manage_autonomy { "action": "introspect" }
// Response (excerpted example):
{
  "loop":      { "running": true, "tickCount": 42 },
  "health":    { "score": 0.86 },
  "goals":     { "active": 3 },
  "exploration": { "totalExplorations": 5 },
  "governance":  { "circuitState": "closed" },
  "worldModel":  { "types": 4 },
  "evolution":   { "generation": 7 }
}
```

Other common operations:

- `manage_autonomy`: `start` / `stop` / `tick` / `kill-switch` / `revive` / `reset-circuit`
- `query_memory`: `world-model` / `curiosity` / `governance` / `patterns` / `lessons` / `keys`, etc.

## Offline Verification (35, zero API keys)

Every kernel and subsystem has an offline end-to-end verification script (`node scripts/verify-*.mjs`):

```bash
node scripts/verify-scientist.mjs      # Scientist: EIG pricing / budget arbitration / frontier contraction
node scripts/verify-theorist.mjs       # Theorist: law induction / zero-shot prediction / paradigm shift
node scripts/verify-symbiosis.mjs      # Symbiosis: ledger / market / 3-agent 6-heartbeat closed loop
node scripts/verify-self-evolution.mjs # Self-evolution: adoption / fast path / three hedging mechanisms
node scripts/verify-anytime-evidence.mjs # Anytime evidence: CS time-uniformity / e-process verdicts / e-BH FDR
node scripts/verify-shapley.mjs        # Shapley: four axioms / confidence intervals / synergy detection
node scripts/verify-frontier-kernels.mjs # Geometry & topology 17.0-20.0: analytic-solution checks / affine invariance / prophet 2/3 / sheaf obstruction
node scripts/verify-frontier-wiring.mjs # Geometry & topology wiring: real engines end-to-end (drift insight / natural mutation / mathematical defer)
node scripts/verify-prophet-kernels.mjs # Prophet layer 26.0-30.0: GP interpolation / EI-vs-MC / Riccati closed form / POT analytic quantile / UCT convergence / CELF-vs-brute-force
node scripts/verify-prophet-wiring.mjs  # Prophet wiring: real engines end-to-end (GP calibration / NIS-gate insight / latency samples to tail extrapolation / UCT cross-check / complementary blind spots)
```

| Group | Scripts |
|------|------|
| Dual mind | verify-scientist · verify-theorist |
| Kernel stack | verify-unified-evidence · verify-resilience-governance · verify-causal-kernel · verify-active-inference · verify-deliberation · verify-metareasoning · verify-abstraction |
| Guarantee-layer kernels 12.0-16.0 | verify-anytime-evidence · verify-conformal · verify-quality-diversity · verify-runtime-verification · verify-shapley |
| Geometry & topology layer 17.0-20.0 | verify-frontier-kernels · verify-frontier-wiring |
| Genesis layer 21.0-25.0 | verify-genesis-kernels · verify-genesis-wiring |
| Prophet layer 26.0-30.0 | verify-prophet-kernels · verify-prophet-wiring |
| Symbiosis economy | verify-symbiosis · verify-symbiosis-bridge · verify-belief-market · verify-futarchy · verify-energy-feedback · verify-full-agents · verify-observability |
| Learning & evolution | verify-self-evolution · verify-self-evolution-v2 · verify-knowledge-distillation · verify-policy-evolution · verify-meta-cognition · verify-meta-cognition-v2 · verify-meta-edge · verify-consensus-sync |

Energy-flow visualization: open [symbiosis-sankey-demo.html](./symbiosis-sankey-demo.html) in a browser (zero-dependency, self-contained page).

## DSH Plugin Spec Compliance

This plugin follows the DeepSeek Harness (cordis) plugin development spec, with the following spec-compliance improvements made without impacting performance:

- **Function plugin shape + static metadata**: the default export is an `apply(ctx, config)` function plugin carrying `name` / `Config` / `provide` static metadata for the registry and loaders;
- **Schemastery Config schema**: `Config` is a standard schema; on load, cordis `resolveConfig` validates types and fills defaults automatically (sentinel / encryption / sync / consensus / hot reload / tenants / autonomy sections). Function-typed injection fields (`nodeRunner` / `judge` / `llm.fetchImpl`, etc.) and nested symbiosis config pass through as extra properties, unaffected by validation;
- **Official Tool registration path**: when the host loads `@deepseek-ai/dsh-tools` (the `ctx.tools` service), the 18 tools are bridged via duck-typing into the official ToolRegistry, joining the pre/around/post execution pipeline and the model-visible surface (parameters converted to the official JSON Schema subset); when the host does not provide it, the plugin silently degrades to the internal ToolRegistry + `ctx.provide('schedulerTools')`, without pulling in the full agent stack;
- **Dependency injection & service declaration**: services are exposed via `ctx.provide('scheduler' / 'schedulerTools')`, with TypeScript declaration merging (`declare module '@deepseek-ai/cordis'`) typing the `Context`;
- **Lifecycle cleanup**: all resources are cleaned up in reverse dependency order via `ctx.effect` on fiber unload (including official tool unregistration);
- **Publish manifest**: `package.json` declares `dsh.bundle.patch` pointing to the [cordis.patch.yml](./cordis.patch.yml) bundle config layer, with complete `exports` / `files` / `engines` / `keywords`, and a `prepare` script ensuring install-time build.

## Host Fusion Layer

Beyond spec compliance, the plugin fuses deeply into the host runtime via cordis cross-fiber events, elevating from a "passive plugin" to a **host-level cognitive & safety layer** (auto-activates when the host loads `@deepseek-ai/dsh-tools`, silently degrades otherwise):

- **Whole-host observability** (`tools/result`, emit): observes every host tool call outcome — each call feeds the world model's `observeArrival` to learn host behavior rhythms (enhanced foresight); tool failures inject a `host-tool-failure` signal into the sentinel, triggering the decision pipeline's self-healing; when the same tool fails consecutively past a threshold (default 3), it auto-escalates: a high-urgency signal plus a lesson persisted to the reflection engine;
- **Whole-host safety governance** (`tools/pre-execute`, waterfall): the scheduler's safety governor gains veto power over the host pipeline — when the kill switch is engaged it freezes all host tool calls (emergency stop escalates from "freezing itself" to "freezing the host"); when the scheduler's own failure spiral trips the circuit breaker it fail-closed rejects host actions; read-only gating (`checkGate`) that consumes no rate-limit/budget;
- **Safety design**: observation is fail-open (its own errors never break the host pipeline), governance is fail-closed (rejects only in explicit unsafe states); self-excludes the scheduler's own 18 bridged tools to avoid feedback loops; zero new dependencies (structural types + declaration merging).

Config section `hostFusion`: `enabled` / `observeToolResults` / `governToolCalls` / `failureEscalationThreshold` (defaults `true / true / true / 3`).

## Project Structure

```
├── cordis.patch.yml              # Bundle config layer (dsh.bundle.patch target, all domestic models, zero keys)
├── symbiosis-sankey-demo.html    # Cognitive-ecosystem energy-flow Sankey panorama (zero-dependency, self-contained)
├── patches/domestic-models/      # Optional per-vendor patches (9 vendors + all-domestic.yml)
├── scripts/                      # Patch generator + 35 offline verification scripts
└── src/
    ├── index.ts                  # Plugin entry: 10-step pipeline orchestration + 18 tool registrations
    ├── types.ts / errors.ts      # Shared type layer / unified error hierarchy (stable machine-readable codes)
    ├── contracts.ts              # Three-pillar interface contracts (IMemoryStore / IReflector / IOptimizer)
    ├── llm-client.ts             # Unified LLM calls: timeout / exponential backoff / concurrency semaphores / cost stats
    ├── progress-ws.ts            # Zero-dependency WebSocket progress broadcast (native RFC 6455)
    ├── sentinel.ts               # Signal perception: multi-source ingestion + aggregation window
    ├── decision-engine.ts        # Strategic decisions: four-level decisions + statistical-learning calibration
    ├── model-scheduler.ts        # Model scheduling: capability × memory weighting × cost awareness × energy feedback
    ├── task-executor.ts          # Task execution: DAG parallelism + quality-reflection retry + cascading
    ├── optimizer.ts              # Optimizer: experience retrieval + hybrid search + fast-path plan recall
    ├── reflector.ts              # Reflector: review + memory update + strategy feedback + distillation
    ├── reflection-engine.ts      # Quality reflection engine: threshold self-calibration / lesson extraction
    ├── goal-engine.ts            # Goal engine: insights → goals → subtasks
    ├── world-model.ts            # World model: arrival prediction / trend detection / calibration (MAE)
    ├── curiosity-engine.ts       # Curiosity engine: knowledge-gap scanning / adaptive exploration budget
    ├── safety-governor.ts        # Safety governor: rate limiting / budgets / circuit breaker / confidence gating / kill switch
    ├── meta-cognition.ts         # Meta-cognition monitoring
    ├── strategy-evolution.ts     # Strategy evolution: genetic algorithms evolving decision genes
    ├── autonomy-loop.ts          # Autonomy loop: 11-step heartbeat orchestration
    ├── host-fusion.ts            # Host fusion layer: whole-host observability + safety governance
    ├── dsh-host.ts               # DSH host integration: LLM client / model catalog / key injection
    ├── core/                     # Kernel stack: fourteen kernels from evidence 3.0 to shapley 16.0
    ├── meta/                     # Meta-cognition layer: self-model + meta-controller (dual-loop outer ring)
    ├── policy/                   # Policy evolver + sandbox: population evolution / canary deployment
    ├── symbiosis/                # Cognitive energy symbiosis: ledger / market / belief market / agents / runtime / Sankey
    ├── memory/                   # Long-term memory: SQLite/JSON dual backend + memory graph + alias map + migration
    ├── consensus/                # Raft consensus
    ├── sync/                     # Distributed sync
    ├── hot-reload/               # Hot reload
    ├── security/                 # Crypto engine (AES-256-GCM)
    ├── tenant/                   # Multi-tenancy
    ├── benchmark/                # Benchmark engine
    └── dashboard/                # Visual dashboard
```

## License

[MIT](./LICENSE)
