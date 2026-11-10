/**
 * QQ 工具状态与「发言方式」提示词的回归测试。
 *
 * 覆盖 2026-11-10 那次 `unknown tool` 的三处成因，以及原先埋在
 * `apply()` 闭包内、无法单测的注册层逻辑（等待 / 还原 / 落盘 / 汇总）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildOutputPrompt, createQqToolState, registeredToolNames,
} from '../src/qq-tool-state.js';

const MOUNTED = { ok: true, names: ['qq_send', 'qq_close', 'qq_send_file'] };
const ALL = new Set(['qq_send', 'qq_close', 'qq_send_file']);

/* ---------------- 提示词模板 ---------------- */

test('提示词：工具没挂上时不注入', () => {
  assert.equal(buildOutputPrompt({ mounted: null, denied: null, registeredNames: ALL }), '');
  assert.equal(buildOutputPrompt({ mounted: { ok: false }, denied: null }), '');
  assert.equal(buildOutputPrompt(), '');
});

test('提示词：报挂上却没挂 qq_send 时也不注入', () => {
  assert.equal(buildOutputPrompt({
    mounted: { ok: true, names: ['qq_close'] }, denied: null, registeredNames: null,
  }), '');
});

/**
 * 重构前的 907 段全部固定句子（取自 HEAD 版 host.js）。
 * 抽模块时最容易悄悄丢半句，这里逐条钉死；少一条就说明原有功能缺失。
 */
test('原有提示词逐句保留（重构快照）', () => {
  const text = buildOutputPrompt({
    mounted: MOUNTED, denied: null, registeredNames: ALL, maxParts: 3, ttsEnabled: true,
  });
  const original = [
    '【发言方式】',
    '你手上有这几个工具：`qq_send`（发一段话）、`qq_close`（给这段对话收尾），以及（装了的话）`qq_send_file`（发一个文件）。',
    '· 想说话就调 `qq_send`，调几次由你定（一轮最多 3 段）。**别把要发的话写进正文**。',
    '· 调过 `qq_send` 之后，你回复的正文**不会**再发出去——正文只当思考用。',
    '· 聊到自然结束、对方要走的时候，用 `qq_close` 记一句「收在哪 / 下次怎么接」，然后可以不说话。',
    '· 一个工具都不调时，正文会照常发出去（旧方式）。**不要又调工具又写正文**——那样只发工具那条，正文会被丢掉。',
    '· 想发**语音条**时，把 `<<say: 要念的内容>>` 写在**回复正文**里——',
    '· 要发文件（文档、表格、压缩包、图片都算）就调 `qq_send_file`，参数是**绝对路径**，一轮最多一个。',
  ];
  for (const line of original) {
    assert.ok(text.includes(line), `原模板句子丢失：${line.slice(0, 32)}`);
  }
});

test('提示词：正常轮讲全三个工具，段数上限与语音开关都生效', () => {
  const text = buildOutputPrompt({
    mounted: MOUNTED, denied: null, registeredNames: ALL, maxParts: 5, ttsEnabled: true,
  });
  assert.ok(text.includes('qq_send') && text.includes('qq_close') && text.includes('qq_send_file'));
  assert.ok(text.includes('一轮最多 5 段'));
  assert.ok(text.includes('<<say'), '语音开着要说明语音条只能写正文');
});

test('提示词：收走任一输出通道就整块闭嘴', () => {
  for (const denied of [['qq_send'], ['qq_close'], ['qq_send', 'qq_close']]) {
    assert.equal(buildOutputPrompt({ mounted: MOUNTED, denied, registeredNames: ALL }), '');
  }
});

test('提示词：只关「发文件」时保留分段发言，但两处文件字句都摘掉', () => {
  const text = buildOutputPrompt({
    mounted: MOUNTED, denied: ['qq_send_file'], registeredNames: ALL,
  });
  assert.ok(text.includes('一轮最多'), '分段发言要留着');
  assert.ok(!text.includes('qq_send_file'), '不许再教模型调被收走的文件工具');
});

