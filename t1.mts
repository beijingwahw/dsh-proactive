import { pollaczekKhinchine, priorityQueueWaits, cmuPriorityOrder } from './src/core/queueing-network.ts';
// M/M/1 degenerate: λ=0.8, μ=1 → Wq = 4
const mm1 = pollaczekKhinchine(0.8, 1, 1);
console.log('M/M/1 deg:', mm1.avgWait, '(expect 4)');
const md1 = pollaczekKhinchine(0.8, 1, 0);
console.log('M/D/1:', md1.avgWait, '(expect 2)');
// priority: 3 classes
const classes = [
  { name: 'gold', lambda: 0.3, mu: 2, scv: 1, costRate: 5 },
  { name: 'silver', lambda: 0.4, mu: 4, scv: 1, costRate: 1 },
  { name: 'bronze', lambda: 0.2, mu: 1, scv: 1, costRate: 0.5 },
];
const rep = priorityQueueWaits(classes);
console.log('stable', rep.stable, 'w0', rep.residualWork);
console.log('conservation sum', rep.conservationSum, 'theoretical', rep.conservationTheoretical);
console.log('waits', rep.classes.map(c => c.avgWait.toFixed(4)));
console.log('cmuOrder', rep.cmuOrder, 'cost', rep.weightedWaitCost.toFixed(4), 'cmuCost', rep.cmuWeightedWaitCost.toFixed(4));
// permutation invariance
