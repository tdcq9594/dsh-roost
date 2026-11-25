// 行动单执行器 createExecV5：整文件移植自 aurabot exec.js，验核心行为闭环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecV5 } from '../src/autotelic-exec.js';

const base = (steps, extra = {}) => ({
  id: 't-1', intent: '整理笔记', tag: '未完成', steps,
  budget: { maxSteps: 4, timeoutMs: 5000 }, ownerSide: false, ...extra,
});

test('硬禁区：任一步命中 → 整单 rejected，一步都不执行', async () => {
  let called = 0;
  const ex = createExecV5({
    hooks: { execStep: async () => { called++; return { ok: true, observation: 'done' }; } },
    log: {},
  });
  const r = await ex.run(base([
    { desc: '读笔记', level: 'read-only' },
    { desc: '修改 host.json 里的端口', level: 'write-data' },
  ]));
  assert.equal(r.status, 'rejected');
  assert.equal(called, 0, '禁区单不许执行任何一步');
});

test('read-only 正常执行到 done', async () => {
  const ex = createExecV5({
    hooks: { execStep: async () => ({ ok: true, observation: '读完了' }) },
    log: {},
  });
  const r = await ex.run(base([{ desc: '读一遍笔记', level: 'read-only' }]));
  assert.equal(r.status, 'done');
  assert.ok(r.results && r.results.length >= 1);
});

test('touch-owner 默认排队等确认，不直接动手', async () => {
  let called = 0;
  const ex = createExecV5({
    hooks: { execStep: async () => { called++; return { ok: true, observation: 'done' }; } },
    log: {},
  });
  const ticket = base([{ desc: '给主人发一句问候', level: 'touch-owner' }], { ownerSide: true });
  const r = await ex.run(ticket);
  assert.equal(r.status, 'queued');
  assert.equal(called, 0, '没确认前一步都不能跑');
  assert.ok(ex.pendingList().some((x) => x.ticketId === 't-1' || x.id === 't-1'), '进待确认队列');
});

test('autoConfirmOwner 豁免：配置打开后 touch-owner 直接执行', async () => {
  let called = 0;
  const ex = createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    hooks: { execStep: async () => { called++; return { ok: true, observation: 'done' }; } },
    log: {},
  });
  const r = await ex.run(base([{ desc: '给主人发一句问候', level: 'touch-owner' }], { ownerSide: true }));
  assert.equal(r.status, 'done');
  assert.ok(called > 0);
});

test('确认后执行、取消不执行', async () => {
  let called = 0;
  const ex = createExecV5({
    hooks: { execStep: async () => { called++; return { ok: true, observation: 'done' }; } },
    log: {},
  });
  await ex.run(base([{ desc: '给主人发一句问候', level: 'touch-owner' }], { ownerSide: true }));
  const cancelled = ex.cancel('t-1');
  assert.equal(cancelled.status, 'aborted');
  assert.equal(called, 0);
  await ex.run(base([{ desc: '给主人发一句问候', level: 'touch-owner' }], { ownerSide: true }));
  const confirmed = await ex.confirm('t-1');
  assert.equal(confirmed.status, 'done');
  assert.ok(called > 0);
});

test('发言自查（P0）：答不出 loss 就降级为只写日记，不执行这一步', async () => {
  let stepped = 0;
  const ex = createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    hooks: {
      execStep: async () => { stepped++; return { ok: true, observation: '发出去了' }; },
      selfCheck: async () => ({ pass: false, loss: '' }),
    },
    log: {},
  });
  const r = await ex.run(base([{ desc: '给主人发一句问候', level: 'touch-owner' }], { ownerSide: true }));
  assert.equal(stepped, 0, '自查不过不许执行');
  assert.equal(r.status, 'aborted', '全被降级 → aborted，不算 done');
  assert.match(JSON.stringify(r.results), /downgraded-diary/);
});

test('发言自查（P0）：答得出 loss 就放行执行', async () => {
  let stepped = 0;
  const ex = createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    hooks: {
      execStep: async () => { stepped++; return { ok: true, observation: '发出去了' }; },
      selfCheck: async () => ({ pass: true, loss: '主人会错过今天的进度' }),
    },
    log: {},
  });
  const r = await ex.run(base([{ desc: '给主人发一句问候', level: 'touch-owner' }], { ownerSide: true }));
  assert.equal(stepped, 1, '自查通过要执行');
  assert.equal(r.status, 'done');
});

test('发言自查（P0）：自查抛错按不放行处理，绝不默认通过', async () => {
  let stepped = 0;
  const ex = createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    hooks: {
      execStep: async () => { stepped++; return { ok: true, observation: 'x' }; },
      selfCheck: async () => { throw new Error('模型挂了'); },
    },
    log: {},
  });
  const r = await ex.run(base([{ desc: '给主人发一句问候', level: 'touch-owner' }], { ownerSide: true }));
  assert.equal(stepped, 0, '出错必须按不放行，不能静默放行');
  assert.equal(r.status, 'aborted');
});

