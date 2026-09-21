# dsh-proactive

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.json)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.18-339933?logo=nodedotjs&logoColor=white)](#installation)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-8250df)](https://github.com/topics/dsh-plugin)

> **Proactive Intelligence scheduling plugin** — a multi-model collaborative scheduling system for the DeepSeek Harness (DSH) ecosystem: it perceives, decides, and evolves on its own, with a built-in **Scientist / Theorist dual mind**, a **cognitive energy symbiosis economy**, and **forty-eight phase-change kernels (evidence → geometry-topology / genesis / prophet / equilibrium / awakening / flux / fabric layers: anytime-valid / conformal / optimal transport / information geometry / sheaf consensus / Gittins / robust statistics / differential privacy / capacity planning / Gaussian process / Kalman filtering / extreme value theory / Monte-Carlo tree search / submodular optimization / adversarial no-regret learning / Hungarian global assignment / random matrix / CVaR distributional robustness / LQR feedback control / persistent homology / information bottleneck / nonlinear dynamics / PageRank spectral ranking / first passage / Jackson queueing networks / FFT spectral periodicity / max-flow / max-min fairness / OCBA budget allocation / quorum intersection / CRDT convergence / Shamir secret sharing / Haar wavelets / low-rank matrix completion)**.
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
├─ Kernel Stack (core/) — forty-eight kernels, 3.0 → 50.0 ──┤
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

### Kernel Stack (core/, 3.0 → 50.0)
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

All runtime options (sentinel / encryption / sync / consensus / hot reload / tenants / autonomy loop `autonomy` / host fusion `hostFusion`) are likewise built into [cordis.patch.yml](./cordis.patch.yml) and need no changes; symbiosis options live under `autonomy.symbiosis` (futarchy voting, energy feedback, etc., off by default). Guarantee-layer kernel options 12.0-16.0 and geometry/topology-layer options 17.0-20.0 are also off by default (zero drift): `autonomy.anytimeEvidence` (α / reference watermark), `autonomy.conformal` (α / calibration capacity / threshold risk & confidence), `autonomy.qualityDiversity` (explore rate), `autonomy.runtimeVerification` (additional `specs`), `autonomy.optimalTransport` (monitored KPIs / windows / threshold quantile), `autonomy.informationGeometry` (KL budget / step scale), `autonomy.optimalStopping` (opportunity horizon / min samples), `autonomy.sheafConsensus` (obstruction misfit tolerance); equilibrium-layer options 31.0-35.0 are likewise off by default (zero drift): `autonomy.hedgePortfolio` (learning rate η / share α), `autonomy.optimalAssignment` (candidate cap), `autonomy.randomMatrix` (window / min models / edge factor / share threshold), `autonomy.cvarTimeouts` (confidence α / margin / min samples), `autonomy.concurrencyControl` (target utilization / plant gain / control weight / deadband); awakening-layer options 37.0-40.0 are likewise off by default (zero drift): `autonomy.informationBottleneck` (β / retention floor), `autonomy.chaosDiagnostics` (min points / λ threshold / Hurst delta), `autonomy.spectralRanking` (damping), `autonomy.firstPassageCooldown` (recovery confidence target); flux-layer options 41.0-45.0 are likewise off by default (zero drift): `autonomy.queueingNetwork` (bottleneck rho threshold), `autonomy.spectralCalendar` (hourly bins), `autonomy.capacityFrontier`, `autonomy.fairBudget`, `autonomy.ocbaAllocator` (confirmation budget); fabric-layer options 49.0-50.0 are likewise off by default (zero drift): `autonomy.waveletView` (min points), `autonomy.latentFactors` (rank); fabric 46.0-48.0 are engine read-only methods (Raft `quorumAudit` / Sync CRDT channel / CryptoEngine `shardKey`) with no runtime switch; 36.0 persistent homology is queried on demand via the `topology` action of `query_memory` (zero drift).

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

## Offline Verification (43, zero API keys)

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
node scripts/verify-equilibrium-kernels.mjs # Equilibrium layer 31.0-35.0: adversarial regret bounds / Hungarian-vs-brute-force + dual certificates / MP-edge matching / CVaR-vs-RU / DARE closed form / machine-precision Lyapunov
node scripts/verify-equilibrium-wiring.mjs  # Equilibrium wiring: real engines end-to-end (adversarial demotion & comeback / batch one-to-one / common-factor insight / heavy-tail timeout pricing / closed-loop concurrency)
node scripts/verify-awakening-kernels.mjs  # Awakening layer 36.0-40.0: continents & islands + bottleneck stability / IB-DPI + β frontier / logistic λ₁=ln2 + Hurst constitutions / exact ring uniformity / reflection vs 20k paths
node scripts/verify-awakening-wiring.mjs   # Awakening wiring: real engines end-to-end (knowledge topography / distillation information gate / chaos-regime flip insight / hub influence / breaker cooldown pricing)
node scripts/verify-flux-kernels.mjs     # Flux layer 41.0-45.0: tandem M/M/1 simulation vs analytic + Jackson independence / FFT identities + Parseval + period recovery / max-flow vs brute-force min-cut + certificates / textbook water-filling + fairness audit / OCBA-vs-uniform P(CS)
node scripts/verify-flux-wiring.mjs      # Flux wiring: real engines end-to-end (spectral calendar diurnal detection / capacity-frontier writeback / family fairness anti-starvation / OCBA bottleneck focus)
node scripts/verify-fabric-kernels.mjs   # Fabric layer 46.0-50.0: quorum closed-form vs brute-force + 3f+1 bound / CRDT permutation convergence + add-win / Shamir threshold reconstruction + zero leakage / wavelet perfect reconstruction + Parseval / low-rank recovery
node scripts/verify-fabric-wiring.mjs    # Fabric wiring: real engines end-to-end (Raft safety audit / two-instance CRDT convergence / key sharding reconstruction / wavelet burst capture / cold-start latent extrapolation)
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
├── scripts/                      # Patch generator + 43 offline verification scripts
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
    ├── core/                     # Kernel stack: forty-eight kernels from evidence 3.0 to matrix-completion 50.0
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
