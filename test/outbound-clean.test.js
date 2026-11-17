import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanOutbound } from '../src/outbound-clean.js';

/**
 * 这层是给「模型把上下文抄进正文」兜底的。
 *
 * 对照 aurabot beta 的两个修复（2026-11-17 核验，我们原本都没有）：
 *   · `fix/thinking-leak`（`src/chat/reply.js`）
 *   · `fix(#395)`（`src/security/leak-guard.js`）
 *
 * 原则是**宁可漏删不可误删**，所以下面一半用例在测「不该动的东西没被删」。
 */

test('注入块：从标记处截断，后面的规则不再发出去', () => {
  const t = '我先说一句\n【系统提醒，不是主人说的话】距离上一轮已经过了半小时，别连着发。';
  assert.equal(cleanOutbound(t), '我先说一句');

  assert.equal(
    cleanOutbound('好，那我先睡\n# 输出协议\n只在被叫到时说话，一轮最多三段'),
    '好，那我先睡',
  );
  assert.equal(cleanOutbound('# 场景\n现在是深夜'), '', '整段都是注入内容 → 空');
});

test('思考残片：显式块与括号段都删掉', () => {
  assert.equal(cleanOutbound('【思考】她可能在忙【/思考】好，那你先忙'), '好，那你先忙');
  assert.equal(cleanOutbound('（思考：她好像不开心）那我陪你聊聊'), '那我陪你聊聊');
  assert.equal(cleanOutbound('[analysis] user is tired [/analysis]早点睡'), '早点睡');
});

test('「最终回答：」只留后面；前面是推理就整段截掉', () => {
  assert.equal(cleanOutbound('最终回答：明天几点见？'), '明天几点见？');
  assert.equal(cleanOutbound('用户问她几点来，她有点急。\n最终回答：我马上到'), '我马上到');
});

test('单独成行的「思考过程：」只有在带元信息时才删', () => {
  /** 带元信息 → 删 */
  assert.equal(cleanOutbound('思考过程：用户想知道几点\n八点吧'), '八点吧');
  /** 不带元信息 → 保留（正常回答里的「分析：…」不能误删） */
  const keep = '分析：这个方案有两个问题\n第一是成本';
  assert.equal(cleanOutbound(keep), keep);
});

test('不误伤：正文里的 # 号、正常括号、正常标点都不动', () => {
  const plain = '今天的 #1 号任务完成了，感觉还行（真的）。';
  assert.equal(cleanOutbound(plain), plain);
  assert.equal(cleanOutbound('  前后有空白  '), '前后有空白');
  assert.equal(cleanOutbound(''), '');
  assert.equal(cleanOutbound(null), '');
});

test('删除后不留大片空行', () => {
  const out = cleanOutbound('第一句\n\n【思考】x【/思考】\n\n\n第二句');
  assert.doesNotMatch(out, /\n{3,}/);
  assert.match(out, /第一句/);
  assert.match(out, /第二句/);
});

test('消息头回显：带 openid 的 `[昵称 (id)]` 不能发出去', () => {
  /**
   * 我们自己注入的格式就是这样一行。模型顺着续写会把整行抄进正文，
   * 发到群里的就是「[小明 (AbC…)] 你好」——噪音 + 不该公开的标识符。
   * 对照 aurabot beta 的 `8d14986`（拦下私聊回显的聊天记录）。
   */
  assert.equal(cleanOutbound('[小明 (AbCdEf0123456789XyZ)] 你好呀'), '你好呀');
  assert.equal(cleanOutbound('好的\n[小红 (AbCdEf0123456789XyZ1234)] 我也去'), '好的\n我也去');
  /** 短 id、普通括号不能误伤 */
  const keep = '（这个括号里有短 id 不算）正常一句';
  assert.equal(cleanOutbound(keep), keep);
});