test('提示词：注册清单缺输出通道时闭嘴，读不到清单按旧行为注入', () => {
  assert.equal(buildOutputPrompt({
    mounted: MOUNTED, denied: null, registeredNames: new Set(['qq_send']),
  }), '', '兜底判据要和逐轮 deny 一样看全部输出通道');
  assert.ok(buildOutputPrompt({ mounted: MOUNTED, denied: null, registeredNames: null })
    .includes('qq_send'));
});

test('提示词：注册清单里没有文件工具时，首行也不提它', () => {
  const text = buildOutputPrompt({
    mounted: MOUNTED, denied: null, registeredNames: new Set(['qq_send', 'qq_close']),
  });
  assert.ok(!text.includes('qq_send_file'));
  assert.ok(text.includes('qq_send'));
});

/* ---------------- schemas 读取 ---------------- */

test('注册清单：兼容三种形状，读不到返回 null', () => {
  const obj = { ctx: { tools: { schemas: () => [{ name: 'qq_send' }, { tool: { name: 'qq_close' } }] } } };
  assert.deepEqual([...registeredToolNames(obj)].sort(), ['qq_close', 'qq_send']);
  const strs = { ctx: { tools: { schemas: () => ['qq_send', 'qq_close', ''] } } };
  assert.deepEqual([...registeredToolNames(strs)].sort(), ['qq_close', 'qq_send'], '字符串数组也要认，空名丢弃');
  assert.equal(registeredToolNames({ ctx: { tools: { schemas: () => { throw new Error('x'); } } } }), null);
  assert.equal(registeredToolNames({}), null);
});

/* ---------------- 状态容器 ---------------- */

