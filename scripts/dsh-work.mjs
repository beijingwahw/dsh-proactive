/**
 * dsh-work.mjs — 真实工作负载驱动器（把真活儿喂进完整管线）
 *
 * 用途：向运行中的 daemon（哨兵 webhook :9878）投递**真实任务**——
 * 任务材料取自本仓库的真实文件与真实状态，内容随信号入站（执行 LLM
 * 收到的是真实材料而非凭空想象），产出有真实价值：
 *
 *   review   —— 抽取一个源文件的关键段，审查边界条件/潜在缺陷
 *   analyze  —— 嵌入学习经济实况（plasticity 状态摘要），给健康判读
 *   summarize—— 嵌入验证脚本头部，给覆盖面总结与缺口
 *
 * 每个任务走完整管线：webhook 信号 → 哨兵窗口 → 决策引擎 → 规划 →
 * 模型执行（真实 token）→ 结算 → 学习入账。任务类型多样化（code-review /
 * analysis / summarization）同时为 τ2 结构固化供应上下文多样性——
 * 这正是 self-improvement 单一类型流量的最大缺口。
 *
 * 运行：node scripts/dsh-work.mjs [任务数（缺省 3）] [间隔秒（缺省 30）]
 */

import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.DSH_WORK_PORT ?? 9878;
const COUNT = Math.max(1, Number(process.argv[2] ?? 3));
const INTERVAL_MS = Math.max(5, Number(process.argv[3] ?? 30)) * 1000;

/** 从文件抽取指定行段（材料真实性的来源） */
function excerpt(file, from, to) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return lines.slice(from - 1, to).join('\n');
  } catch {
    return null;
  }
}

/** 学习经济实况摘要（analyze 任务的真材料） */
function economyBrief() {
  try {
    const s = JSON.parse(fs.readFileSync('.scheduler/plasticity.json', 'utf8'));
    const arms = {};
    for (const e of s.events) {
      for (const c of e.contributors) {
        arms[c.agentId] = arms[c.agentId] ?? { n: 0, ok: 0, tok: 0 };
        arms[c.agentId].n += 1;
        if (c.success ?? e.success) arms[c.agentId].ok += 1;
        arms[c.agentId].tok += c.tokens ?? 0;
      }
    }
    const lines = Object.entries(arms)
      .filter(([, v]) => v.n >= 2)
      .map(([a, v]) => `${a}: 参与 ${v.n} 成功 ${v.ok} 累计token ${v.tok}`);
    return `事件总数 ${s.events.length}；臂画像：\n${lines.join('\n')}`;
  } catch {
    return null;
  }
}

/** 任务工厂：每次调用产出一个真实任务（材料新鲜，内容不同） */
function* taskFactory() {
  const reviewTargets = [
    { file: 'src/plasticity/loop.ts', from: 380, to: 460, focus: 'observeTask/autoGate 的边界条件与回滚正确性' },
    { file: 'src/plasticity/consolidation.ts', from: 200, to: 280, focus: '固化门槛与准备金判定的边界情况' },
    { file: 'src/plasticity/probes-ops.ts', from: 60, to: 140, focus: '流动性检测与偿付能力过滤的漏洞' },
    { file: 'src/symbiosis/bridge.ts', from: 700, to: 760, focus: '结算学习信号装配的完整性' },
    { file: 'src/task-executor.ts', from: 1712, to: 1760, focus: '选型路径与推荐反垄断的交互' },
  ];
  const summaryTargets = [
    { file: 'scripts/verify-plasticity.mjs', from: 1, to: 45 },
    { file: 'scripts/verify-genesis-bank.mjs', from: 1, to: 40 },
    { file: 'scripts/soak-plasticity.mjs', from: 1, to: 35 },
  ];
  let i = 0;
  while (true) {
    const kind = i % 3;
    if (kind === 0) {
      const t = reviewTargets[i % reviewTargets.length];
      const code = excerpt(t.file, t.from, t.to);
      if (code) {
        yield {
          type: 'code-review',
          description: `审查以下 TypeScript 代码段（来自 ${t.file} 第 ${t.from}-${t.to} 行），聚焦 ${t.focus}。列出最多 3 个真实问题，每个一行，没有问题就明确说没有。\n\n\`\`\`typescript\n${code}\n\`\`\``,
        };
      }
    } else if (kind === 1) {
      const brief = economyBrief();
      if (brief) {
        yield {
          type: 'analysis',
          description: `以下是一个多模型调度系统的学习经济实况。给出 3 条以内的运营判读（哪个模型强、哪里可疑、下一步该看什么），每条一行。\n\n${brief}`,
        };
      }
    } else {
      const t = summaryTargets[i % summaryTargets.length];
      const head = excerpt(t.file, t.from, t.to);
      if (head) {
        yield {
          type: 'summarization',
          description: `总结以下验证脚本的覆盖范围与它自己声称验证的性质，指出一个它没覆盖的缺口，两行以内。\n\n${head}`,
        };
      }
    }
    i += 1;
  }
}

async function main() {
  console.log(`真实工作负载驱动：${COUNT} 个任务，间隔 ${INTERVAL_MS / 1000}s → http://127.0.0.1:${PORT}`);
  const tasks = taskFactory();
  let sent = 0;
  for (let k = 0; k < COUNT * 2 && sent < COUNT; k += 1) {
    const task = tasks.next().value;
    if (!task) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...task, dedupeKey: `work-${Date.now()}-${sent}` }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 200) {
        sent += 1;
        console.log(`  ✓ [${task.type}] signalId=${j.signalId}（${task.description.slice(0, 48)}…）`);
      } else {
        console.log(`  ✗ 入站失败 HTTP ${res.status}: ${JSON.stringify(j).slice(0, 80)}`);
      }
    } catch (err) {
      console.error(`  ✗ 连接失败（daemon 是否在跑？哨兵 webhook 是否启用？）: ${err.message}`);
      process.exit(1);
    }
    if (sent < COUNT) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.log(`完成：${sent}/${COUNT} 已入站。任务将依次经决策→规划→执行→结算入账。`);
}

main();