test('投递记账（P1/P2）：done + ownerSide + 真跑过 touch-owner 才开观察窗', async () => {
  const make = (status) => {
    let n = 0;
    const ex = createExecV5({
      settings: () => ({ autoConfirmOwner: true }),
      feedback: { recordDelivery: () => { n += 1; } },
      hooks: { execStep: async () => ({ ok: status === 'done', observation: 'x' }) },
      log: {},
    });
    return { ex, count: () => n };
  };
  const d = make('done');
  await d.ex.run(base([{ desc: '给主人说一句', level: 'touch-owner' }], { ownerSide: true }));
  assert.equal(d.count(), 1, 'touch-owner 真发出才开窗');

  const f = make('failed');
  await f.ex.run(base([{ desc: '给主人说一句', level: 'touch-owner' }], { ownerSide: true }));
  assert.equal(f.count(), 0, 'failed 不开窗（没真发出去）');

  const rj = make('done');
  await rj.ex.run(base([{ desc: '改 host.json 端口', level: 'write-data' }], { ownerSide: true }));
  assert.equal(rj.count(), 0, 'rejected 不开窗');

  const np = make('done');
  await np.ex.run(base([{ desc: '给主人说一句', level: 'touch-owner' }], { ownerSide: false }));
  assert.equal(np.count(), 0, '非 ownerSide 不开窗');

  /** P2-3：read-only 步骤不构成「发出」，不该开窗 */
  const ro = make('done');
  await ro.ex.run(base([{ desc: '读笔记', level: 'read-only' }], { ownerSide: true }));
  assert.equal(ro.count(), 0, 'read-only 不算发出，不开窗');
});

test('投递记账（P2-3）：touch-owner 被自查降级时不开窗（哪怕整单 done）', async () => {
  let n = 0;
  const ex = createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    feedback: { recordDelivery: () => { n += 1; } },
    hooks: {
      execStep: async () => ({ ok: true, observation: '写好了' }),
      selfCheck: async () => ({ pass: false, loss: '' }),
    },
    log: {},
  });
  // 两步：touch-owner 被降级、write-data 成功 → 整单 done，但没真发出
  const r = await ex.run(base([
    { desc: '给主人说一句', level: 'touch-owner' },
    { desc: '写笔记文件', level: 'write-data' },
  ], { ownerSide: true }));
  assert.equal(r.status, 'done');
  assert.equal(n, 0, '降级的发言不能开观察窗');
});

test('投递记账（P1）：确认放行后也要开窗（settle 是唯一出口）', async () => {
  let n = 0;
  const ex = createExecV5({
    settings: () => ({ autoConfirmOwner: false }),
    feedback: { recordDelivery: () => { n += 1; } },
    hooks: { execStep: async () => ({ ok: true, observation: '发出去了' }) },
    log: {},
  });
  const q = await ex.run(base([{ desc: '给主人发一句', level: 'touch-owner' }], { ownerSide: true }));
  assert.equal(q.status, 'queued');
  assert.equal(n, 0, '排队时不开窗');
  const done = await ex.confirm('t-1');
  assert.equal(done.status, 'done');
  assert.equal(n, 1, '主人确认放行后才开窗');
});

test('发言自查（P1）：显式 pass:false 必须拦下，不能因 loss 非空反被判通过', async () => {
  let stepped = 0;
  const ex = createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    hooks: {
      execStep: async () => { stepped++; return { ok: true, observation: 'x' }; },
      selfCheck: async () => ({ pass: false, loss: '有具体损失' }),
    },
    log: {},
  });
  const r = await ex.run(base([{ desc: '给主人发一句', level: 'touch-owner' }], { ownerSide: true }));
  assert.equal(stepped, 0, 'pass:false 优先，必须拦');
  assert.equal(r.status, 'aborted');
});

test('发言自查（P2）：显式 pass:true 一律放行（哪怕 loss 为空）', async () => {
  let stepped = 0;
  const ex = createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    hooks: {
      execStep: async () => { stepped++; return { ok: true, observation: 'x' }; },
      selfCheck: async () => ({ pass: true, loss: '' }),
    },
    log: {},
  });
  const r = await ex.run(base([{ desc: '给主人发一句', level: 'touch-owner' }], { ownerSide: true }));
  assert.equal(stepped, 1, '显式 pass:true 就是放行，不能被 loss 二次否决');
  assert.equal(r.status, 'done');
});

test('频控（P2-A）：发送失败不占 24h 额度，第二次仍可发', async () => {
  let fail = true;
  const ex = createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    hooks: { execStep: async () => (fail ? { ok: false, observation: '发送失败' } : { ok: true, observation: '发出去了' }) },
    log: {},
  });
  const t1 = base([{ desc: '给主人说一句', level: 'touch-owner' }], { ownerSide: true });
  const r1 = await ex.run(t1);
  assert.equal(r1.status, 'failed');
  fail = false;
  // 同 tag 第二单：不该被自己失败的上一单挡成 rate-limited
  const r2 = await ex.run({ ...t1, id: 't-2' });
  assert.equal(r2.status, 'done', '失败不该吃掉频控额度');
  assert.doesNotMatch(JSON.stringify(r2.results), /rate-limited/);
});

test('开窗（P2-B）：touch-owner 已发出但后续步失败，仍要开窗', async () => {
  let n = 0;
  const ex = createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    feedback: { recordDelivery: () => { n += 1; } },
    hooks: {
      execStep: async (step) => (step.level === 'touch-owner'
        ? { ok: true, observation: '发出去了' }
        : { ok: false, observation: '写文件失败' }),
    },
    log: {},
  });
  const r = await ex.run(base([
    { desc: '给主人说一句', level: 'touch-owner' },
    { desc: '写笔记', level: 'write-data' },
  ], { ownerSide: true }));
  assert.equal(r.status, 'failed', '整单是 failed');
  assert.equal(n, 1, '但消息已真发出，观察窗必须开');
});