function makeState({ waitMs = 20 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-tool-state-'));
  const logs = [];
  const state = createQqToolState({ dirOf: () => dir, log: (m) => logs.push(m), waitMs });
  return { dir, logs, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('状态：按 agent 记挂载，两个会话互不串味', () => {
  const { state, cleanup } = makeState();
  try {
    const a = {}, b = {};
    state.setMounted(a, { chatId: 'A' }, { ok: true, names: ['qq_send'], mode: 'plain' });
    assert.equal(state.mountedOf(a).ok, true);
    assert.equal(state.mountedOf(b), undefined, 'B 没挂过，不能因为 A 成功就被当成挂上');
    state.setMounted(b, { chatId: 'B' }, { ok: false, reason: 'import 失败' });
    assert.equal(state.mountedOf(b).ok, false);
    assert.equal(state.mountedOf(a).ok, true, 'B 失败不许把 A 的状态改掉');
  } finally { cleanup(); }
});

test('汇总：全部会话明细都在，不再只显示最后一次挂载', () => {
  const { state, cleanup } = makeState();
  try {
    state.setMounted({}, { chatId: 'A' }, { ok: true, names: ['qq_send'] });
    state.setMounted({}, { chatId: 'B' }, { ok: false, reason: '炸了' });
    const s = state.summary();
    assert.equal(s.sessionCount, 2);
    assert.equal(s.failedCount, 1);
    assert.equal(s.ok, false, '有会话失败就不能报全绿');
    assert.ok(s.reason.includes('B'));
    assert.ok(Array.isArray(s.names), '原 /status 的 names 字段不能丢');
    assert.equal(typeof s.reason, 'string', '原 /status 的 reason 字段不能丢');
    assert.deepEqual(s.sessions.map((x) => x.chatId).sort(), ['A', 'B']);
  } finally { cleanup(); }
});

test('落盘：顶层兼容字段是最后一次，sessions 数组保留全部会话', () => {
  const { dir, state, cleanup } = makeState();
  try {
    state.setMounted({}, { chatId: 'A' }, { ok: true, names: ['qq_send'] });
    state.setMounted({}, { chatId: 'B' }, { ok: true, names: ['qq_send', 'qq_close'] });
    const j = JSON.parse(readFileSync(join(dir, 'tool-state.json'), 'utf8'));
    assert.equal(j.chatId, 'B');
    assert.equal(j.ok, true);
    assert.deepEqual(j.names, ['qq_send', 'qq_close'], '排查脚本读的 names 要保留');
    assert.equal(typeof j.mode, 'string');
    assert.equal(typeof j.reason, 'string');
    assert.equal(typeof j.at, 'number');
    assert.equal(j.sessions.length, 2);
    assert.ok(j.sessions.some((x) => x.chatId === 'A'));
  } finally { cleanup(); }
});

test('落盘：会话数超过 50 时只保留最近 50 个', () => {
  const { dir, state, cleanup } = makeState();
  try {
    for (let i = 0; i < 60; i += 1) {
      state.setMounted({}, { chatId: `chat-${i}` }, { ok: true, names: [] });
    }
    const j = JSON.parse(readFileSync(join(dir, 'tool-state.json'), 'utf8'));
    assert.equal(j.sessions.length, 50);
    assert.equal(j.chatId, 'chat-59');
    const ids = j.sessions.map((x) => x.chatId);
    assert.ok(ids.includes('chat-59'), '刚写入的当前会话必须保留');
    assert.ok(ids.includes('chat-10'), '最近 50 个要保留');
    assert.ok(!ids.includes('chat-0'), '最旧的应被淘汰');
    assert.equal(j.sessions[0].chatId, 'chat-59', '明细要最新在前');
  } finally { cleanup(); }
});

test('落盘：目录不可写时记日志而不抛异常', () => {
  const logs = [];
  const state = createQqToolState({ dirOf: () => '/definitely/not/here', log: (m) => logs.push(m) });
  assert.doesNotThrow(() => state.setMounted({}, { chatId: 'A' }, { ok: true, names: [] }));
  assert.ok(logs.some((m) => m.includes('写盘失败')));
});

test('轮末还原：撤销成功后清状态，撤销抛异常时保留状态在闭嘴侧', () => {
  const { state, logs, cleanup } = makeState();
  try {
    const agent = {};
    state.setDenied(agent, ['qq_send']);
    assert.ok(state.deniedOf(agent).has('qq_send'));
    state.wrapRestore(agent, () => {})();
    assert.equal(state.deniedOf(agent), undefined);

    state.setDenied(agent, ['qq_send']);
    const bad = state.wrapRestore(agent, () => { throw new Error('撤销失败'); });
    assert.throws(() => bad(), /撤销失败/);
    assert.ok(state.deniedOf(agent).has('qq_send'), '掩码可能还在，状态必须留着');
    assert.ok(logs.some((m) => m.includes('还原工具权限失败')));
  } finally { cleanup(); }
});

test('等待：挂载完成就立即返回；超时会记日志且不阻塞', async () => {
  const { state, logs, cleanup } = makeState({ waitMs: 15 });
  try {
    const fast = {}, slow = {};
    state.setReady(fast, Promise.resolve());
    state.setReady(slow, new Promise(() => {}));
    await state.waitFor(fast);
    assert.equal(logs.length, 0, '正常完成不该记警告');
    await state.waitFor(slow);
    assert.ok(logs.some((m) => m.includes('超过 15 毫秒')), '超时必须留痕');
  } finally { cleanup(); }
});

test('等待：没有挂载 Promise 时直接返回', async () => {
  const { state, cleanup } = makeState();
  try {
    await state.waitFor({});
  } finally { cleanup(); }
});

test('等待：挂载 Promise 失败时不把整轮带崩', async () => {
  const { state, cleanup } = makeState({ waitMs: 20 });
  try {
    const agent = {};
    state.setReady(agent, Promise.reject(new Error('import 炸了')));
    await assert.doesNotReject(() => state.waitFor(agent));
  } finally { cleanup(); }
});
