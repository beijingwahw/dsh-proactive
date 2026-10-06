# dsh-proactive

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.json)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.18-339933?logo=nodedotjs&logoColor=white)](#installation)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-8250df)](https://github.com/topics/dsh-plugin)

> **Proactive Intelligence scheduling plugin** — a multi-model collaborative scheduling system for the DeepSeek Harness (DSH) ecosystem: it perceives, decides, and evolves on its own, with a built-in **Scientist / Theorist dual mind**, a **cognitive energy symbiosis economy**, and **ninety-eight phase-change kernels (evidence → geometry-topology / genesis / prophet / equilibrium / awakening / flux / fabric / singularity / mind / game / emergence / proof / perception / judgment / execution / evolution / consciousness layers: anytime-valid / conformal / optimal transport / information geometry / sheaf consensus / Gittins / robust statistics / differential privacy / capacity planning / Gaussian process / Kalman filtering / extreme value theory / Monte-Carlo tree search / submodular optimization / adversarial no-regret learning / Hungarian global assignment / random matrix / CVaR distributional robustness / LQR feedback control / persistent homology / information bottleneck / nonlinear dynamics / PageRank spectral ranking / first passage / Jackson queueing networks / FFT spectral periodicity / max-flow / max-min fairness / OCBA budget allocation / quorum intersection / CRDT convergence / Shamir secret sharing / Haar wavelets / low-rank matrix completion / speculative decoding / test-time compute / Whittle index / Lyapunov backpressure / Hawkes self-excitation / belief propagation / variational inference / Langevin sampling / curriculum learning / rate distortion / stable matching / mechanism design / nucleolus / correlated equilibrium / dynamic pricing / simulated annealing / NSGA-II Pareto / compression distance / Mapper graph / partial information decomposition / A* search / sparse recovery / best-arm identification / mirror descent / online calibration / novelty detection / causal discovery / canonical correlation / manifold learning / streaming sketches / argumentation / crowd aggregation / world-model learning / POMDP planning / symbolic solving / options framework / safety barrier / off-policy evaluation / safe policy improvement / preference learning / novelty search / self-play / Hyperband autoML / simulation calibration / interruptible autonomy / global workspace / metacognitive confidence / experience replay / attention economy / self-boundary)**.
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
├─ Kernel Stack (core/) — ninety-eight kernels, 3.0 → 100.0 (century cap) ┤
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
│  No-Regret 31.0  Assignment 32.0  Random Matrix 33.0          │
│  CVaR Robustness 34.0  LQR Feedback 35.0 (equilibrium layer)  │
│  Persistence 36.0  Info-Bottleneck 37.0  Dynamics 38.0        │
│  Spectral Ranking 39.0  First Passage 40.0 (awakening layer)  │
│  Queueing 41.0  Spectral 42.0  Max-Flow 43.0 (flux layer)     │
│  Fair Division 44.0  OCBA 45.0 (flux layer)                   │
│  Quorum 46.0  CRDT 47.0  Shamir 48.0 (fabric layer)           │
│  Haar Wavelet 49.0  Matrix Completion 50.0 (fabric)            │
│  Speculative Decoding 51.0  Test-Time Compute 52.0            │
│  Whittle Index 53.0  Lyapunov Backpressure 54.0               │
│  Hawkes Self-Excitation 55.0   (singularity layer)            │
│  Belief Propagation 56.0  Variational Inference 57.0          │
│  Langevin Sampling 58.0  Curriculum 59.0  Rate Distortion 60.0│
│                                          (mind layer)         │
│  Stable Matching 61.0  Mechanism Design 62.0  Nucleolus 63.0  │
│  Correlated Equilibrium 64.0  Dynamic Pricing 65.0 (game)     │
│  Simulated Annealing 66.0  NSGA-II Pareto 67.0                │
│  Compression Distance 68.0  Mapper Graph 69.0  PID 70.0       │
│                                          (emergence layer)    │
│  A* Search 71.0  Sparse Recovery 72.0  Best-Arm ID 73.0       │
│  Mirror Descent 74.0  Online Calibration 75.0  (proof layer)  │
│  Novelty Detection 76.0  Causal Discovery 77.0  CCA 78.0      │
│  Diffusion Maps 79.0  Streaming Sketches 80.0  (perception)   │
│  Argumentation 81.0  Crowd Aggregation 82.0                   │
│  World-Model Learning 83.0  POMDP 84.0  Symbolic 85.0 (judgment)│
│  Options 86.0  Safety Barrier 87.0  OPE 88.0                  │
│  Safe Improvement 89.0  Preference Learning 90.0 (execution)  │
│  Novelty Search 91.0  Self-Play 92.0  Hyperband 93.0          │
│  Sim Calibration 94.0  Interruptible Autonomy 95.0 (evolution)│
│  Global Workspace 96.0  Metacognitive Confidence 97.0         │
│  Experience Replay 98.0  Attention Economy 99.0               │
│  Self-Boundary 100.0 (consciousness layer, century cap)       │
└──────────────────────────────────────────────────────────────┘
```

In round 3 (v0.8.0), **every module domain** of the three-loop autonomy and symbiosis tiers (sentinel / decision / scheduling / executor / memory / reflection / autonomy / meta-cognition / evolution / world model / symbiosis / distributed / governance / client / benchmark & dashboard / contracts / main pipeline) received a **world-class upgrade**: 18 module domains × 4-6 upgrades each, all opt-in mounts (`attach*` methods / optional config; default = old behavior bit-for-bit), plus a new `src/telemetry/` telemetry audit-bus module (exported from dist) — overview below, full announcement in [UPGRADE-ALL-MODULES.md](./UPGRADE-ALL-MODULES.md) (Chinese).

Round 4 (v0.9.0, theme "Activation & Deepening") then did two things: 16 module domains each picked up **5 brand-new upgrade dimensions** (~80 items total), and the round-3/4 module upgrades were **wired into the main pipeline** via 16 `autonomy.modules.*` flags (flag → attach differential verification, all-off zero drift), with the pipeline itself gaining a deepening trio and the telemetry bus completing phase 2 — overview in the section after next, full announcement in [UPGRADE-ACTIVATION-DEEPENING.md](./UPGRADE-ACTIVATION-DEEPENING.md) (Chinese).

Round 5 (v1.0.0, theme "World-Class Evolution of All Kernels") closes the series: every one of the ninety-eight kernels **itself** advanced another notch along four axes — mathematics / performance / numerical robustness / randomized property testing (80 new APIs consolidated onto the root export) — taking the version straight to the **1.0.0** all-kernels-evolved milestone. Overview in the Round 5 section below; full announcement in [UPGRADE-KERNEL-EVOLUTION.md](./UPGRADE-KERNEL-EVOLUTION.md) (Chinese).

## Round 3 · World-Class Upgrade of All Modules (v0.8.0 Overview)

With the ninety-eight mathematical kernels (3.0 → 100.0) in place, round 3 spreads the upgrade surface across **every module domain** — each engine on the main pipeline, every infrastructure piece, and the symbiosis economy picked up 4-6 quality upgrades. Every upgrade ships with a constructed "old vs new" comparison (not "it changed" but "it is provably better"), and everything is opt-in: `attach*` mounting or optional config; unenabled behavior stays bit-identical to before the upgrade (zero drift).

| Domain | Core upgrades | Key numbers |
|------|----------|------|
| A1 Sentinel (sentinel.ts) | Adaptive aggregation window (3 states) / urgency half-life decay / per-source token-bucket backpressure / provenance-chain cycle guard / NCD near-duplicate / fingerprint stats | Storm residence latency 5× better |
| A2 Decision (decision-engine.ts) | Hysteresis state machine / counterfactual decision ledger (Wilson intervals) / ask-user value-of-information gate / per-context-bucket calibration / decision audit | Boundary flapping −60%; night-drift misses 18 → 0 |
| A3 Scheduling (model-scheduler.ts) | Health-routing circuit breaker (EWMA + exponential backoff + half-open probe) / power-of-two-choices P2C load balancing / 3-tier cost profile / per-model retry budget / scheduling audit | Max load 31 < random 35 < single-point 120 |
| A4 Executor (task-executor.ts) | EDF deadline scheduling / tail-latency hedging / plan-level retry budget / cancel propagation + checkpoint resume / execution audit / deterministic virtual clock | Deadline satisfaction 3/6 → 6/6; p99 300 → 87ms (cost +10%); storm retries 10 → 7; resume saves 40ms |
| A5 Memory (memory/) | Hot/warm/cold tiering / four-way fused retrieval / alias-cooccurrence disambiguation / entry checksum + atomic writes / migration dry-run diff / graph degree stats | Hot-tier hit rate 0.64 vs single-tier LRU 0.50; fixed a pre-existing link() key-concat bug |
| A6 Optimize/Reflect (optimizer/reflector/reflection-engine) | Experience-retrieval confidence routing / 3-dimension recommendation rationale / retry bandit / counterfactual OPE dataset / insight dedup decay / sedimentation value scoring | Retry bandit total cost −50% |
| A7 Autonomy (goal/curiosity/autonomy-loop) | Goal-DAG budget + stale demotion & merge / value × success-rate ranking / topological blind-spot targeted curiosity / 5-phase heartbeat machine / cadence adaptation / phase budget yield | Blind-spot hits 3/3 vs 0/3 |
| A8 Meta-cognition (meta/) | Deadband + ramp + cooldown stabilizer loop / 89.0 adjustment certificate gate (fake improvements with LCB<0 rejected) / self-change log + snapshot rollback / self-assessment calibration / relative KPI band / inner-outer loop arbitration | Oscillation 6 adjusts 3 flips → 3 adjusts 0 flips; morning report 32 batches 0 false alarms |
| A9 Evolution (strategy-evolution/policy) | Certificate-gated evolution loop (sandbox → OPE → LCB → canary → rollback, persistent ledger) / adversarial adaptive difficulty + boundary mining / evolution lineage tree / softmax operator governance / stagnation-restart diversification / evolution budget | "High surface score, poor offline value" intercepted by the OPE gate |
| A10 World model (world-model/host) | Observation-belief fusion (source-reliability Beta learning + true-conflict marking) / time-travel snapshots + key-level diff / host-capability negotiation downgrade chain / host bridge 5 states + idempotency keys / world health | Noise-source key contamination 10 → 0 |
| A11 Symbiosis (symbiosis/) | Order-book invariant engine I1-I5 / LMSR pricing consistency / ledger hash chain + tamper localization / reputation decay + Sybil resistance / argued vetoes / energy Sankey export | Same-window score farming 209.9 → 29.98; fixed the folded-root defect |
| A12 Distributed (consensus/sync/hot-reload) | Seeded Raft fault-injection bench / log-compaction snapshots / CRDT anti-entropy / hot-reload dependency-topology closure / atomic swap rollback | 500 rounds 0 safety violations; anti-entropy traffic −87.5%; closure 2/5 touched |
| A13 Governance (tenant/security/safety-governor) | Max-min water-filling quotas / noisy-neighbor gradient suppression / key-rotation grace / Shamir 5-of-3 escrow / governor action ladder + cooldown / constant-time comparison | Fixed the Shamir non-ASCII mojibake bug |
| A14 Client (llm-client/progress-ws) | Decorrelated jitter backoff / token hard-budget breaker / streaming backpressure bounded buffer / progress coalescing with final-must-emit + gap detection / offset resume / call audit | Avalanche sync std 0 → 165ms+ |
| A15 Benchmark & dashboard (benchmark/dashboard) | Sign test + bootstrap CI / e-process regression detection / BAI focus / structured reports / 98-kernel map + GWT bus + attention-market panels | Nominal coverage 0.947; regression power 0.95 with 0 false alarms; BAI 0.988 vs 0.960 |
| A16 Contracts (types/contracts/errors) | 13-code error taxonomy / runtime validator path-typed errors / 8 brand IDs / Result<T,E> monad laws / event envelope guard | classifyTaxonomy naming disambiguation |
| A17 Main pipeline (index.ts + adapters) | 10-step audit trail ring buffer / 18-tool input validation + schemas / reverse-order resource release audit / introspect 3 new fields / 4 adapters made advisory | Flag overview exactly 50 entries |
| A18 Telemetry bus (src/telemetry/, new module) | Event bus (wildcard / ring / final-must-emit / gap detection) / metrics registry (quantiles / cardinality guardrails) / audit hash chain / trace spans | Four files exported from dist |
| A19 Integration regression | Cross-domain pure-data pipeline smoke (signal→decision→scheduling→execution→reflection→symbiosis settlement→ledger→memory→market) / telemetry × contract alignment / suite-wide `--experimental-transform-types` runner | verify-symbiosis determinism fix |

The verification surface doubled accordingly: 19 new scripts (18 module-domain `verify-mod-*` + 1 cross-domain `verify-mod-integration`), bringing the offline verification total from **81 to 100** (full re-run: 100/100 green; round 4 later expanded it to 119, and round 5 to 138).

## Round 4 · Activation & Deepening (v0.9.0 Overview)

Round 3 equipped every module domain with upgrades worth having; round 4 answers two questions: **how much deeper can it go**, and **how does it actually run**. 16 module domains each received 5 brand-new upgrade dimensions (~80 items; every one still a constructed "old vs new" comparison, opt-in, zero drift), while the scattered `attach*` upgrades were converged into 16 `autonomy.modules.*` flags wired into the main pipeline (flag on = mounted and effective, all off = bit-identical to pre-upgrade), the pipeline itself gained a deepening trio, and the telemetry bus completed phase 2.

| Domain | Core upgrades | Key numbers |
|------|----------|------|
| R4-1 Sentinel | Common-cause burst detection (coincidence-pair lift) / periodic profile (visible period-miss) / cascading priority inheritance / source-quality feedback (autoDiscount ranking) / storm budget sharing | Common-cause lift 3.85 vs independent ≈1.0; silence misses 0 → injected per period; 40 generations self-reporting 0.99 flat → 0.6^k generational decay cap; valid-signal rank 4.0 → 2.0; storm admission 31 → 19 |
| R4-2 Decision | Batch joint deciding (same-type merge sharing one strategist) / decision-fatigue metering / failure-mode clustering (Top-3 exact recovery) / decision-path explainer / undo protocol (3 states) | strategist 10 → 1 call, cost −58.5%; paid decisions 30 → 10; explainer field-by-field consistent |
| R4-3 Scheduling | Ensemble combination optimization (Condorcet) / predictive prewarming / 3-phase cold-start admission (shadow→canary→graduate) / cost-drift alert / specialty profiling | Condorcet ensemble 0.6576 > best single 0.62; prewarm 2010ms early; low-quality newcomer 10/10 → 0/10 admitted; specialty hits 50% → 100% |
| R4-4 Executor | Adaptive parallelism / failure-domain isolation / ETA quantile estimation / plan compression (semantically equivalent) / failure-injection drills | Converges to concurrency 3, duration −59%; innocent migrations 5 → 0; ETA error 885% → 8.2%; plan 6 → 4 nodes semantically equal |
| R4-5 Memory | Conflict arbitration (new evidence wins, old view archived) / aging temperature curve / causal-chain provenance / health audit / cross-task transfer mapping | Kept-warm 0.439 vs neglected 0.051; all 5 defect classes detected; transferable pairs Wilson lower bound 16× apart (0.596 vs 0.036) |
| R4-6 Optimize/Reflect | Cross-task experience transfer (similarity × quality triple gate) / reflection-depth grading (light→heavy escalation chain) / failure knowledge base / confidence propagation / plan-template abstraction | Depth grading saves 25% cost; second failure of the same pattern avoided (effectiveness = 1) |
| R4-7 Autonomy | Goal-resource conflict detection / adaptive exploration budget / 3-tier action safety (mutate without certificate fails closed) / milestone delays / time-window governance (across midnight) | Resource gaps 2 detected with 0 false positives; exploration direction 3 → 4 → 1 converges correctly |
| R4-8 Meta-cognition | Multi-scale monitoring (glitch = noise vs true degradation) / self-efficacy prediction / cognitive-load gate / adjustment-magnitude meta-learning / KPI correlation graph | Three-stage evolution separates glitches from degradation; efficacy separation error ≤ 0.03 with converging calibration; post-crash shrinkage escapes the old deadlock |
| R4-9 Evolution | Diversity dashboard (collapse early warning) / cross-task strategy transfer (useless transfers identified & dropped) / rate adaptation / A/B branch lineage (promote/retire) / freeze protocol | Warning precedes deepest collapse by 3 generations, diversity 8.2× after injection; transfer deploys in generation 1 (+0.22); deterministic 20% traffic split |
| R4-10 World model | Counterfactual shadow world (0-pollution three-way attribution) / uncertainty map (four quadrants) / multi-hypothesis arena (evidence flips ranking) / event causal-chain ledger / host bridge pool | Unknown-quadrant rate 0.3 visible; bad hosts 0 executions |
| R4-11 Symbiosis | Liquidity measurement / inflation governance (circulation target band) / contributor profiling + mutation detection / conditional-settlement contracts (3-way escrow conservation) / manipulation detection | Thin/thick book spread 1818 vs 168bps; 3 over-issuances settled back into band, dividends 40 → 20; wash-trading + circular volume detected |
| R4-12 Distributed | Byzantine detection & isolation / partition-healing report (truncations explicitly booked) / single-step membership change / cross-cluster federation (selective sync) / hot-reload canary | After isolation 5 → 4 nodes commit as usual; 3 → 5 → 4 with no dual leader; federation transfers 77.3%; bad version rolls back only its canary cells |
| R4-13 Governance | Quota forecasting (slope-extrapolated warning) / tiered keys (differentiated rotation) / event-forensics timeline (triple verification) / compliance export (SHA-256) / threat-score jumping | Warning 1000ms early with 0 false positives; wrong-tier usage alerted; high-risk direct in 1 hit vs old 4 hits with 3 cooldowns |
| R4-14 Client | Model-capability probing (failures never overstated) / priority queue (preemption + timeout) / streaming resume / snapshot + incremental seamless / cost reconciliation | Retransmission −60%, honest fallback when protocol lacks support; reconciliation discrepancies detected |
| R4-15 Benchmark & dashboard | Long-term trends (Mann-Kendall / Theil-Sen) / recommendation engine / comparison matrix (significance marking) / alarm panel / layout persistence | Flat stream 0/48 false alarms (old two-point diff cried 12/19); recommendations 12/12 vs random 2/12; significance matches pairwise tests |
| R4-16 Contracts | API semantic-version negotiation / schema-evolution chain (honest upgrade/downgrade audit) / declarative invariant library / type dependency graph (topo order + cycle detection + DOT) / error retry-strategy taxonomy | 15-combination negotiation matrix fully covered |
| R4-17 Main pipeline (activation wiring) | 16 `autonomy.modules.*` flags uniformly activating round-3/4 module upgrades (flag → attach differential verification, all-off zero drift) + deepening trio: cross-step cache / degradation ladder / step prefetch | Cache hits bit-identical to direct computation; degradation three rungs in order with consistent fallback; prefetch 62 → 50 units, zero staleness |
| R4-18 Telemetry phase 2 | Sliding-window aggregation / deterministic sampling (Bresenham, errors always delivered) / Prometheus text export / dual-threshold retention (chain-anchored) / trace tail sampling | Sampler restored by estimator; retention chain verification passes |
| R4-19 Integration regression | Five-segment joint smoke (activation wiring / perceive→decide→execute / economy-governance-telemetry / dashboard / Prometheus + audit retention) + symbiosis wall-clock fix (injected frozen clock) | 55 assertions all green |

The verification surface grew accordingly: 19 new scripts (16 domain `verify-r4-*` + pipeline `verify-r4-pipeline` + telemetry `verify-r4-telemetry` + integration `verify-r4-integration`), bringing the offline verification total from **100 to 119** (full re-run: 119/119 green; round 5 later expanded it to 138).

## Round 5 · Evolution of All Kernels (v1.0.0 Overview)

With both module layers saturated, round 5 returns to the **kernel layer itself** — no new kernels; instead each of the ninety-eight existing kernels (3.0 → 100.0) advances another notch along four axes:

- **Mathematical evolution**: new theorem-backed capabilities (closed forms / exact algorithms / tighter bounds) — closed-form Bayes factors, natural direct/indirect effects, k-choice prophet inequalities, closed-form hyperbolic Fisher distance, the LQG separation theorem...
- **Performance evolution**: complexity improvements + **equivalence proofs** (the new implementation matches the old one bit-for-bit or within analytic tolerance — "faster" is never allowed to mean "maybe wrong") + scale-vs-time comparisons — nucleolus 13937ms → 1ms, combinatorial-auction branch & bound ×6141, landmark diffusion 69×...
- **Numerical robustness**: hardening against ill-conditioned inputs and log-domain rewrites (bounded in under/overflow regimes, conservation laws preserved) — log-domain WIS (the naive path throws outright), ten-thousand-step e-process capital, Joseph-form covariance strictly symmetric over 2000 steps...
- **Randomized property testing**: every kernel faces ≥ 200 seeded inputs checking mathematical properties (unbiasedness / coverage frequencies / monotonicity / conservation laws / metric axioms / convexity), with fixed mulberry32 seeds and fully deterministic replay.

The 98 kernels are organized by mathematical affinity into **18 groups** (statistics / causal / Bayesian computation / metacognition / information geometry / planning & search / decision computing / online learning / control & optimization / stochastic processes / spectral methods / topology & dynamics / fair division / consensus & verification / evolutionary learning / game & mechanisms / learning systems / resilient autonomy), each closed out by its own `verify-r5-*` script; **80 new kernel APIs are consolidated onto the root export** (per-symbol runtime reachability asserted against `dist/index.mjs`). The verification surface gained 18 group scripts + 1 integration regression (1,471 assertions in total), bringing the offline verification total from **119 to 138**.

| Group (kernel numbers) | Signature evolutions (1-2 picks) | Key numbers |
|------|------|------|
| Statistics (3.0/12.0/13.0/23.0/24.0) | Closed-form Bayes factor + Kass–Raftery grading / mixture e-processes; Mondrian conditional conformal; Hodges–Lehmann estimation; exponential mechanism + optimal RDP order | Mixture e-process power 2.7×; imbalanced-group coverage 18.8% → 93.0%; HL breakdown point 29.3%; optimal order cheaper in 200/200 |
| Causal science (5.0/10.0/11.0/77.0) | Natural direct/indirect effects (front-door adjustment); exact-DP GES; submodular-greedy batch EIG; MDL two-part code | total = NDE + NIE identity; GES globally optimal for d ≤ 12 |
| Bayesian computation (6.0/26.0/27.0/57.0/58.0) | Canonical EFE decomposition; natural gradient; underdamped MALA; FITC sparse GP; UKF ≡ KF + Joseph form | Natural gradient 12 vs 2000 steps; ESS 424 vs 116; m = n degenerates to the exact GP |
| Metacognition (7.0/8.0/9.0/96.0/97.0) | Bayesian persuasion model; closed-form Poisson optimal stopping; rate-distortion optimal abstraction granularity; GWT temperature annealing; type-2 ROC parameter fitting | Abstraction granularity priced by the rate-distortion theorem; winner distribution controllable after annealing |
| Information geometry (17.0/18.0/37.0/68.0/70.0) | Exact 1-D Wasserstein (grid-free); debiased Sinkhorn divergence (Feydy); closed-form hyperbolic Fisher distance; deterministic IB; BROJA KKT certificates; LZ77 compression | Debiasing gives S(μ,μ)=0; NCD resolution 38–44× |
| Planning & search (19.0/29.0/71.0/84.0/85.0) | k-choice prophet inequality; PUCT + subtree reuse; weighted A* w-suboptimality; VSIDS + two-watched literals | Randomized threshold hits the bound 100%; Ĉ ≤ w·C* across all seeds; lazy h at ~39% of the vertex set |
| Decision computing (21.0/22.0/51.0/52.0/53.0/73.0) | Cost-aware Gittins; BwK LP dual certificates; exact Whittle policy iteration; LUCB tracking; exact-DP weighted majority; closed-form tree speculation | Cost Gittins 32.5×; dual certificate on an 8.4× monotone chain; exact Whittle 7× |
| Online learning (31.0/65.0/74.0/75.0/88.0/89.0) | AdaHedge (logarithmic regime); optimistic FTRL; online coverage tracking; scarcity pricing DP; switch-DR; multi-candidate FWER | Constant-stream regret O(1) (1/5 of classical OMD); switch-DR variance down ×10.6; scarcity revenue 1.23× |
| Control & optimization (32.0/34.0/35.0/43.0/54.0/87.0) | CVaR sample-complexity bound; LQG separation theorem; weighted backpressure (beats LQF in heavy traffic); multi-barrier conjunction; sparse assignment with Hall check; Dinic + min-cost flow dual certificates | CVaR saves 49× samples; weighted backpressure beats LQF under heavy traffic |
| Stochastic processes (25.0/28.0/40.0/41.0/42.0/55.0) | M/G/1 Pollaczek–Khinchine + cμ rule; square-root staffing; multivariate Hawkes; harmonic comb with exact Beta p; GPD return levels with delta-CI; closed-form drifted first passage | Hawkes matrix recovery ±0.017; Kleinrock conservation invariant across all K! orders |
| Spectral methods (33.0/39.0/49.0/50.0/78.0/79.0) | Personalized PageRank (dangling double-count fixed); MP density + Tracy–Widom numerics; Gavish–Donoho hard threshold; Daubechies D4 algebraic coefficients; kernel CCA; landmark diffusion | Rank recovery 100%; nonlinear dependence 0.806 vs 0.215; landmark diffusion 69× |
| Topology & dynamics (36.0/38.0/66.0/69.0/76.0/91.0) | H₁ representative cycles + clearing engine; quantile Mapper covers; Wolf Lyapunov; LOF; density-controlled archive pruning; parallel tempering + Luby restarts | Wolf λ₁ ≈ ln2 exactly; parallel tempering 40/40 ≥ single chain |
| Fair division (16.0/44.0/45.0/60.0/63.0/99.0) | Weighted Shapley (partial-permutation DFS); EF1 decision + envy-cycle elimination; nucleolusFast; order-preserving OCBA rounding; weighted Hamming RD; decaying attention | Nucleolus 13937ms → 1ms; EF1 elimination carries a theorem guarantee |
| Consensus & verification (15.0/20.0/46.0/47.0/48.0/56.0) | R+W>n analyzer + grid quorums; delta-CRDT; Feldman VSS; LTLf past operators + DFA minimization; sheaf H⁰ dimension + global sections; Bethe free energy + GDL prefix products | Communication −44%; tampering rejected 100%; online monitoring ×17431 |
| Evolutionary learning (14.0/59.0/67.0/92.0/93.0/98.0) | CVT-MAP-Elites; ε-dominance archive; weakness profiling + α-rank; optimal-curriculum-ordering theorem; three-factor replay; η-sweep theory + async brackets | CVT coverage = 1 > grid; curriculum ordering theorem-backed |
| Game & mechanisms (61.0/62.0/64.0/81.0/82.0/90.0) | Many-to-one capacitated DA (Rural Hospital theorem); combinatorial-auction branch & bound; coarse CE; Bayesian aggregation with known confusion; value-based argumentation VAF; Plackett–Luce | Branch & bound ×6141; fully adversarial crowd aggregated to 1.0 by Bayes |
| Learning systems (30.0/72.0/80.0/83.0/86.0/94.0) | Graph-cut SFMin (globally optimal); SAFE strong-rule screening; prioritized sweeping; automatic bottleneck-skill discovery (Brandes + Tarjan); CountSketch (negative-count cancellation); truncated IW + weighted bootstrap | SFMin = 2ⁿ brute force on 260 seeds; SAFE screening with 0 violations |
| Resilient autonomy (4.0/95.0/100.0) | Full closed-form Weibull + k-of-n Poisson-binomial; multi-source interruption composition invariance + vectorized sweep; multi-step causal chains + other-agent models | k-of-n closed form 1867×; vectorized sweep 6.5×; intention direction ±0.80 |

### 1.0.0: The Five-Round Milestone

- **0.5.0 baseline**: 48 phase-change kernels (3.0 → 50.0, seven layers) + three-loop autonomy + the symbiosis-economy substrate;
- **0.6.0 round 1 (genesis)**: +25 kernels (51.0 → 75.0) laying down "what math can be called", 13 engines wired;
- **0.7.0 round 2 (autonomous essence)**: +25 kernels (76.0 → 100.0, century cap) covering perception/judgment/execution/evolution/consciousness, 14 engines wired;
- **0.8.0 round 3 (world-class upgrade of all modules)**: 18 module domains × 4-6 quality upgrades + the new telemetry bus module;
- **0.9.0 round 4 (activation & deepening)**: 16 domains × 5 brand-new dimensions + 16 `modules.*` flags wired into the main pipeline + the deepening trio;
- **1.0.0 round 5 (world-class evolution of all kernels)**: 98 kernels × four axes + 80 new APIs consolidated on the root export, 138 verification scripts all green — **the all-kernels-evolved milestone**.

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

### Equilibrium Layer (31.0 → 35.0)

> The prophet layer predicts the world's future; **the equilibrium layer admits the world fights back** — adversaries, global constraints, noise, worst cases, and feedback instability. Five mathematical pillars lift scheduling from "predictive optimality" to "adversarial equilibrium".

- **Online-learning kernel** ([core/online-learning.ts](./src/core/online-learning.ts)): Fixed-Share Hedge — **no regret no matter how the adversary plays**. Every statistical learner in the system (Wilson / UCB / Gittins) assumes a stationary distribution; this kernel layers an adversarial view on top: model scores gain a bounded Hedge multiplier ([0.25, 4]), regret against the best fixed model in hindsight is ≤ √(2T lnN) (Freund–Schapire, distribution-free); the α share keeps weights trackable when model capabilities flip (Herbster–Warmuth), and a model under attack loses weight at e^{−η} per failure — an order of magnitude faster than statistical decay
- **Global-assignment kernel** ([core/optimal-assignment.ts](./src/core/optimal-assignment.ts)): Hungarian algorithm (Jonker–Volgenant, O(n³)) — **batch model selection goes from local greedy to global optimum**. Dynamically-assigned nodes in one execution batch form a node × candidate profit matrix solved exactly as a linear sum assignment: the best model is no longer double-booked by same-batch nodes; a **dual certificate** (u_i + v_j ≤ c_ij + complementary slackness + zero gap) makes optimality checkable digit by digit rather than claimed (same proof-carrying philosophy as 15.0)
- **Random-matrix kernel** ([core/random-matrix.ts](./src/core/random-matrix.ts)): Marchenko–Pastur noise edge + eigenvalue cleansing — **correlation upgrades from statistical illusion to falsifiable structural claim**. Most of the spectral structure of an empirical model-failure correlation matrix is pure noise (the MP band); cyclic Jacobi eigendecomposition + Laloux/Bouchaud cleansing absorbs pseudo-correlation into the band (no false alarms), while a top eigenvalue far above the edge with sufficient explained share yields a systemic-risk insight: models sharing a vendor/upstream sink together, and "seemingly diversified" hot spares are an illusion
- **Distributionally-robust kernel** ([core/robust-decisions.ts](./src/core/robust-decisions.ts)): CVaR + Wasserstein balls — **the worst case gets a closed-form price**. Per-model timeout = margin × CVaR_α(latency history) (exact Rockafellar–Uryasev form, backed by the four coherence axioms): heavy-tailed models automatically earn longer budgets, light-tailed ones are no longer clipped by one-size-fits-all; the Wasserstein-1 robust mean is an algebraic identity of Kantorovich–Rubinstein duality (sup = E + ε), and worst-case exceedance inside the ball has an exact finite-sample algorithm
- **Feedback-control kernel** ([core/feedback-control.ts](./src/core/feedback-control.ts)): discrete LQR + Lyapunov certificate — **closed-loop steering of the concurrency ceiling**. The 25.0 queueing inversion produces a static target; this kernel turns computeParallelism into a feedback controller tracking it: the gain comes from the DARE closed form (cross-checked digit-for-digit against fixed-point iteration), and every closed-loop step's stability is *proven* by a Lyapunov function (V(e_{k+1}) − V(e_k) = −(qe² + ru²) to machine precision); deadband anti-chatter and clamping anti-windup retire AIMD-style heuristic tuning

### Awakening Layer (36.0 → 40.0)

> The equilibrium layer plays against the world; **the awakening layer sees its own shape** — the topology of knowledge, the information price of distillation, the dynamical constitution of KPIs, influence emerging from structure, and the probabilistic price of recovery. Five mathematical pillars turn "self-awareness" from a reporting format into computable mathematics.

- **Persistent-homology kernel** ([core/persistent-homology.ts](./src/core/persistent-homology.ts)): H₀ persistence diagram + bottleneck distance — **the shape of knowledge across scales**. Co-occurrence weights as similarity, threshold sweep reveals continents (stable knowledge clusters) and islands (memories co-occurring with nothing — the topological definition of a blind spot); the bottleneck distance carries the Cohen-Steiner–Edelsbrunner–Harer stability theorem (input perturbation δ ⟹ landscape drift ≤ δ). A new `topology` action on `query_memory` reads the knowledge landscape on demand
- **Information-bottleneck kernel** ([core/information-bottleneck.ts](./src/core/information-bottleneck.ts)): Blahut–Arimoto / Tishby — **the information-theoretic price of distillation**. With X = task signatures and Y = outcomes, the IB-optimal retention I(T;Y)/I(X;Y) prices "how much distillable new information this batch carries": homogeneous batches (retention below floor or I(X;Y) < 0.05 nat) are honestly skipped — any watermark only yields duplicate knowledge; the data-processing inequality bounds retention ≤ 1 (three deterministic restarts escape hard-assignment freezes)
- **Nonlinear-dynamics kernel** ([core/nonlinear-dynamics.ts](./src/core/nonlinear-dynamics.ts)): Rosenstein Lyapunov + R/S Hurst — **constitutional classification of KPIs**. Chaotic (λ₁ > 0, with a nearest-neighbor predictability gate that rejects white-noise pseudo-chaos) → forecast horizon ~1/λ₁ steps; persistent (H > 0.5) → trend weighting; anti-persistent (H < 0.5) → breakout discounting; the logistic map's λ₁ = ln2 is the analytic anchor
- **Spectral-ranking kernel** ([core/spectral-ranking.ts](./src/core/spectral-ranking.ts)): PageRank power iteration — **influence emerges from the structure of the knowledge graph**. "Co-occurring with the important makes you important" as a fixed point, linear convergence with mass conservation checkable digit by digit; related() upgrades to edge-weight × neighbor-influence, topInfluential outputs the knowledge skeleton (the keep-the-bones basis for distillation); the exact uniformity of a ring graph is the verification anchor
- **First-passage kernel** ([core/first-passage.ts](./src/core/first-passage.ts)): reflection principle + inverse Gaussian + gambler's ruin — **the probabilistic price of circuit-breaker recovery**. Drift/volatility of failure intervals feed a first-passage model that solves the minimal cooldown such that "confident recovery at target probability"; μ̂ ≤ 0 structural deterioration honestly reports unreachable; the Brownian reflection identity is cross-checked against 20,000 simulated paths

### Flux Layer (41.0 → 45.0)

> The prophet foresees, the equilibrium layer plays, the awakening layer sees itself; **the flux layer turns throughput, periodicity, fairness, and budgets into objects of flow mathematics** — five classic questions, five theorem-backed answers: where the bottleneck station is, what the rhythm is, who caps the ceiling, how slots divide, and where confirmation budget goes.

- **Queueing-network kernel** ([core/queueing-network.ts](./src/core/queueing-network.ts)): Jackson product form + Erlang-C — **the bottleneck station becomes computable**. 25.0 inverts single-station concurrency; 41.0 treats each model as an independent M/M(c) station (product-form marginals) and heartbeat phase 2.9 solves for the highest-rho station — the constraint "no other station being faster helps". Verified: a 120k-event tandem M/M/1 simulation against the analytic sojourn 8/3 and near-zero marginal correlation
- **Spectral-periodicity kernel** ([core/spectral-periodicity.ts](./src/core/spectral-periodicity.ts)): FFT periodogram + Fisher g test — **rhythm is solved from the data**. Hour-of-day heat is a histogram with the period preset to one day; radix-2 FFT plus Fisher's exact g distribution turns any period (minute loops / diurnal / weekly) into a hypothesis test, with a phase-aware harmonic seasonal factor taking over prediction when significant. Verified: FFT round-trip identity, Parseval, injected-period recovery, white noise insignificant
- **Max-flow kernel** ([core/max-flow.ts](./src/core/max-flow.ts)): Edmonds-Karp + min-cut certificate — **throughput ceiling and its constrainer, computed together**. On the type-demand x model-capacity flow network, max-flow is the largest immediately-satisfiable dispatch and min-cut names the constrainer (starved types vs bridge models); cut capacity = flow value is the Ford-Fulkerson certificate (same proof-carrying philosophy as 15.0/32.0). Verified: 200 random graphs against brute-force min cuts
- **Fair-division kernel** ([core/fair-division.ts](./src/core/fair-division.ts)): weighted max-min water-filling — **no one starves, as a theorem**. Exploration budgets per task family upgrade from novelty winner-take-all to progressive filling (Bertsekas-Gallager lexicographic optimality + integer guarantees): hot families may take more, but no active family's relative share gets crushed. Verified: the textbook water-filling solution [4/3, 4/3, 4/3, 1] and the fairness-dominance audit
- **Budget-allocation kernel** ([core/budget-allocation.ts](./src/core/budget-allocation.ts)): OCBA optimal computing budget — **every step of bottleneck-hunting lands on the blade**. Benchmark re-run budgets upgrade from uniform to the Chen et al. closed form (n_i proportional to (sigma_i/delta_i)^2), optimal in the exponential decay rate of P(correct selection) (Glynn-Juneja); reports gain bottleneckFocus. Verified: Monte Carlo P(CS) OCBA >= uniform

### Fabric Layer (46.0 → 50.0)

> The flux layer turns throughput into flow mathematics; **the fabric layer weaves the system's underlying fabric** — the intersection of consensus, the convergence of replicas, the sharding of secrets, the decomposition of scales, and the latent dimensions of capability. Five pillars land on the last five un-upgraded modules.

- **Quorum kernel** ([core/quorum-systems.ts](./src/core/quorum-systems.ts)): quorum intersection + Byzantine 3f+1 bound — **consensus safety is checked, not believed**. The majority minimum-intersection closed form 2q−n matches brute-force enumeration digit for digit; Raft's `quorumAudit()` reports intersection/fault-tolerance/load on real cluster configs; n <= 3f honestly infeasible (non-existence theorem)
- **CRDT kernel** ([core/crdt.ts](./src/core/crdt.ts)): the three merge laws — **replica convergence as an algebraic property**. G-Counter/OR-Set/LWW merges satisfy commutativity/associativity/idempotence, hence byte-identical convergence after out-of-order + duplicated gossip (Shapiro's strong eventual consistency); the DistributedSync CRDT channel verified across two real instances
- **Secret-sharing kernel** ([core/secret-sharing.ts](./src/core/secret-sharing.ts)): Shamir threshold + randomness audit — **trust is sharded, keys are tested**. Any t shares reconstruct exactly (enumerated); t−1 shares leak nothing information-theoretically (reconstruction values equiprobable); CryptoEngine's `shardKey/combineKeyShares` shards real keys; NIST frequency + runs audits test key material
- **Multiscale kernel** ([core/multiscale-wavelet.ts](./src/core/multiscale-wavelet.ts)): Haar wavelets — **slow drifts and fast bursts separate across scales**. Orthogonal decomposition (perfect reconstruction + Parseval energy conservation to machine precision) yields trend level / drift-band energy / instantaneous burst readings; exposed via meta-cognition's `waveletView`
- **Matrix-completion kernel** ([core/matrix-completion.ts](./src/core/matrix-completion.ts)): ALS low-rank factors — **cold-start capability emerges from latent dimensions**. The partially-observed model-x-task ability matrix is completed by alternating least squares (Candès–Recht recovery conditions); unmeasured types are extrapolated from latent factors; the scheduler's `coldStartEstimate` upgrades new-model selection from zero-shot guessing to latent-dimension prediction

### Singularity Layer (51.0 → 55.0)

> Fifteen layers laid the substrate; **the singularity layer turns compute itself into the thing being scheduled** — whether to speculate with drafts, how many votes to cast, whom to activate when unchosen arms keep evolving, how backlogged queues split service, and whether storms are self-exciting. Five mathematical pillars, one closed-form verdict each.

- **Speculative-decoding kernel** ([core/speculative-decoding.ts](./src/core/speculative-decoding.ts)): draft-verify-accept expected-gain closed forms (Leviathan–Kalman–Matias 2023 lineage) — **"a fast model drafts, a strong model batch-verifies" gets its economic verdict**. Given per-token acceptance γ and cost ratio r, the optimal draft length k* comes from a first-order marginal condition and the speedup is S(k) = N(k,γ)/(1+rk); a rejection theorem honestly falls back to direct decoding when γ̂ sits below the break-even (pairings that lose more the longer they run are terminated by mathematics). Once mounted, `speculativePairFor` rules on pairings from latency/cost profiles; γ telemetry adoption opens the channel automatically
- **Test-time-compute kernel** ([core/test-time-compute.ts](./src/core/test-time-compute.ts)): compute-optimal inference scaling — **the price and the ceiling of "thinking longer" are both computed**. Majority-vote accuracy goes through the exact binomial (log-Γ term summation), a β-binomial correlation correction yields the accuracy ceiling and effective sample size (correlation makes samples "fewer"), unreachable targets are honestly refused; a power-law quality-compute curve with Lagrangian water-filling allocates budget across voting/refinement, stopping when marginal gain falls below price. Once mounted on the executor, high-value tasks auto-scale their vote count from p̂ and the target confidence
- **Whittle-index kernel** ([core/whittle-index.ts](./src/core/whittle-index.ts)): restless-MAB first-order relaxation — **when unchosen arms keep evolving, partial-activation scheduling gets an index calculus**. Per-arm subsidy MDPs are solved by bisection on the indifference λ (Whittle 1988; Weber–Weiss asymptotic optimality), with indexability explicitly scanned; the two-state reward family carries an always-indexable theorem with proof (piecewise-affine slope argument over 4 policies). The "restless" sibling of 21.0 Gittins; once mounted, dynamic selection switches to the RMAB regime
- **Lyapunov-drift kernel** ([core/lyapunov-drift.ts](./src/core/lyapunov-drift.ts)): backpressure scheduling + emergent dual prices (Neely 2010) — **queue backlog is itself the priority weight**. The quadratic Lyapunov drift-plus-penalty gives the [O(1/V) suboptimality, O(V) queue] theorem, and the dual price p_i = Q_i/V converges to the optimal multiplier of the capacity-region LP — shadow prices are not estimated, they are queue depths. Once mounted, the executor's in-flight queue ledger becomes visible and price-threshold crossings emit "arrival rate nearing capacity" stability warnings
- **Hawkes kernel** ([core/hawkes-process.ts](./src/core/hawkes-process.ts)): exponential-kernel Hawkes process — **the contagion mathematics of "events begetting events" enters signal perception**. EM fitting (Veen–Schoenberg / Lewis–Mohler, O(N) chain recursions) learns the self-excitation intensity from arrival timestamps, the branching ratio η = α/β < 1 stationarity boundary is checked explicitly; Ogata time-rescaled residuals (should be i.i.d. Exp(1)) act as misfit sentinels, and a closed-form burst forecast extrapolates the next window. Once mounted on the sentinel, the arrival stream's excitation share and burst forecast become readable — Poisson's systematic underestimation of retry storms is corrected

### Mind Layer (56.0 → 60.0)

> The singularity layer schedules compute; **the mind layer upgrades the inference infrastructure for "what to believe, how to approximate, where to step, how hard to learn, what to forget"** — probabilistic fusion, posterior approximation, posterior sampling, difficulty curriculum, and the pricing of forgetting.

- **Belief-propagation kernel** ([core/belief-propagation.ts](./src/core/belief-propagation.ts)): factor-graph sum-product / max-product (Pearl 1988) — **the logical structure of multi-source evidence becomes expressible**. "Mutually exclusive" and "mutually corroborating" look identical (a 0.5) to weighted averaging; the factor graph writes inter-evidence logic as factors, and message passing on trees is exact marginalization (convergence iterations and tree-ness reported with the result). Once mounted, the world model's `fuseBeliefs` outputs joint-posterior marginals — the probabilistic sibling of 20.0 sheaf consensus (which detects where the contradiction is)
- **Variational-inference kernel** ([core/variational-inference.ts](./src/core/variational-inference.ts)): CAVI mean field + ELBO — **the "posterior" upgrades from point estimate + hand-tuned interval to an actual distribution**. ELBO monotonicity is auditable along the trace, and the conjugate linear-regression case recovers the exact posterior; 6.0's KL(q‖p) finally gets a non-degenerate q supply. Once mounted on meta-cognition, KPI regression coefficients report as N(m, s²) — "how uncertain is the parameter" becomes computable
- **Langevin-sampling kernel** ([core/langevin-sampling.ts](./src/core/langevin-sampling.ts)): ULA / MALA + Bures W₂ — **"sample one from the posterior" becomes gradient plus noise**. The invariant distribution is exactly the Boltzmann π ∝ e^{−U}, MALA acceptance is checked against the 0.574 optimum, and the Bures–Wasserstein distance audits the convergence of sample moments to true moments (sampler health). Once mounted, strategy evolution's mutation distribution gets a read-only MALA checkup with genomes bit-identical before/after (zero-drift diagnostics)
- **Curriculum-learning kernel** ([core/curriculum-learning.ts](./src/core/curriculum-learning.ts)): mastery-gated promotion state machine — **"has it practiced enough" gets a definition**. Promotion when the Beta-posterior Wilson lower bound crosses the mastery threshold, demotion after consecutive failures, detours allowed where difficulty is non-monotone; a three-strategy (uniform/hardest/mastery) 200-seed comparison evidences the learning gain. Once mounted on the curiosity engine, exploration difficulty climbs by mastery with exploration bookkeeping unchanged
- **Rate-distortion kernel** ([core/rate-distortion.ts](./src/core/rate-distortion.ts)): Blahut–Arimoto + keep-compress-drop planning — **"what to forget" gets an information-theoretic price**. The binary-source rate-distortion function iterates to 1e-6 exactness; long-term-memory entries are sorted by value density into keep/compress/drop tiers, and the budget-boundary shadow price λ* quantifies "memory store tightening" — watermark magic numbers (how often it arrived) are taken over by whether it is worth remembering. Once mounted, `compressionPlan` outputs the plan read-only; execution stays with the distillation pipeline

### Game Layer (61.0 → 65.0)

> The mind layer trains inward; **the game layer gives the symbiosis economy the mathematics of market design** — matching that is stable, bidding that is truthful, profit splits without grievances, coordination that is self-enforcing, prices that learn. Five mechanism theorems land on the symbiosis bridge in shadow mode.

- **Stable-matching kernel** ([core/stable-matching.ts](./src/core/stable-matching.ts)): Gale–Shapley deferred acceptance — **only a matching without blocking pairs is self-enforcing**. Deferred acceptance over two-sided preferences yields a stable matching (proposer-optimal), the stable set forms a lattice, and TTC gives the strong core of housing exchange; the stability certificate (blocking-pair count = 0) is returned with the result. Once mounted, agent↔task matching on the symbiosis bridge honors two-sided preferences instead of price-flattening
- **Mechanism-design kernel** ([core/mechanism-design.ts](./src/core/mechanism-design.ts)): VCG + Myerson — **pricing rules under which truth-telling is the dominant strategy**. VCG prices externalities (winners pay others' opportunity cost, DSIC), and the Myerson optimal reserve is learned from the ironed virtual values of the empirical distribution (uniform [0,1] benchmark against the analytic anchor); the classic 5/12 revenue comparison is among the anchors. Once mounted, the knowledge market's reserve floor and competitive clearing carry theorem backing
- **Nucleolus kernel** ([core/nucleolus.ts](./src/core/nucleolus.ts)): Schmeidler's lexicographic minimal complaints — **a profit split with no grievance even for the worst coalition**. A BigInt exact-rational simplex sequence solves from the least core to the nucleolus, lexicographically minimizing the complaint vector; when the core is empty the nucleolus still exists and is unique (retreating to the least core) — Shapley (average fairness) and nucleolus (worst-coalition fairness) side by side, divergence exposing a structurally aggrieved coalition. Once mounted, royalty splits become auditable
- **Correlated-equilibrium kernel** ([core/correlated-equilibrium.ts](./src/core/correlated-equilibrium.ts)): regret-matching convergence + traffic-light coordination — **public signals take coordination beyond the narrow gate of Nash**. Hart–Mas-Colell no-regret dynamics converge to correlated equilibrium (external regret → 0, deviation-incentive inequalities checkable line by line); the classic traffic-light correlated solution beats independent mixed Nash by roughly 9.75x in the coordination game. Once mounted, competitive coordination topics output a CE profile (shadow mode)
- **Dynamic-pricing kernel** ([core/dynamic-pricing.ts](./src/core/dynamic-pricing.ts)): learning-to-price — **price discovery under an unknown demand curve**. Over quote-then-observe bandit feedback, UCB-optimistic and Thompson-posterior pricing run with a √T regret bound returned with the result (linear demand d(p)=1−p, p*=0.5 analytic anchor). Once mounted, tariff tiers learn their quotes from transaction history (hot tiers climb automatically) without changing minted amounts (shadow mode)

### Emergence Layer (66.0 → 70.0)

> The game layer governs many bodies; **the emergence layer makes the part where the whole exceeds the sum computable** — temperature discipline for escaping wells, a menu of mutually non-dominated fronts, distance-as-compression, a readable map of experience, and an information decomposition of 1+1>2.

- **Simulated-annealing kernel** ([core/simulated-annealing.ts](./src/core/simulated-annealing.ts)): Hajek logarithmic cooling — **escaping an attraction basin is a discipline with a theorem**. Under cooling c_t ≥ c/ln t the chain converges in probability to the global optimum (Hajek condition empirically verified), with Boltzmann-Gibbs stationary frequencies checked against theory; a fitness-chain well-depth analysis reports "how deep the wells are, how trapped 18.0's geodesics are". Once mounted, strategy evolution's SA escape checkup is read-only
- **NSGA-II kernel** ([core/nsga2-pareto.ts](./src/core/nsga2-pareto.ts)): non-dominated sorting + crowding distance — **multi-objective scheduling produces the front first and picks the point second**. Fast non-dominated sorting with crowding distance keeps the front spread out (an approximately 130x spread versus weighted-sum GA in the evidence comparison), 2D hypervolume monotone across generations and auditable; 14.0 preserves schools in behavior space, this kernel preserves the front in objective space (orthogonal complements). Once mounted, `paretoFrontView` outputs the quality-cost-latency menu — "how many milliseconds do two more cents buy" reads straight off adjacent points
- **Compression-distance kernel** ([core/compression-distance.ts](./src/core/compression-distance.ts)): LZW + NCD — **"similar in content" gets a zero-model criterion**. The normalized compression distance NCD(x,y) = [C(xy) − min C]/max C is a computable proxy of Kolmogorov complexity; the √2−1 self-distance lower-bound theorem bounds compressor noise, with NCD triangle audits and family-cluster recovery verified. Once mounted on long-term memory, NCD near-duplicate checks (read-only consultation) require no embedding model
- **Mapper-graph kernel** ([core/mapper-graph.ts](./src/core/mapper-graph.ts)): filter-cover-fiber-clustering-nerve graph (Singh–Mémoli–Carlsson 2007) — **high-dimensional experience compressed into a map you can look at**. A low-dimensional filter x overlapping cover x in-fiber clustering x cross-cover edges; the annulus's H₁ cycle basis = 1 cross-checks 36.0 persistent homology. Once mounted, `experienceMapperView` outputs the experience skeleton and insight on the log plane of volume x activity
- **Partial-information-decomposition kernel** ([core/partial-info-decomposition.ts](./src/core/partial-info-decomposition.ts)): BROJA PID — **"1+1>2" is written as a computable number for the first time**. Total mutual information splits into four atoms — redundancy / uniqueness / synergy (derived from a single convex program); the XOR gate's pure synergy of 1 bit and the AND gate's literature value 0.311 are anchors, and O-information gives the distribution's overall synergy/redundancy stance. Once mounted on the reflector, multi-model combination synergy diagnostics are read-only — combos that are mediocre alone and stellar together no longer rely on luck to be found

### Proof Layer (71.0 → 75.0)

> The emergence layer computes the whole; **the proof layer closes with "conclusions carry certificates"** — the expansion-count bill of optimal paths, the KKT certificate of sparse attribution, the probability guarantee of the selection champion, the geometric identity of no-regret updates, and the identity of calibrated probabilities.

- **A*-search kernel** ([core/astar-search.ts](./src/core/astar-search.ts)): admissible/consistent-heuristic optimality (Hart–Nilsson–Raphael 1968) — **the same optimality, a much smaller search bill**. With f = g + h and admissible h, the goal pops optimal; with consistent h, expansions ≤ Dijkstra (runtime counts auditable, reopenings booked). Once mounted on the optimizer, optimal-subplan search over plan subgraphs is callable
- **Sparse-recovery kernel** ([core/sparse-recovery.ts](./src/core/sparse-recovery.ts)): Lasso coordinate descent + OMP — **"the few factors that actually matter" get a short list**. The Lasso CD solution carries a KKT optimality certificate (violation ≤ 1e-6 returned with the result), OMP exactly recovers supports under coherence conditions, and cross-validation picks λ; division of labor with 5.0 causal: sparse recovery proposes the short list (correlational structure), the causal kernel rules on direction (interventional semantics). Once mounted, quality attribution on the optimizer goes through the sparse active set
- **Best-arm-identification kernel** ([core/best-arm-identification.ts](./src/core/best-arm-identification.ts)): fixed-budget BAI — **selection wants conclusion-optimality, not process-optimality**. Successive halving (SH) spends its samples on hard-to-separate competitors at H-complexity rate (a 0.984 identification rate over 500 seeds as evidence), with confidence-elimination racing as the sibling regime; orthogonal to 31.0 no-regret bandits (process-optimal) and 45.0 OCBA (budget allocation). Once mounted, benchmark reports carry a `baiFocus` tournament champion verdict
- **Mirror-descent kernel** ([core/mirror-descent.ts](./src/core/mirror-descent.ts)): OMD / Bregman geometry — **the ad-hoc exponential weights upgrade to a general no-regret operator with the right geometry**. The entropic mirror is exactly Hedge (regret ≤ 2√(T ln n)), the Euclidean mirror is projected gradient; the Bregman three-point identity is verified numerically to 1e-12. Once mounted on the decision engine, the action mixture's no-regret reading is consultable
- **Online-calibration kernel** ([core/online-calibration.ts](./src/core/online-calibration.ts)): online Platt + PAVA isotonic — **a probability pre-layer where "what you report is what happens"**. ECE bucketing quantifies calibration error; online Platt / isotonic regression learn the correction map; the gate design guarantees identity-no-harm — outputs are bit-identical until miscalibration is confirmed, and only the drift sentinel's latch (worst-bucket z-score over threshold) activates calibration. Once mounted, decision-engine confidences are continuously calibrated by outcomes

### Perception Layer (76.0 → 80.0)

> The proof layer closes with certificates; **the perception layer opens "autonomous recognition" — "never seen before" gets a computable caliber for the first time**: how deep, how novel, what structure, where it lies, how much flowed by. Five mathematical pillars lift "seeing" from magnitude-outliers to distributional, causal, geometric, and streaming views (the second genesis round; numbering capped at 100.0).

- **Novelty-detection kernel** ([core/novelty-detection.ts](./src/core/novelty-detection.ts)): Mahalanobis depth (Ledoit–Wolf shrinkage against singularity) + kNN density ratio + CUSUM change detection — **"anomalous = never seen", not "anomalous = how large"**. A pattern with perfectly normal magnitude but a never-seen combination (new failure modes / new attack signatures) is invisible to every magnitude caliber (23.0 heavy tails / 28.0 EVT); this kernel judges against an adaptive reference window (the seen world, self-healing under drift), and the novelty-score series runs through CUSUM (ARL calibrated via the Brook–Evans Markov chain, cross-checked against Siegmund's closed form). Verified: 8σ outliers completely separated in Mahalanobis distance + noveltyAUC = 1; change-detection delay ~26 vs ~206 for the naive threshold at equal false-alarm rate. Once mounted on the sentinel, `noveltyView` is read-only (observation mode, zero drift)
- **Causal-discovery kernel** ([core/causal-discovery.ts](./src/core/causal-discovery.ts)): PC-stable skeleton + v-structures + Meek rules — **the causal graph grows out of observational data for the first time**. Kernel 5.0 handles "inference given a graph"; this one answers "where does the graph come from": conditional-independence tests strip the skeleton, colliders orient edges, Meek rules propagate to the CPDAG equivalence class — undirected edges are the honest statement "the data cannot tell", not a defect. Verified: chain / collider / diamond structures exactly recovered (SHD = 0 over 10 seeds); all 729 four-node DAGs enumerated with equivalence classes matching edge by edge. Once mounted, `causalDiscoveryView` learns the graph read-only (bypass consultation)
- **Canonical-correlation kernel** ([core/canonical-correlation.ts](./src/core/canonical-correlation.ts)): whitening + Jacobi-eigensolver CCA (Hotelling 1936) — **a common latent coordinate system for heterogeneous evidence sources**. Pairwise column correlations are a local caliber; CCA lifts alignment to the global maximization of ρ(a, b) = corr(Xa, Yb), whose canonical-correlation spectrum is the full capacity of shared information, with a ridge guard for high-dimension-small-sample (an all-≈1 spectrum auto-detected as overfitting). Verified: ρ-spectrum recovery error ≤ 0.03 under a known-latent-factor construction; invariance to invertible linear maps at 3.3e-16. Once mounted, `ccaAlignmentView` (bypass consultation)
- **Manifold-learning kernel** ([core/diffusion-maps.ts](./src/core/diffusion-maps.ts)): diffusion maps (Coifman–Lafon 2006) + Isomap — **the intrinsic coordinates of the experience manifold**. High-dimensional observations lie on low-dimensional manifolds, and raw Euclidean distance is fooled by the curvature (adjacent swiss-roll coils look close but are intrinsically far); the spectral decomposition of the normalized kNN-graph transition yields an isometric embedding of diffusion distance, with the spectral gap fixing cluster count. Verified: swiss-roll parameter recovery correlation > 0.98; Isomap geodesic cross-checks. Once mounted, `experienceManifoldView` pairs with 69.0 Mapper (skeleton + continuous coordinates; bypass consultation)
- **Streaming-sketch kernel** ([core/streaming-sketch.ts](./src/core/streaming-sketch.ts)): Count-Min + reservoir + exponential histogram + Misra–Gries — **an O(small-memory) sensory buffer for tsunami-scale signal streams, every reading carrying a provable error bound**. Key frequency "never under, over by ≤ ε‖a‖₁ with probability 1−δ", sliding-window counts with ε guarantees, equal-probability sampling (forensics after the fact), heavy hitters with 100% capture. Verified: guarantees hold for every key over a 100k-event Zipf adversarial stream; reservoir χ²/dof ∈ [0.85, 1.15] as a probative test; window bounds scanned at every position. Once mounted on the sentinel, `sketchView` is read-only (observation mode, zero drift)

### Judgment Layer (81.0 → 85.0)

> The perception layer recognizes the world; **the judgment layer upgrades "accepting a conclusion" from voting / authority to mathematical semantics** — which attacks a conclusion survives, whose votes to trust, with what probabilities the world transitions, what information costs, whether discrete constraints are feasible. Five mathematical pillars underpin "autonomous judgment".

- **Argumentation kernel** ([core/argumentation.ts](./src/core/argumentation.ts)): Dung's abstract argumentation frameworks and their semantics ladder — **"the parliament finally accepts a conclusion" gets a precise definition for the first time**. A set of arguments plus attack relations completes the axiomatization; acceptance is a solution concept of the attack graph: grounded (the most conservative fixpoint, polynomial, always existing) / preferred / stable semantics tighten step by step, with defense chains auditable link by link. Verified: the grounded fixpoint matches a brute-force 2ⁿ full-subset scan digit for digit; all classic cyclic / self-attacking / odd-even-ring structures cross-checked. Once mounted on deliberation/reflection, `argumentationVerdict` adjudicates debate conclusions (shadow computation, zero drift)
- **Crowd-aggregation kernel** ([core/crowd-aggregation.ts](./src/core/crowd-aggregation.ts)): Dawid–Skene confusion-matrix EM — **one-person-one-vote upgrades to trust-weighted voting**. Majority voting treats experts, spam, and adversaries alike; EM learns each rater's per-class confusion matrix from the label records, and reliability becomes vote weight — spammers (uniform noise) and adversaries (systematic contrarians) are automatically delisted. Verified: on a mixed crowd (good/spam/adversary/medium), ground-truth recovery ≥ 0.97, at least 8 percentage points above majority voting; EM log-likelihood monotone per round. Once mounted on the reflector, `crowdVerdictOf` aggregates multi-model verdicts (consultation mode)
- **World-model-learning kernel** ([core/world-model-learning.ts](./src/core/world-model-learning.ts)): counting MLE + Dirichlet smoothing + value iteration + successor features + Dyna — **learning the model itself from real experience**. Model-free methods re-interact from scratch for every new goal; this kernel learns T̂/r̂ and plans on top, successor features reduce "changing the goal" to one matrix-vector product (zero replanning), and Dyna accelerates with simulated mixed experience. Verified: 4×3 classic gridworld VI residual < 1e-9; goal retargeting Ψw₂ matches a fresh VI digit for digit; Bellman-residual health ledger. Once mounted, `modelLearningAudit` (bypass consultation)
- **POMDP-planning kernel** ([core/pomdp-planning.ts](./src/core/pomdp-planning.ts)): exact belief updates + alpha-vector value iteration + QMDP upper bound — **"the state is unreadable" becomes a first-class citizen**. In real scheduling the engine sees symptoms (timeouts / errors / user silence) rather than root causes; the belief b is the decision state, and information (observing / asking / waiting) has a price and is itself an action. Verified: Tiger classic alpha-VI exact values; belief-trajectory cross-checks; QMDP upper-bound relations hold pointwise. Once mounted on the decision engine, `pomdpActionValue` gives defer/execute/ask-user an information-value-gap consultation (consultation mode, zero drift)
- **Symbolic-solver kernel** ([core/symbolic-solver.ts](./src/core/symbolic-solver.ts)): DPLL with backjumping and clause learning + #SAT component decomposition — **complete adjudication of discrete constraints**. Resource mutexes / dependency conflicts in a generated DAG plan can be statically refuted before lifting a finger, instead of surfacing mid-execution; CNF encoding + complete search yield SAT/UNSAT with a conflict bill (locating the minimal conflicting task set), and #SAT counts feasible selections exactly (a unique solution = fragile). Verified: pigeonhole PHP(3,2) classic UNSAT; random 3-SAT at the phase transition 100% consistent with brute force; n ≤ 16 counting matches 2ⁿ enumeration to 1e-12. Once mounted on the executor, `planFeasibility` is a static verdict (consultation mode)

### Execution Layer (86.0 → 90.0)

> The judgment layer rules on what to do; **the execution layer makes "landing" itself carry mathematics** — credit assignment over long plans, safety margin per step, counterfactual valuation without going live, concentration gates without certificates no-launch, and value orders learned from preference pairs. Five mathematical pillars underpin "autonomous execution".

- **Options-framework kernel** ([core/options-framework.ts](./src/core/options-framework.ts)): options framework (Sutton–Precup–Singh 1999) + SMDP Q-learning — **time credit assignment for macro-actions as γ^k (k = actual macro duration)**. Flat Q-learning needs the "this subroutine is worth it" signal to seep back through dozens of γ^n decays; with skills as first-class citizens (initiation + termination conditions), the whole subroutine settles in one account. Verified: on the classic four-room construction, SMDP Q-learning converges to the same Q* as value iteration (residual ≤ 1e-9); a 179× sample-acceleration corridor anchor. Once mounted, `optionsSkillAuditView` is a routine skill-library health check (read-only baseline)
- **Safety-barrier kernel** ([core/safety-barrier.ts](./src/core/safety-barrier.ts)): discrete-time control barrier functions (CBF) as a safety filter — **differential safety per action, not circuit-breaker-level safety per event**. Naive clamping cannot answer "will this step burn through the safety margin" — the danger is the action's direction; the CBF filter produces the **minimal safe modification** (greedy closed-form QP), and honestly reports the gap when infeasible (a 5% shortfall and a 50% shortfall are handled differently). Verified: closed-loop simulation with naive truncation at 282 violations vs 0. Once mounted on the executor, `barrierFilterAction` filters desired actions and reports infeasible cases to the safety governor (consultation mode)
- **Off-policy-evaluation kernel** ([core/off-policy-evaluation.ts](./src/core/off-policy-evaluation.ts)): the OIS → WIS → PDIS → DR four-rung ladder + empirical-Bernstein confidence intervals — **evaluating a policy goes from "run it once" to "compute it once"**. Sandbox scores are point estimates of single measurements; the production behavior policy μ's massive trajectory set carries the same information about an unrun target policy π, and DR is doubly robust (an approximate Q breaks unbiasedness not, only variance). Verified: analytic ground-truth anchors on chain / cliff worlds; the four rungs' errors strictly ordered; the DR error = 0 analytic special case under an exact Q. Once mounted on the policy evolver, `offlineEvaluation` is the canary gate's second channel (consultation mode)
- **Safe-policy-improvement kernel** ([core/safe-policy-improvement.ts](./src/core/safe-policy-improvement.ts)): HCPI-style paired-difference high-confidence improvement — **no statistical certificate, no launch**. The existing gate's LCB is a statistic about the simulator, with a fidelity gap to the operating ring; this kernel requires LCB > 0 on per-trajectory paired differences Δ̂ = Ĵ(π_cand) − Ĵ(π_base) before acceptance, nailing the probability of "wrongly accepting a true regression" at δ. Verified: violation rate ≤ δ; concentration-curve slope −0.4997 (theory −0.5 for √(log/n)). Once mounted, `safeImprovementVerdict` is the launch safety valve (consultation mode)
- **Preference-learning kernel** ([core/preference-learning.ts](./src/preference-learning.ts)): Bradley–Terry Newton MLE + Elo — **a value order learned from "which is better" pairs (the same mathematical base as RLHF)**. Absolute scores are incomparable across tasks and history is voided when metrics change; pairwise comparisons are self-controlled within one reviewer, and preference pairs are invariant raw evidence. Loop detection + goodness-of-fit double pre-checks — failing either honestly reports "not usable for decision ranking" (rock-paper-scissors cyclic preferences are exactly the failure case). Verified: known-utility ranking recovered 100%; the two-item 6-pairs-4-wins → û₀−û₁ = ln2 analytic anchor. Once mounted on the reflector, `notePreferencePair` / `preferenceView` (shadow learning)

### Evolution Layer (91.0 → 95.0)

> The execution layer lands safely; **the evolution layer swaps the steering wheel of evolution from "the objective" to "novelty / adversarial pressure / budget / fidelity / interruptibility"** — the deceptive terrain cannot be crossed because the obstacle is the objective itself. Five mathematical pillars underpin "autonomous evolution".

- **Novelty-search kernel** ([core/novelty-search.ts](./src/core/novelty-search.ts)): abandoning the objective, searching behavior space for novelty alone (Lehman & Stanley) with the MCNS feasibility gate — **the detour that "must first move away from the goal" becomes passable for the first time**. On deceptive terrain the heuristic gradient leads the population into a cavity dead-end while the true solution hides on the detour; the novelty score (mean kNN distance to the archive) is the selection pressure, and the MCNS gate filters "novel but infeasible". Verified: on the deceptive maze over 100 seeds, novelty search 99/100 vs fitness-only 0/100. Once mounted on the curiosity engine, `noveltySearchView` directs exploration (consultation mode)
- **Self-play kernel** ([core/self-play.ts](./src/core/self-play.ts)): fictitious-play convergence (Brown 1951) + exploitability + league exploiters — **a policy's weakness becomes a computable currency**. The evolution loop's fitness comes from fighting the environment, and the environment is dead; fighting one's own historical average (fictitious play) and opponents specialized against oneself (league), every exploitable regularity gets exploited by the next best response. Verified: Kuhn poker equilibrium value exactly −1/18 (the 1950 literature value); RPS fictitious play converges to uniform over 10⁴ rounds; exploitability declines with iterations. Once mounted, `selfPlayAudit` is the adversarial-pressure audit (shadow computation)
- **AutoML Hyperband kernel** ([core/automl-hyperband.ts](./src/core/automl-hyperband.ts)): Hyperband multi-budget bracket scheduling (Li et al. 2017) — **budget-conserving tuning with zero prior on learning-curve shapes**. Instead of betting on any single "configs vs per-config budget" trade-off, s_max+1 brackets lay out the whole exploration-exploitation spectrum at once; inferior configs are executed at low budget and budget concentrates on survivors. Verified: bracketSchedule(81,3) reproduces the paper's schedule (n = [81,34,15,8,5]); budget conservation accounted per bracket; 40/40 hits of the 95th percentile at equal budget; a late-bloomer counterexample honestly reported. Once mounted on the benchmark engine, `hyperbandTune` (consultation mode)
- **Simulation-calibration kernel** ([core/simulation-calibration.ts](./src/core/simulation-calibration.ts)): MMD² + energy distance + classifier density-ratio reweighting — **quantifying the sandbox wind tunnel's distortion and bridging sim-to-real**. Sandbox verdicts rest on the implicit assumption "simulator = real world"; two-sample statistics quantify the domain gap, the density ratio r̂ converts sandbox statistics to the real caliber, and a low ESS/n (heavy reweighting) honestly refuses the conversion. Verified: analytic cross-checks of MMD² / energy distance for N(0,1) vs N(1,1) (hand-computed anchors); 5-level gap monotonicity; a 99.9% gap reduction after reweighting. Once mounted on the sandbox, `windTunnelReport` (read-only mode)
- **Interruptible-autonomy kernel** ([core/interruptible-autonomy.ts](./src/core/interruptible-autonomy.ts)): safe interruptibility (Orseau–Lattimore 2016) + offline policy correction + handoff economics — **an interrupted learner still converges to the true optimum**. Uncorrected Q-learning learns "the operator's hand" as environment dynamics into its value function; offline correction recovers Q* from interrupted trajectories. "When to hand to the human" upgrades from empirical thresholds to the closed-form expected-cost verdict τ* = c_H + c_delay. Verified: under adversarial interruptions the corrected Q* recovers to 1.5e-13; the closed-form handoff threshold equals enumeration-optimal; the three modes (never/always/adaptive) rank correctly. Once mounted on the decision engine, `handoffAdvice` (consultation mode)

### Consciousness Layer (96.0 → 100.0)

> The evolution layer transcends itself; **the consciousness layer turns "what to attend to now, is the confidence trustworthy, was this sleep worth it, who gets attention, did I cause this" into computable mathematical objects** — Baars' global workspace, second-order signal detection, prioritized replay, VCG auctions, and agency attribution: five mind structures cap the century numbering.

- **Global-workspace kernel** ([core/global-workspace.ts](./src/core/global-workspace.ts)): GWT bidding competition + ignition threshold + cascading broadcast + refractory period (a computationalization of Baars' theory) — **"what the whole system should know right now" is arbitrated by competition, no longer by code call order**. Specialized modules bid in parallel (softmax soft-WTA); the winner crossing the ignition threshold broadcasts to all, and the broadcast becomes the context of the next round's computation; the refractory period prevents single-module monopoly. Verified: hard WTA equals an independent argmax recomputation digit for digit; threshold semantics at the boundary (exactly θ does not ignite); four-round cascade relay; winner-distribution entropy monotone in temperature. Once mounted on the autonomy loop, `consciousnessStep` / `consciousnessView` (bypass mode, zero drift)
- **Metacognitive-confidence kernel** ([core/metacognitive-confidence.ts](./src/core/metacognitive-confidence.ts)): type-2 signal detection theory meta-d′ + four-quadrant separation + a closed-form help-seeking threshold — **"knowing that you don't know" is quantified**. Discrimination (d′) and self-knowledge (meta-d′) are independent abilities; a low M-ratio = meta-d′/d′ means confidence is untrustworthy and the help-seeking policy retreats to the conservative task-difficulty prior; shouldAsk issues the verdict only when the posterior error rate crosses the closed-form threshold (both overconfidence and underconfidence are pulled back by the cost model). Verified: d̂′ recovery within ±0.1 from seeded factories with known d; high/low-metacognition quadrants separate significantly; degenerate counts stay finite. Once mounted on the decision engine, `metacognitionView` (observation mode)
- **Experience-replay kernel** ([core/experience-replay.ts](./src/core/experience-replay.ts)): rank-based prioritized experience replay (PER) + unbiased IS weights + sleep consolidation — **sleep on it and figure it out, without forgetting the old**. The single-pass "eat one as one arrives" stream is sample-inefficient and task switches overwrite parameters (catastrophic forgetting); the tiered-quota buffer keeps old skills from being washed out by new floods, IS weights correct the statistical bias of prioritized sampling, and the sleep phase replays without collecting. Verified: IS-weighted estimates unbiased in cross-checks; sleep consolidation +0.60 gain; catastrophic forgetting on a two-task sequence 88.9% → 0. Once mounted on long-term memory, `sleepConsolidate` runs at night (bypass mode)
- **Attention-economy kernel** ([core/attention-economy.ts](./src/core/attention-economy.ts)): concave marginal value + matroid greedy + VCG second-price payments — **attention is a scarce budget and its allocation can state its opportunity cost**. The k deep-look slots let information sources self-report EVSI-style marginal values, with concavity patrols provisionally delisting violators; VCG payments equal the others' opportunity cost displaced, making truth-telling dominant (DSIC) — the loophole where downstream modules learn to raise log levels to grab focus is closed by mechanism. Verified: greedy = enumeration-optimal (50 seeds, per-instance identical); second-price payments match hand-worked examples exactly; lying never profits across 500 attempts. Once mounted on the sentinel, `attentionMarket` (shadow mode)
- **Self-boundary kernel** ([core/self-boundary.ts](./src/core/self-boundary.ts)): delayed-contingency agency detection + do-caliber confounder disambiguation + identity continuity — **"did I cause this, or did the world do it on its own" gets a verdict**. Crediting environmental windfalls to oneself = the evolution loop books luck as merit; blaming one's own damage on the environment = never correcting a wrong policy. Temporal contingency (a channel's delayed mutual information with one's own actions significantly above the shuffled baseline) flags self-caused channels, known confounders are injected for disambiguation, and pre-deployment identity-break monitoring links into canary rollback. Verified: 40/40 channel attributions correct; spurious correlations vanish under do-interventions; break alarms fire on abrupt deployments. Once mounted on the self-model, `agencyAudit` / `identityAudit` (shadow computation)

### Kernel Stack (core/, 3.0 → 100.0)
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
| online-learning.ts | 31.0 | Online learning: Fixed-Share Hedge, adversary-free regret ≤ √(2T lnN) (see above) |
| optimal-assignment.ts | 32.0 | Global assignment: Hungarian O(n³) exact solution + dual optimality certificate (see above) |
| random-matrix.ts | 33.0 | Random matrix: Marchenko–Pastur cleansing + systemic-risk monitoring (see above) |
| robust-decisions.ts | 34.0 | Distributional robustness: exact CVaR + Wasserstein KR duality (see above) |
| feedback-control.ts | 35.0 | Feedback control: DARE closed-form gain + Lyapunov stability certificate (see above) |
| persistent-homology.ts | 36.0 | Persistent homology: H₀ diagram + bottleneck-distance stability (see above) |
| information-bottleneck.ts | 37.0 | Information bottleneck: Blahut-Arimoto, distillation retention pricing (see above) |
| nonlinear-dynamics.ts | 38.0 | Nonlinear dynamics: Lyapunov + Hurst constitution classification (see above) |
| spectral-ranking.ts | 39.0 | Spectral ranking: PageRank power iteration + knowledge skeleton (see above) |
| first-passage.ts | 40.0 | First passage: reflection principle + inverse-Gaussian cooldown pricing (see above) |
| queueing-network.ts | 41.0 | Queueing networks: Jackson product form + bottleneck station (heartbeat phase 2.9) |
| spectral-periodicity.ts | 42.0 | Spectral periodicity: FFT periodogram + Fisher g test (spectral calendar) |
| max-flow.ts | 43.0 | Max flow: Edmonds-Karp + min-cut certificate (capacity frontier) |
| fair-division.ts | 44.0 | Fair division: weighted max-min water-filling (exploration family budgets) |
| budget-allocation.ts | 45.0 | OCBA: optimal computing budget allocation (benchmark bottleneck focus) |
| quorum-systems.ts | 46.0 | Quorums: intersection + Byzantine 3f+1 bound (Raft safety audit) |
| crdt.ts | 47.0 | CRDT: G-Counter/OR-Set/LWW convergence laws (sync channel) |
| secret-sharing.ts | 48.0 | Secret sharing: Shamir threshold + entropy audit (key sharding) |
| multiscale-wavelet.ts | 49.0 | Wavelets: Haar multi-scale decomposition (KPI scale lens) |
| matrix-completion.ts | 50.0 | Matrix completion: ALS low-rank factors (cold-start extrapolation) |
| speculative-decoding.ts | 51.0 | Speculative decoding: draft-verify-accept closed-form economics + optimal draft length + rejection theorem (see above) |
| test-time-compute.ts | 52.0 | Test-time compute: exact-binomial majority vote + correlation correction + power-law water-filling + early stop (see above) |
| whittle-index.ts | 53.0 | Whittle index: restless-MAB partial-activation scheduling + always-indexability theorem (see above) |
| lyapunov-drift.ts | 54.0 | Lyapunov drift-plus-penalty: backpressure stability [O(1/V) suboptimal, O(V) queues] + dual prices (see above) |
| hawkes-process.ts | 55.0 | Hawkes self-excitation: EM fitting + time-rescaled residual diagnostics + burst forecast (see above) |
| belief-propagation.ts | 56.0 | Belief propagation: factor-graph sum-product, exact marginalization on trees (see above) |
| variational-inference.ts | 57.0 | Variational inference: CAVI mean field + ELBO monotonicity + conjugate exact recovery (see above) |
| langevin-sampling.ts | 58.0 | Langevin sampling: ULA/MALA + Bures W₂ convergence audit (see above) |
| curriculum-learning.ts | 59.0 | Curriculum learning: mastery-gated promotion state machine + 3-strategy 200-seed comparison (see above) |
| rate-distortion.ts | 60.0 | Rate distortion: Blahut-Arimoto + keep-compress-drop planning + shadow price (see above) |
| stable-matching.ts | 61.0 | Stable matching: Gale-Shapley + lattice structure + TTC strong core (see above) |
| mechanism-design.ts | 62.0 | Mechanism design: VCG externality pricing + Myerson ironed reserve (see above) |
| nucleolus.ts | 63.0 | Nucleolus: BigInt exact-rational simplex + lexicographically minimal complaints (see above) |
| correlated-equilibrium.ts | 64.0 | Correlated equilibrium: regret-matching convergence + traffic-light coordination (see above) |
| dynamic-pricing.ts | 65.0 | Dynamic pricing: UCB/Thompson learning-to-price, √T regret (see above) |
| simulated-annealing.ts | 66.0 | Simulated annealing: Hajek log-cooling empirics + Boltzmann frequency check (see above) |
| nsga2-pareto.ts | 67.0 | NSGA-II: non-dominated sorting + crowding distance + 2D hypervolume monotonicity (see above) |
| compression-distance.ts | 68.0 | Compression distance: LZW/NCD + √2−1 self-distance bound + family-cluster recovery (see above) |
| mapper-graph.ts | 69.0 | Mapper graph: filter-cover-fiber skeleton, annulus H₁ cross-checked with 36.0 (see above) |
| partial-info-decomposition.ts | 70.0 | PID: BROJA four atoms + XOR pure synergy + O-information (see above) |
| astar-search.ts | 71.0 | A* search: admissible/consistent-heuristic optimality + expansions ≤ Dijkstra (see above) |
| sparse-recovery.ts | 72.0 | Sparse recovery: Lasso CD + KKT certificate + OMP support recovery + CV λ (see above) |
| best-arm-identification.ts | 73.0 | Best-arm identification: successive halving + H complexity + 0.984 over 500 seeds (see above) |
| mirror-descent.ts | 74.0 | Mirror descent: entropic-mirror Hedge regret ≤ 2√(T ln n) + Bregman identity (see above) |
| online-calibration.ts | 75.0 | Online calibration: online Platt/PAVA isotonic + gated zero-drift identity no-harm (see above) |
| novelty-detection.ts | 76.0 | Novelty detection: Mahalanobis (LW shrinkage) + kNN density ratio + CUSUM change detection (ARL Markov calibration, see above) |
| causal-discovery.ts | 77.0 | Causal discovery: PC-stable + v-structures + Meek rules, honest CPDAG equivalence classes (729-graph enumeration cross-check, see above) |
| canonical-correlation.ts | 78.0 | Canonical correlation: whitening + Jacobi-eigen CCA + ridge guard for high dimensions (see above) |
| diffusion-maps.ts | 79.0 | Manifold learning: diffusion maps + Isomap, swiss-roll recovery 0.98 / spectral-gap clustering (see above) |
| streaming-sketch.ts | 80.0 | Streaming sketches: Count-Min guarantees + exact reservoir + epsilon histograms + Misra–Gries (see above) |
| argumentation.ts | 81.0 | Argumentation: Dung semantics ladder grounded/preferred/stable + defense-chain verdicts (see above) |
| crowd-aggregation.ts | 82.0 | Crowd aggregation: Dawid–Skene EM confusion-matrix trust voting, spam & adversaries auto-delisted (see above) |
| world-model-learning.ts | 83.0 | World-model learning: counting MLE + value iteration + successor features zero-replanning retarget + Dyna (see above) |
| pomdp-planning.ts | 84.0 | POMDP: exact belief updates + alpha-vector VI + QMDP upper bound (Tiger classic values, see above) |
| symbolic-solver.ts | 85.0 | Symbolic solving: DPLL backjumping + clause learning + #SAT component decomposition (pigeonhole UNSAT, see above) |
| options-framework.ts | 86.0 | Options framework: SMDP Q-learning gamma^k macro discounting (179x corridor speedup, see above) |
| safety-barrier.ts | 87.0 | Safety barrier: discrete CBF minimal-modification filtering (282 violations vs 0, see above) |
| off-policy-evaluation.ts | 88.0 | Off-policy evaluation: OIS/WIS/PDIS/DR ladder + empirical-Bernstein CIs (DR error = 0 analytic case, see above) |
| safe-policy-improvement.ts | 89.0 | Safe policy improvement: HCPI paired-difference LCB>0 certificate gating (concentration slope −0.4997, see above) |
| preference-learning.ts | 90.0 | Preference learning: Bradley–Terry Newton MLE + Elo + honest cycle reporting (see above) |
| novelty-search.ts | 91.0 | Novelty search: deceptive maze 99/100 vs fitness 0/100 + MCNS feasibility gate (see above) |
| self-play.ts | 92.0 | Self-play: fictitious-play convergence + Kuhn −1/18 exact + exploitability weakness currency (see above) |
| automl-hyperband.ts | 93.0 | AutoML Hyperband: bracket-schedule budget conservation + paper schedule reproduction (see above) |
| simulation-calibration.ts | 94.0 | Simulation calibration: MMD² + energy distance + classifier density-ratio reweighting (99.9% gap reduction, see above) |
| interruptible-autonomy.ts | 95.0 | Interruptible autonomy: adversarial-interruption corrected Q* recovery 1.5e-13 + closed-form handoff threshold (see above) |
| global-workspace.ts | 96.0 | Global workspace: GWT bidding competition + ignition threshold + cascading broadcast + refractory (see above) |
| metacognitive-confidence.ts | 97.0 | Metacognitive confidence: type-2 SDT meta-d′/d′ four-quadrant separation + closed-form ask threshold (see above) |
| experience-replay.ts | 98.0 | Experience replay: rank-based PER + IS unbiasedness + sleep consolidation (forgetting 88.9%→0, see above) |
| attention-economy.ts | 99.0 | Attention economy: concave-marginal greedy = enumeration-optimal + VCG second prices + lying never profits (see above) |
| self-boundary.ts | 100.0 | Self-boundary: delayed-contingency agency detection 40/40 + do-confounder disambiguation + identity-break alarms (see above) |

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
3. **World-model foresight** — predict signal arrivals, capture rising trends; phase 2.5 capacity planning (25.0) inverts the minimum concurrency, phase 2.7 tail-risk assessment (28.0) extrapolates p99.9 via POT/GPD, and phase 2.8 systemic-risk assessment (33.0) detects common-factor exposure by cleansing the failure-correlation matrix through the Marchenko–Pastur band
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

All runtime options (sentinel / encryption / sync / consensus / hot reload / tenants / autonomy loop `autonomy` / host fusion `hostFusion`) are likewise built into [cordis.patch.yml](./cordis.patch.yml) and need no changes; symbiosis options live under `autonomy.symbiosis` (futarchy voting, energy feedback, etc., off by default). Guarantee-layer kernel options 12.0-16.0 and geometry/topology-layer options 17.0-20.0 are also off by default (zero drift): `autonomy.anytimeEvidence` (α / reference watermark), `autonomy.conformal` (α / calibration capacity / threshold risk & confidence), `autonomy.qualityDiversity` (explore rate), `autonomy.runtimeVerification` (additional `specs`), `autonomy.optimalTransport` (monitored KPIs / windows / threshold quantile), `autonomy.informationGeometry` (KL budget / step scale), `autonomy.optimalStopping` (opportunity horizon / min samples), `autonomy.sheafConsensus` (obstruction misfit tolerance); equilibrium-layer options 31.0-35.0 are likewise off by default (zero drift): `autonomy.hedgePortfolio` (learning rate η / share α), `autonomy.optimalAssignment` (candidate cap), `autonomy.randomMatrix` (window / min models / edge factor / share threshold), `autonomy.cvarTimeouts` (confidence α / margin / min samples), `autonomy.concurrencyControl` (target utilization / plant gain / control weight / deadband); awakening-layer options 37.0-40.0 are likewise off by default (zero drift): `autonomy.informationBottleneck` (β / retention floor), `autonomy.chaosDiagnostics` (min points / λ threshold / Hurst delta), `autonomy.spectralRanking` (damping), `autonomy.firstPassageCooldown` (recovery confidence target); flux-layer options 41.0-45.0 are likewise off by default (zero drift): `autonomy.queueingNetwork` (bottleneck rho threshold), `autonomy.spectralCalendar` (hourly bins), `autonomy.capacityFrontier`, `autonomy.fairBudget`, `autonomy.ocbaAllocator` (confirmation budget); fabric-layer options 49.0-50.0 are likewise off by default (zero drift): `autonomy.waveletView` (min points), `autonomy.latentFactors` (rank); fabric 46.0-48.0 are engine read-only methods (Raft `quorumAudit` / Sync CRDT channel / CryptoEngine `shardKey`) with no runtime switch; 36.0 persistent homology is queried on demand via the `topology` action of `query_memory` (zero drift); the five genesis layers 51.0-75.0 converge under the `autonomy.kernels` namespace, all off by default (zero drift — mounting happens only when enabled): `kernels.speculativeDecoding` (maxK), `kernels.testTimeCompute` (alpha), `kernels.whittleIndex` (goodThreshold / passiveHeal / discount), `kernels.lyapunovBackpressure` (V / priceThreshold), `kernels.hawkesBurstGuard` (windowSec / burstShare / minEvents), `kernels.beliefPropagation`, `kernels.variationalInference`, `kernels.langevinMutation` (steps / seed), `kernels.curriculum` (levelCount / threshold), `kernels.rateDistortion` (budgetBits), `kernels.stableMatching`, `kernels.mechanismDesign`, `kernels.nucleolusAudit`, `kernels.correlatedEquilibrium`, `kernels.dynamicPricing` (policy / unit / exploration), `kernels.annealingEscape`, `kernels.paretoFront`, `kernels.compressionDistance` (threshold), `kernels.mapperGraph` (intervals / overlap / clusterEps), `kernels.pidDiagnostics`, `kernels.astarSearch`, `kernels.sparseRecovery`, `kernels.baiSelector` (budget), `kernels.mirrorDescent` (mirror / alpha), `kernels.onlineCalibration` (strategy / lr / window), one uniform `enabled` flag each, with the wiring matrix and mounting discipline documented in `scripts/verify-genesis25-wiring.mjs`; the second genesis round's five layers 76.0-100.0 (perception / judgment / execution / evolution / consciousness) likewise converge under the `autonomy.kernels` namespace, all off by default (zero drift — mounting happens only when enabled): `kernels.noveltySentinel` (capacity / halfLife / minSamples / changeAlpha), `kernels.causalDiscovery` (alpha), `kernels.ccaAlignment` (lambda), `kernels.diffusionManifold` (k / dims), `kernels.streamingSketch` (cmsEps / cmsDelta / window / reservoirK), `kernels.argumentation`, `kernels.crowdAggregation`, `kernels.worldModelLearning` (prior), `kernels.pomdpPlanner`, `kernels.symbolicFeasibility`, `kernels.optionsFramework` (episodes), `kernels.safetyBarrier` (eta), `kernels.offPolicyEvaluation` (delta / gamma), `kernels.safePolicyImprovement` (delta / minSamples), `kernels.preferenceLearning` (minPairs / l2), `kernels.noveltySearch` (k), `kernels.selfPlay` (leagueRounds / seed), `kernels.automlHyperband` (eta / seed), `kernels.simulationCalibration`, `kernels.interruptibleAutonomy`, `kernels.globalWorkspace` (threshold / temperature), `kernels.metacognitiveConfidence`, `kernels.experienceReplay` (capacity / alpha / beta), `kernels.attentionEconomy`, `kernels.selfBoundary` — one uniform `enabled` flag each; the wiring matrix and mounting discipline are documented in `scripts/verify-autonomy25-wiring.mjs` and [UPGRADE-AUTONOMY25.md](./UPGRADE-AUTONOMY25.md).

Round 4 converges all round-3/4 module-domain upgrades into **16 `autonomy.modules.*` flags** (same style as `kernels.*`, all off by default, zero drift; flag names verified against the `MODULE_FLAGS` static list in `src/index.ts` / `src/engines-frontier/autonomy25.ts`): `modules.sentinelAdaptive` (round-3 adaptive window + round-4 storm budget sharing), `modules.decisionHysteresisJoint` (decision hysteresis + batch joint deciding), `modules.schedulerHealthRouting` (round-3 health routing), `modules.schedulerColdStart` (3-phase cold-start admission + periodic prewarming), `modules.executorAdaptiveParallelism`, `modules.executorFailureDomains`, `modules.memoryTieredArbitration` (round-3 tiering + arbitration), `modules.metaStabilityLoop`, `modules.policyABBranching`, `modules.worldObservationFusion`, `modules.symbiosisEconomy` (monetary governance + conditional settlement), `modules.cryptoTieredKeys`, `modules.tenantQuotaForecast`, `modules.clientPriorityQueue`, `modules.benchmarkTrendTracker`, `modules.dashboardAlarmSources` — one uniform `enabled` flag each; the `moduleFlags` field of `manage_autonomy introspect` reports the 16-flag overview. The main-pipeline deepening trio lives under `autonomy.pipeline.*`, all off by default (zero drift): `pipeline.crossStepCache` (cross-step derived-value LRU cache, `capacity` default 256, hits bit-identical to direct computation), `pipeline.degradationLadder` (three-rung degradation on step-5/6 exceptions: main → simplified → fallback, each rung audited), `pipeline.stepPrefetch` (prefetch the next signal's experience retrieval during execution waits, generation-guarded consumption); flag matrix and differential verification in [UPGRADE-ACTIVATION-DEEPENING.md](./UPGRADE-ACTIVATION-DEEPENING.md) (Chinese) and `scripts/verify-r4-pipeline.mjs`.

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

## Offline Verification (138, zero API keys)

Every kernel and subsystem has an offline end-to-end verification script (`node --experimental-transform-types scripts/verify-*.mjs` — the suite-wide runner since round 3, a superset of strip-types that tolerates TS parameter properties in directly-imported sources):

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
node scripts/verify-equilibrium-kernels.mjs # Equilibrium layer 31.0-35.0: adversarial regret bounds / Hungarian-vs-brute-force + dual certificates / MP-edge matching / CVaR-vs-RU / DARE closed form / machine-precision Lyapunov
node scripts/verify-equilibrium-wiring.mjs  # Equilibrium wiring: real engines end-to-end (adversarial demotion & comeback / batch one-to-one / common-factor insight / heavy-tail timeout pricing / closed-loop concurrency)
node scripts/verify-awakening-kernels.mjs  # Awakening layer 36.0-40.0: continents & islands + bottleneck stability / IB-DPI + β frontier / logistic λ₁=ln2 + Hurst constitutions / exact ring uniformity / reflection vs 20k paths
node scripts/verify-awakening-wiring.mjs   # Awakening wiring: real engines end-to-end (knowledge topography / distillation information gate / chaos-regime flip insight / hub influence / breaker cooldown pricing)
node scripts/verify-flux-kernels.mjs     # Flux layer 41.0-45.0: tandem M/M/1 simulation vs analytic + Jackson independence / FFT identities + Parseval + period recovery / max-flow vs brute-force min-cut + certificates / textbook water-filling + fairness audit / OCBA-vs-uniform P(CS)
node scripts/verify-flux-wiring.mjs      # Flux wiring: real engines end-to-end (spectral calendar diurnal detection / capacity-frontier writeback / family fairness anti-starvation / OCBA bottleneck focus)
node scripts/verify-fabric-kernels.mjs   # Fabric layer 46.0-50.0: quorum closed-form vs brute-force + 3f+1 bound / CRDT permutation convergence + add-win / Shamir threshold reconstruction + zero leakage / wavelet perfect reconstruction + Parseval / low-rank recovery
node scripts/verify-fabric-wiring.mjs    # Fabric wiring: real engines end-to-end (Raft safety audit / two-instance CRDT convergence / key sharding reconstruction / wavelet burst capture / cold-start latent extrapolation)
node scripts/verify-speculative-decoding.mjs # Singularity 51.0: speedup closed-form vs simulation / optimal k* first-order condition / rejection theorem / γ telemetry backfill
node scripts/verify-test-time-compute.mjs  # Singularity 52.0: exact-binomial vote vs enumeration / β-binomial correction / power-law water-filling / early stop
node scripts/verify-whittle-index.mjs      # Singularity 53.0: subsidy-MDP bisection vs value iteration / indexability scan / asymptotic optimality
node scripts/verify-lyapunov-drift.mjs     # Singularity 54.0: per-slot drift identity / [O(1/V), O(V)] tradeoff / LP dual-price convergence
node scripts/verify-hawkes-process.mjs     # Singularity 55.0: EM fit + branching-ratio recovery / time-rescaled Exp(1) residuals / closed-form burst forecast
node scripts/verify-belief-propagation.mjs # Mind 56.0: exact tree marginalization vs enumeration / loopy BP on cycles / max-product MAP
node scripts/verify-variational-langevin.mjs # Mind 57.0+58.0: CAVI ELBO monotonicity / conjugate exact recovery / MALA 0.574 acceptance / Bures W₂
node scripts/verify-curriculum-rd.mjs      # Mind 59.0+60.0: mastery-gated promotion over 200 seeds / Blahut-Arimoto binary source to 1e-6 / keep-compress-drop planning
node scripts/verify-stable-matching.mjs    # Game 61.0: Gale-Shapley stability certificates / lattice structure / TTC strong core
node scripts/verify-mechanism-design.mjs   # Game 62.0: VCG DSIC perturbation checks / Myerson ironed reserve / uniform-distribution analytic anchor
node scripts/verify-game-kernels.mjs       # Game 63.0+64.0: BigInt rational nucleolus vs literature / regret-matching CE convergence / traffic-light 9.75x
node scripts/verify-pricing-calibration.mjs # Game 65.0 + Proof 75.0: UCB/Thompson √T pricing regret / online Platt + PAVA / gated identity no-harm
node scripts/verify-stochastic-optimization.mjs # Emergence 66.0+67.0: Hajek log-cooling empirics / Boltzmann frequency check / non-dominated sorting / hypervolume monotonicity
node scripts/verify-compression-distance.mjs   # Emergence 68.0: NCD triangle audit / √2−1 self-distance bound / family-cluster recovery
node scripts/verify-mapper-graph.mjs       # Emergence 69.0: annulus H₁ cycle basis = 1 (cross-checked with 36.0) / skeleton convergence
node scripts/verify-partial-info-decomposition.mjs # Emergence 70.0: XOR pure synergy 1 bit / AND literature value 0.311 / O-information signs
node scripts/verify-search-sparse.mjs      # Proof 71.0+72.0: A* optimality + expansions ≤ Dijkstra / Lasso KKT certificate / OMP support recovery / CV λ
node scripts/verify-online-frontier.mjs    # Proof 73.0+74.0: successive halving 0.984 over 500 seeds / H complexity / entropic-mirror regret bound / Bregman identity 1e-12
node scripts/verify-genesis25-wiring.mjs   # Genesis 51.0-75.0 wiring: 13 engines end-to-end zero-drift comparison (flags off = bit-identical status quo)
node scripts/verify-novelty-detection.mjs  # Perception 76.0: Mahalanobis separation + AUC=1 / CUSUM ARL calibration (MC cross-check) + delay 26 vs 206 / LW shrinkage
node scripts/verify-causal-discovery.mjs   # Perception 77.0: chain/collider/diamond exact recovery + 729-graph equivalence enumeration + test calibration
node scripts/verify-alignment-manifold.mjs # Perception 78.0+79.0: CCA known-latent rho-spectrum recovery 0.03 + invariance 3.3e-16 / swiss roll 0.98 + spectral gap
node scripts/verify-streaming-sketch.mjs   # Perception 80.0: CMS never-under + epsilon guarantees / reservoir chi-square probative test / histogram eps / Misra–Gries
node scripts/verify-argumentation.mjs      # Judgment 81.0: grounded fixpoint vs 2^n brute force / four-semantics ladder / rings & self-attacks
node scripts/verify-crowd-aggregation.mjs  # Judgment 82.0: mixed-crowd DS >= 0.97, +8pp over majority / confusion recovery / EM monotonicity
node scripts/verify-model-pomdp.mjs        # Judgment 83.0+84.0: VI residual 1e-9 + zero-replanning retarget / Tiger alpha-VI exact + QMDP bounds
node scripts/verify-symbolic-solver.mjs    # Judgment 85.0: DPLL vs brute force 100% / pigeonhole UNSAT + learned clauses / #SAT = 2^n at 1e-12
node scripts/verify-execution-kernels.mjs  # Execution 86.0+87.0: SMDP Q-learning = VI same Q* (1e-9) / CBF closed loop 282 violations vs 0
node scripts/verify-ope-spi.mjs            # Execution 88.0+89.0: four-rung error ordering + DR error = 0 / violation rate <= delta + slope −0.4997
node scripts/verify-preference-learning.mjs # Execution 90.0: B-T ranking 100% recovery + ln2 anchor + holdout 0.85 + honest cycle reporting
node scripts/verify-novelty-search.mjs     # Evolution 91.0: deceptive maze 99/100 vs fitness 0/100 / MCNS gate / hand-checked novelty scores
node scripts/verify-self-play.mjs          # Evolution 92.0: FP convergence (Kuhn −1/18 exact) / exploitability declining / league exploiters
node scripts/verify-automl-hyperband.mjs   # Evolution 93.0: paper schedule reproduction + budget conservation / 40/40 at 95th percentile / late-bloomer
node scripts/verify-sim-interrupt.mjs      # Evolution 94.0+95.0: MMD²/energy analytic anchors + 99.9% gap reduction / interruption recovery 1.5e-13 + closed-form tau*
node scripts/verify-global-workspace.mjs   # Consciousness 96.0: hard WTA = independent argmax / threshold semantics / four-round cascade / entropy monotone
node scripts/verify-metacognition-replay.mjs # Consciousness 97.0+98.0: d-prime recovery + quadrant separation + closed-form ask / PER-IS unbiased + sleep + 88.9%→0
node scripts/verify-attention-self.mjs     # Consciousness 99.0+100.0: greedy = enumeration + second prices + lying never profits in 500 tries / agency 40/40 + breaks
node scripts/verify-autonomy25-wiring.mjs  # Second genesis 76.0-100.0 wiring: 14 engines end-to-end zero-drift comparison (flags off = bit-identical status quo)
node scripts/verify-mod-sentinel.mjs      # Round 3 A1 sentinel: adaptive window (residence 5× better) / urgency decay / token-bucket backpressure / provenance cycle guard / NCD / fingerprints
node scripts/verify-mod-decision.mjs      # Round 3 A2 decision: hysteresis (flapping −60%) / counterfactual ledger / ask-user VOI gate / bucket calibration (misses 18→0) / audit
node scripts/verify-mod-scheduler.mjs     # Round 3 A3 scheduling: 3-state breaker (EWMA+backoff+half-open) / P2C load balancing / cost profile / per-model retry budget / audit
node scripts/verify-mod-executor.mjs      # Round 3 A4 executor: EDF (3/6→6/6) / tail hedging (p99 300→87ms) / retry budget / checkpoint resume (saves 40ms) / virtual clock
node scripts/verify-mod-memory.mjs        # Round 3 A5 memory: hot/warm/cold tiering (0.64 vs 0.50) / four-way fusion / alias disambiguation / checksum atomic writes / migration dry-run / graph stats
node scripts/verify-mod-reflect.mjs       # Round 3 A6 reflection axis: confidence routing / rationale decomposition / retry bandit (cost −50%) / OPE dataset / insight dedup / sedimentation scoring
node scripts/verify-mod-autonomy.mjs      # Round 3 A7 autonomy: goal-DAG budget / stale demotion & merge / value×success ranking / blind-spot curiosity (3/3 vs 0/3) / 5-phase heartbeat
node scripts/verify-mod-meta.mjs          # Round 3 A8 meta-cognition: stabilizer loop (3 adjusts 0 flips) / 89.0 certificate gate / change-log rollback / self-calibration / relative KPI band (32 batches 0 false alarms)
node scripts/verify-mod-evolution.mjs     # Round 3 A9 evolution: certificate-gated loop (sandbox→OPE→LCB→canary→rollback) / adversarial difficulty / lineage tree / softmax governance / stagnation restart
node scripts/verify-mod-world.mjs         # Round 3 A10 world model: observation-belief fusion (contamination 10→0) / time-travel snapshot diff / capability downgrade chain / host bridge 5 states / health
node scripts/verify-mod-symbiosis.mjs     # Round 3 A11 symbiosis: order-book invariants I1-I5 / LMSR consistency / hash-chain tamper localization / Sybil resistance (209.9→29.98) / argued vetoes
node scripts/verify-mod-distributed.mjs   # Round 3 A12 distributed: fault-injection bench (500 rounds 0 violations) / log-compaction snapshots / CRDT anti-entropy (−87.5%) / hot-reload closure
node scripts/verify-mod-governance.mjs    # Round 3 A13 governance: water-filling quotas / noisy-neighbor suppression / key-rotation grace / Shamir 5-of-3 escrow / action ladder / constant-time compare
node scripts/verify-mod-client.mjs        # Round 3 A14 client: decorrelated jitter (avalanche std 0→165ms+) / token hard budget / streaming backpressure / final-must-emit / offset resume
node scripts/verify-mod-bench-dash.mjs    # Round 3 A15 benchmark & dashboard: sign test + bootstrap CI (coverage 0.947) / e-process regression (power 0.95, 0 false alarms) / BAI / three panels
node scripts/verify-mod-contracts.mjs     # Round 3 A16 contracts: 13-code taxonomy / path-typed validator errors / 8 brand IDs / Result monad laws / event envelope guard
node scripts/verify-mod-pipeline.mjs      # Round 3 A17 main pipeline: 10-step audit trail / 18-tool input validation / reverse-order release audit / introspect 3 new fields / advisory adapters
node scripts/verify-mod-telemetry.mjs     # Round 3 A18 telemetry bus: event bus (wildcard/ring/final-must-emit/gaps) / metrics registry / audit hash chain / trace spans
node scripts/verify-mod-integration.mjs   # Round 3 A19 integration regression: cross-domain data-flow smoke (signal→…→market, 9 domains) / telemetry×contract alignment / dashboard endpoints
node scripts/verify-r4-sentinel.mjs       # Round 4 R4-1 sentinel: common-cause lift 3.85 vs ≈1.0 / period-miss visibility / 0.6^k cascade decay / rank 4→2 / storm budget 31→19
node scripts/verify-r4-decision.mjs       # Round 4 R4-2 decision: batch joint (strategist 10→1, cost −58.5%) / fatigue 30→10 / failure clustering / path explainer / undo protocol
node scripts/verify-r4-scheduler.mjs      # Round 4 R4-3 scheduling: Condorcet ensemble 0.6576>0.62 / prewarm 2010ms early / 3-phase admission 10/10→0/10 / cost drift / specialty profile
node scripts/verify-r4-executor.mjs       # Round 4 R4-4 executor: adaptive parallelism (concurrency 3, −59%) / failure domains 5→0 / ETA 885%→8.2% / plan compression 6→4
node scripts/verify-r4-memory.mjs         # Round 4 R4-5 memory: conflict arbitration / temperature 0.439 vs 0.051 / causal chain / health audit 5 defects / transfer mapping 16×
node scripts/verify-r4-reflect.mjs        # Round 4 R4-6 reflection axis: cross-task transfer triple gate / depth grading saves 25% / failure knowledge base / confidence propagation / templates
node scripts/verify-r4-autonomy.mjs       # Round 4 R4-7 autonomy: resource conflicts 2 detected 0 false positives / exploration 3→4→1 / 3-tier safety fail-closed / milestones / across midnight
node scripts/verify-r4-meta.mjs           # Round 4 R4-8 meta-cognition: multi-scale glitch vs true degradation / efficacy error ≤0.03 / cognitive-load gate / magnitude meta-learning / KPI graph
node scripts/verify-r4-evolution.mjs      # Round 4 R4-9 evolution: diversity warning 3 generations early, 8.2× after injection / transfer +0.22 / rate adaptation / A/B lineage / freeze
node scripts/verify-r4-world.mjs          # Round 4 R4-10 world model: counterfactual shadow world 0 pollution / uncertainty quadrants 0.3 / hypothesis flips / causal ledger / host bridge pool
node scripts/verify-r4-symbiosis.mjs      # Round 4 R4-11 symbiosis: liquidity 1818 vs 168bps / inflation settled back in band, dividends 40→20 / profile mutation / conditional settlement / manipulation
node scripts/verify-r4-distributed.mjs    # Round 4 R4-12 distributed: post-isolation 4 nodes commit as usual / partition healing explicitly booked / 3→5→4 no dual leader / federation 77.3% / canary
node scripts/verify-r4-governance.mjs     # Round 4 R4-13 governance: quota warning 1000ms early 0 false positives / tiered keys / forensics triple verification / SHA-256 export / threat jumping
node scripts/verify-r4-client.mjs         # Round 4 R4-14 client: capability probing never overstated / priority queue preemption / streaming resume −60% / snapshot incremental / cost reconciliation
node scripts/verify-r4-bench-dash.mjs     # Round 4 R4-15 benchmark & dashboard: trends 0/48 false alarms (old 12/19) / recommendations 12/12 vs random 2/12 / matrix significance / alarm panel
node scripts/verify-r4-contracts.mjs      # Round 4 R4-16 contracts: version negotiation 15 combinations / schema evolution audit / invariant library / dependency graph topo+cycles+DOT / retry taxonomy
node scripts/verify-r4-pipeline.mjs       # Round 4 R4-17 main pipeline: modules.* 16-flag activation differential (all-off zero drift) / cross-step cache bit-identical / degradation ladder / prefetch 62→50
node scripts/verify-r4-telemetry.mjs      # Round 4 R4-18 telemetry phase 2: sliding-window aggregation / Bresenham deterministic sampling / Prometheus export / dual-threshold retention / tail sampling
node scripts/verify-r4-integration.mjs    # Round 4 R4-19 integration: five-segment joint smoke, 55 assertions / activation wiring end-to-end / symbiosis wall-clock fix (frozen clock)
node scripts/verify-r5-statistics.mjs     # Round 5 statistics (3.0/12.0/13.0/23.0/24.0): closed-form Bayes factors / mixture e-processes / Mondrian conformal / Hodges–Lehmann / exponential mechanism + RDP (83 assertions)
node scripts/verify-r5-causal.mjs         # Round 5 causal (5.0/10.0/11.0/77.0): natural effects total=NDE+NIE / exact-DP GES / batch EIG / MDL two-part code (78 assertions)
node scripts/verify-r5-bayes.mjs          # Round 5 Bayesian computation (6.0/26.0/27.0/57.0/58.0): canonical EFE / natural gradient 12 vs 2000 steps / underdamped MALA / FITC / UKF≡KF (60 assertions)
node scripts/verify-r5-metacognition.mjs  # Round 5 metacognition (7.0/8.0/9.0/96.0/97.0): Bayesian persuasion / closed-form Poisson stopping / rate-distortion abstraction / GWT annealing / type-2 ROC fit (91 assertions)
node scripts/verify-r5-infogeo.mjs        # Round 5 information geometry (17.0/18.0/37.0/68.0/70.0): exact 1-D Wasserstein / debiased Sinkhorn / closed-form hyperbolic Fisher / deterministic IB / BROJA KKT / LZ77 (108 assertions)
node scripts/verify-r5-planning.mjs       # Round 5 planning & search (19.0/29.0/71.0/84.0/85.0): k-choice prophet inequality / PUCT + subtree reuse / weighted A* w-suboptimality / VSIDS (48 assertions)
node scripts/verify-r5-decision.mjs       # Round 5 decision computing (21.0/22.0/51.0/52.0/53.0/73.0): cost Gittins / BwK dual certificates / exact Whittle / LUCB / DP weighted majority / closed-form tree speculation (77 assertions)
node scripts/verify-r5-online.mjs         # Round 5 online learning (31.0/65.0/74.0/75.0/88.0/89.0): AdaHedge / optimistic FTRL O(1) / scarcity pricing DP / switch-DR ×10.6 / multi-candidate FWER (74 assertions)
node scripts/verify-r5-control.mjs        # Round 5 control & optimization (32.0/34.0/35.0/43.0/54.0/87.0): CVaR bound 49× / LQG separation theorem / weighted backpressure / multi-barrier / sparse assignment Hall / Dinic + min-cost flow (90 assertions)
node scripts/verify-r5-stochastic.mjs     # Round 5 stochastic processes (25.0/28.0/40.0/41.0/42.0/55.0): M/G/1 PK + cμ / square-root staffing / multivariate Hawkes / harmonic comb / GPD delta-CI / drifted first passage (68 assertions)
node scripts/verify-r5-spectral.mjs       # Round 5 spectral (33.0/39.0/49.0/50.0/78.0/79.0): personalized PageRank / MP density + Tracy–Widom / Gavish–Donoho / D4 algebraic / kernel CCA / landmark diffusion 69× (64 assertions)
node scripts/verify-r5-topology.mjs       # Round 5 topology & dynamics (36.0/38.0/66.0/69.0/76.0/91.0): H₁ representative cycles + clearing / quantile covers / Wolf ln2 / LOF / density archive / parallel tempering + Luby (81 assertions)
node scripts/verify-r5-fairness.mjs       # Round 5 fair division (16.0/44.0/45.0/60.0/63.0/99.0): weighted Shapley / EF1 + envy cycles / nucleolusFast / OCBA rounding / weighted Hamming RD / decaying attention (92 assertions)
node scripts/verify-r5-consensus.mjs      # Round 5 consensus & verification (15.0/20.0/46.0/47.0/48.0/56.0): R+W>n analyzer / delta-CRDT −44% / Feldman VSS / LTLf past operators / H⁰ dimension / Bethe + GDL ×31.6 (71 assertions)
node scripts/verify-r5-evolutionary.mjs   # Round 5 evolutionary learning (14.0/59.0/67.0/92.0/93.0/98.0): CVT-MAP-Elites / ε-dominance archive / weakness + α-rank / curriculum-ordering theorem / three-factor replay (103 assertions)
node scripts/verify-r5-game.mjs           # Round 5 game & mechanisms (61.0/62.0/64.0/81.0/82.0/90.0): capacitated DA + Rural Hospital / auction branch & bound ×6141 / coarse CE / Bayesian aggregation / VAF / Plackett–Luce (100 assertions)
node scripts/verify-r5-learning.mjs       # Round 5 learning systems (30.0/72.0/80.0/83.0/86.0/94.0): graph-cut SFMin / SAFE strong rules / prioritized sweeping / bottleneck skills / CountSketch / truncated IW + bootstrap (68 assertions)
node scripts/verify-r5-resilience.mjs     # Round 5 resilient autonomy (4.0/95.0/100.0): full closed-form Weibull + k-of-n 1867× / interruption composition invariance + vectorized 6.5× / multi-step causal chains + other-agent models (85 assertions)
node scripts/verify-r5-integration.mjs    # Round 5 integration regression: 8-group cross-group kernel chain + 3 accelerated-equivalence paths + 80-symbol root-export reachability (30 assertions)
```

| Group | Scripts |
|------|------|
| Dual mind | verify-scientist · verify-theorist |
| Kernel stack | verify-unified-evidence · verify-resilience-governance · verify-causal-kernel · verify-active-inference · verify-deliberation · verify-metareasoning · verify-abstraction |
| Guarantee-layer kernels 12.0-16.0 | verify-anytime-evidence · verify-conformal · verify-quality-diversity · verify-runtime-verification · verify-shapley |
| Geometry & topology layer 17.0-20.0 | verify-frontier-kernels · verify-frontier-wiring |
| Genesis layer 21.0-25.0 | verify-genesis-kernels · verify-genesis-wiring |
| Prophet layer 26.0-30.0 | verify-prophet-kernels · verify-prophet-wiring |
| Equilibrium layer 31.0-35.0 | verify-equilibrium-kernels · verify-equilibrium-wiring |
| Awakening layer 36.0-40.0 | verify-awakening-kernels · verify-awakening-wiring |
| Flux layer 41.0-45.0 | verify-flux-kernels · verify-flux-wiring |
| Fabric layer 46.0-50.0 | verify-fabric-kernels · verify-fabric-wiring |
| Singularity layer 51.0-55.0 | verify-speculative-decoding · verify-test-time-compute · verify-whittle-index · verify-lyapunov-drift · verify-hawkes-process |
| Mind layer 56.0-60.0 | verify-belief-propagation · verify-variational-langevin · verify-curriculum-rd |
| Game layer 61.0-65.0 | verify-stable-matching · verify-mechanism-design · verify-game-kernels · verify-pricing-calibration |
| Emergence layer 66.0-70.0 | verify-stochastic-optimization · verify-compression-distance · verify-mapper-graph · verify-partial-info-decomposition |
| Proof layer 71.0-75.0 | verify-search-sparse · verify-online-frontier · verify-pricing-calibration · verify-genesis25-wiring |
| Perception layer 76.0-80.0 | verify-novelty-detection · verify-causal-discovery · verify-alignment-manifold · verify-streaming-sketch |
| Judgment layer 81.0-85.0 | verify-argumentation · verify-crowd-aggregation · verify-model-pomdp · verify-symbolic-solver |
| Execution layer 86.0-90.0 | verify-execution-kernels · verify-ope-spi · verify-preference-learning |
| Evolution layer 91.0-95.0 | verify-novelty-search · verify-self-play · verify-automl-hyperband · verify-sim-interrupt |
| Consciousness layer 96.0-100.0 | verify-global-workspace · verify-metacognition-replay · verify-attention-self · verify-autonomy25-wiring |
| Round-3 module domains (A1-A18) | verify-mod-sentinel · verify-mod-decision · verify-mod-scheduler · verify-mod-executor · verify-mod-memory · verify-mod-reflect · verify-mod-autonomy · verify-mod-meta · verify-mod-evolution · verify-mod-world · verify-mod-symbiosis · verify-mod-distributed · verify-mod-governance · verify-mod-client · verify-mod-bench-dash · verify-mod-contracts · verify-mod-pipeline · verify-mod-telemetry |
| Round-3 integration (A19) | verify-mod-integration |
| Round-4 module domains (R4-1..16) | verify-r4-sentinel · verify-r4-decision · verify-r4-scheduler · verify-r4-executor · verify-r4-memory · verify-r4-reflect · verify-r4-autonomy · verify-r4-meta · verify-r4-evolution · verify-r4-world · verify-r4-symbiosis · verify-r4-distributed · verify-r4-governance · verify-r4-client · verify-r4-bench-dash · verify-r4-contracts |
| Round-4 activation & integration (R4-17..19) | verify-r4-pipeline · verify-r4-telemetry · verify-r4-integration |
| Round-5 kernel-evolution groups (R5-A1..18) | verify-r5-statistics · verify-r5-causal · verify-r5-bayes · verify-r5-metacognition · verify-r5-infogeo · verify-r5-planning · verify-r5-decision · verify-r5-online · verify-r5-control · verify-r5-stochastic · verify-r5-spectral · verify-r5-topology · verify-r5-fairness · verify-r5-consensus · verify-r5-evolutionary · verify-r5-game · verify-r5-learning · verify-r5-resilience |
| Round-5 integration (R5-A19) | verify-r5-integration |
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
├── scripts/                      # Patch generator + 138 offline verification scripts (round-3 verify-mod-*, round-4 verify-r4-* and round-5 verify-r5-* included)
└── src/
    ├── index.ts                  # Plugin entry: 10-step pipeline orchestration + 18 tool registrations (round 4: autonomy.modules.*/pipeline.* activation wiring + introspect moduleFlags overview)
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
    ├── core/                     # Kernel stack: ninety-eight kernels from evidence 3.0 to self-boundary 100.0 (century cap; round-5 four-axis evolution, 80 new APIs on the root export)
    ├── engines-frontier/         # Genesis wiring adapters: genesis25.ts (51.0-75.0) / autonomy25.ts (76.0-100.0 + round-4 module 16-flag MODULE_FLAGS / mount adapters)
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
    ├── dashboard/                # Visual dashboard
    └── telemetry/                # Telemetry audit bus (round-3 new module, round-4 phase 2): event bus / metrics registry (sliding windows) / audit hash chain / trace spans / sampling & Prometheus export / dual-threshold retention
```

## License

[MIT](./LICENSE)
