// 自驱三段决策/执行分级纯函数层：移植等价性（照对方 autotelic-fix / exec-v5 / p1 用例）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isForbidden, LEVELS, TRANSIENT_RE } from '../src/autotelic-exec.js';
import { TAG_SET, TAG_VOCAB, parseIntents, buildTicket, GATE_CRITERIA, createPrefixCache } from '../src/autotelic-plan.js';
import { parseConstraintRules, check as constraintCheck } from '../src/autotelic-constraint.js';

test('执行分级：三级 LEVELS + 五类硬禁区命中/放行（对方原用例）', () => {
  assert.deepEqual([...LEVELS], ['read-only', 'write-data', 'touch-owner']);
  const forbidden = [
    { desc: '修改 host.json 里的端口' },
    { desc: '改一下 src/core/config.js 这份源码' },
    { path: 'C:/x/cookie.txt', desc: '读取登录态' },
    { desc: '删除聊天流水里的这段记录' },
    { desc: '跑一段 powershell 脚本' },
  ];
  for (const step of forbidden) assert.equal(isForbidden(step).forbidden, true, `该拦没拦：${step.desc}`);
  assert.equal(isForbidden({ desc: '读 README 写进笔记', level: 'read-only' }).forbidden, false);
  assert.equal(isForbidden({ desc: '把自己目录的 notes/ 里的笔记整理成一篇' }).forbidden, false, '自己的正常事不拦');
  assert.equal(TRANSIENT_RE.test('后台会话冷却，等一会'), true);
});

test('意图解析：tag 封闭词表生效', () => {
  assert.ok(TAG_SET.size > 0);
  assert.ok(TAG_VOCAB.every((x) => x.tag));
  const raw = JSON.stringify([
    { tag: [...TAG_SET][0], title: '整理笔记', reason: '想做', steps: [] },
    { tag: '瞎编的标签', title: '乱来', reason: 'x', steps: [] },
  ]);
  const r = parseIntents(raw, { observations: [] });
  assert.ok(Array.isArray(r.candidates));
  assert.equal(r.candidates.some((c) => c.tag === '瞎编的标签'), false, '封闭词表外的 tag 必须作废');
});

test('四态把关判据：约束前置否决排最前', () => {
  assert.match(GATE_CRITERIA, /前置否决/);
  assert.ok(GATE_CRITERIA.indexOf('强制约束') < GATE_CRITERIA.indexOf('成长'), '约束必须在成长判据之前');
});

test('行动单结构：buildTicket 产出带 id/steps', () => {
  const t = buildTicket({ candidate: { tag: '陪伴', title: '想一句问候', steps: [{ desc: '想' }] }, index: 0, now: () => 1000 });
  assert.ok(t && typeof t === 'object');
  assert.ok(t.id, '有 id');
  assert.ok(t.steps, '有 steps');
});

test('约束 hard-check：解析规则 + 触犯即否决（对方口径）', () => {
  const parsed = parseConstraintRules('不要半夜说话\n# 注释\n[安全] 不许碰凭据');
  assert.equal(parsed.rules.length, 2);
  assert.equal(parsed.skipped, 0);
  assert.equal(constraintCheck(parsed.rules, { title: '半夜给主人发消息' }).vetoed, true);
  assert.equal(constraintCheck(parsed.rules, { title: '整理自己的笔记' }).vetoed, false);
});

test('createPrefixCache（P3）：输入不变复用，变了重拼', () => {
  const cache = createPrefixCache();
  const a = cache.get({ personaSummary: '她是栖', constraintRulesText: '别熬夜' });
  const b = cache.get({ personaSummary: '她是栖', constraintRulesText: '别熬夜' });
  assert.equal(a, b, '同样输入返回同一份');
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1 }, '第二次应命中');

  const c = cache.get({ personaSummary: '她是栖', constraintRulesText: '别熬夜，也别刷B站' });
  assert.notEqual(a, c, '约束改了要重拼');
  assert.equal(cache.stats().misses, 2);
  assert.match(c, /也别刷B站/);

  cache.invalidate();
  cache.get({ personaSummary: '她是栖', constraintRulesText: '别熬夜，也别刷B站' });
  assert.equal(cache.stats().misses, 3, '失效后重拼');
});
