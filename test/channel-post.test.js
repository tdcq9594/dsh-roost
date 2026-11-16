/**
 * 频道发帖：排期 / 清洗 / 兜底标题 / 体检状态机 / 试运行 / 重试 / 对账
 *
 * 分两组：
 *   A. 从 aurabot 空间日记搬来的纯函数（**重测**，因为入参形状被我们改过）
 *   B. 本模块新增的逻辑（记账、重试、对账口径、素材来源）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  POST_DEFAULTS,
  planDiaryTimes,
  windowMinutes,
  normalizePostCfg,
  cleanDraft,
  pickTitle,
  parseDraft,
  postSteps,
  humanError,
  pickErrorCode,
  guide,
  whoOf,
  shareUrlOf,
  ERROR_HINTS,
  createPostStore,
  createChannelPost,
  asHHMM,
  dayKey,
} from '../src/channel-post.js';
import { DEFAULTS } from '../src/config.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'roost-post-'));
const at = (h, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

/* ================================================================== *
 * A. 搬来的纯函数
 * ================================================================== */

test('windowMinutes：普通窗口、跨天窗口、全天', () => {
  assert.equal(windowMinutes(600, 1410), 810);        // 10:00–23:30
  assert.equal(windowMinutes(1320, 120), 240);        // 22:00–02:00 跨天
  assert.equal(windowMinutes(0, 0), 1440);            // from === to 视为全天
  assert.equal(windowMinutes(540, 540), 1440);        // 9:00–9:00 也是全天
});

test('planDiaryTimes：数量、窗口内、两两间隔、跨天', () => {
  const times = planDiaryTimes({ timesPerDay: 3, windowStart: '10:00', windowEnd: '23:30', minGapMinutes: 180 });
  assert.equal(times.length, 3);
  for (const m of times) {
    assert.ok(m >= 600 && m < 1410, `${asHHMM(m)} 落在窗口外`);
  }
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= 180, '两篇间隔不足 180 分钟');
  }

  // 跨天窗口：排出来的时刻可以落在 22:00–24:00 或 00:00–02:00
  const cross = planDiaryTimes({ timesPerDay: 2, windowStart: '22:00', windowEnd: '02:00', minGapMinutes: 60 });
  assert.equal(cross.length, 2);
  assert.ok(cross.every((m) => m >= 1320 || m < 120), `跨天窗口排出了 ${cross.map(asHHMM).join(',')}`);
});

test('planDiaryTimes：timesPerDay=0 不排；窗口为 0 分钟退回全天', () => {
  assert.deepEqual(planDiaryTimes({ timesPerDay: 0, windowStart: '10:00', windowEnd: '12:00', minGapMinutes: 0 }), []);
  // from === to 是全天而不是"空窗口"：这是与 proactive-policy 统一的约定
  const allDay = planDiaryTimes({ timesPerDay: 1, windowStart: '09:00', windowEnd: '09:00', minGapMinutes: 0 });
  assert.equal(allDay.length, 1);
});

test('planDiaryTimes：随机数恒定也会被均分兜底补满（绝不返回少于 n 个）', () => {
  const times = planDiaryTimes(
    { timesPerDay: 2, windowStart: '10:00', windowEnd: '23:30', minGapMinutes: 180 },
    () => 0.5,
  );
  assert.equal(times.length, 2, '排不开也必须给满，否则当天会少发一篇');
  assert.ok(times[1] - times[0] >= 180);
});

test('cleanDraft：去分隔符、去标签、去引号、去 Markdown 标题前缀', () => {
  assert.equal(cleanDraft('|||今天 好<voice> 累|||'), '今天 好 累');
  assert.equal(cleanDraft('「今天风很大」'), '今天风很大');
  assert.equal(cleanDraft('## 标题\n正文'), '标题\n正文');
  assert.equal(cleanDraft('> 引用\n正文'), '引用\n正文');
  assert.equal(cleanDraft('   '), '');
});

test('pickTitle：取首句、去尾标点、限长；空正文用日期兜底', () => {
  assert.equal(pickTitle('今天风很大，吹得人直想回家。后面还有'), '今天风很大，吹得人直想回家');
  assert.equal(pickTitle('一二三四五六七八九十一二三四五六七八九十太多字了'), '一二三四五六七八九十一二三四五六七八九十');
  /**
   * **用固定日期，不要用 `at()`**：那个辅助函数的参数是「时、分」，
   * `at(11, 17)` 造的是"今天 11:17"，配上断言 `11月17日` 就成了**只在 11 月 17 日通过**的测试。
   * 本地正好是 11-17 所以一直是绿的，CI 跑在 UTC 11-16 → 红（2026-11-17 发 1.3.6 踩到）。
   */
  const fixed = new Date(2026, 10, 17, 11, 17, 0, 0).getTime();
  assert.equal(pickTitle('', fixed), '11月17日 随手记');
});

test('提示词：不要求贴频道话题（这是个人表达，不是频道日报）', async () => {
  /**
   * 主人 2026-11-17 纠正：发帖是**代替 QQ 空间**的，写的是她自己。
   * 原来提示词第二行写「今天在频道里聊到的」，模型就写成"群里今天聊了啥"，
   * 读起来像频道运营日报。这条把"不许回到那个写法"钉住。
   */
  let captured = ''
  const h = makePost({
    ledgerRecent: () => [{ who: '某人', text: '今天吃了面', at: Date.now() }],
    systemTurn: async (_name, prompt) => {
      captured = prompt
      return '{"title":"甲","text":"乙"}'
    },
  })
  await h.post.preview()
  assert.doesNotMatch(captured, /频道/, '提示词里不该出现"频道里的内容"这种要求')
  assert.match(captured, /你自己/, '要明确写"你自己"')
  /** 措辞对齐 aurabot：「今天你在 QQ 上的聊天片段」，并且明确"不用总结" */
  assert.match(captured, /QQ 上的聊天片段/, '素材的措辞要像 aurabot 那样说"QQ 上"，不要限定渠道')
  assert.match(captured, /不用总结/, '要明确告诉模型别把聊天写成总结')

  /** 没素材时也不能暗示"频道里没什么可写的" */
  let empty = ''
  const h2 = makePost({
    ledgerRecent: () => [],
    systemTurn: async (_name, prompt) => {
      empty = prompt
      return '{"title":"甲","text":"乙"}'
    },
  })
  await h2.post.preview()
  assert.doesNotMatch(empty, /频道/)
})

test('parseDraft：模型在 JSON 前后加解释 / 给数组，也要能解出来', () => {
  /**
   * 实机就是这样：模型回「好的，这是今天的：{…} 希望你喜欢」，
   * 旧版整段 JSON.parse 直接判死，用户在面板上看到一句他无法处理的技术错误。
   */
  assert.deepEqual(
    parseDraft('好的，这是今天的：{"title":"甲","text":"乙"} 希望你喜欢'),
    { title: '甲', text: '乙' },
  );
  assert.deepEqual(parseDraft('[{"title":"甲","text":"乙"}]'), { title: '甲', text: '乙' });
  assert.deepEqual(parseDraft('```json\n{"title":"甲","text":"乙"}\n```'), { title: '甲', text: '乙' });

  /**
   * **纯文本必须能用**：2026-11-17 实机，模型连续两次都不给 JSON，
   * 功能等于不可用。格式要求要按模型能做到的来，不是按实现的方便。
   */
  const plain = parseDraft('今天风很大，吹得人直想回家。');
  assert.match(plain.text, /今天风很大/);
  assert.ok(plain.title.length > 0 && plain.title.length <= 20, '标题从首句取，且不超过 20 字');

  /** 但半截 JSON 必须拒：落进纯文本兜底会把 `{"title":…` 原文发到公开版块 */
  assert.throws(() => parseDraft('{"title":"甲","text":"乙"'), /JSON/);
});

test('parseDraft：标题 / --- / 正文 的格式（现在的主动格式）', () => {
  const r = parseDraft('风很大\n---\n今天风很大，吹得人直想回家。');
  assert.equal(r.title, '风很大');
  assert.equal(r.text, '今天风很大，吹得人直想回家。');

  /** 模型爱在标题前加「好的，」，要清掉（正文里的"好的"不动） */
  const withPre = parseDraft('好的，风很大\n---\n今天风很大。');
  assert.equal(withPre.title, '风很大');

  /** 标题带引号/书名号也清掉 */
  assert.equal(parseDraft('「风很大」\n---\n今天风很大。').title, '风很大');
});

test('parseDraft：JSON / 围栏 / 空正文 / 超长 / 缺标题', () => {
  assert.deepEqual(parseDraft('{"title":"风很大","text":"今天风很大。"}'), { title: '风很大', text: '今天风很大。' });

  const fenced = parseDraft('```json\n{"title":"甲","text":"乙"}\n```');
  assert.equal(fenced.title, '甲');

  assert.throws(() => parseDraft('{"title":"甲","text":"  "}'), /正文是空的/);
  assert.throws(() => parseDraft(`{"title":"甲","text":"${'字'.repeat(40)}"}`, { maxChars: 10 }), /超过/);

  // 模型漏标题：用正文首句兜底，标题仍然有（否则官方 503005）
  const noTitle = parseDraft('{"text":"今天风很大，吹得人直想回家。"}');
  assert.equal(noTitle.title, '今天风很大，吹得人直想回家');
});

/* ================================================================== *
 * B. 配置 / 体检
 * ================================================================== */

test('normalizePostCfg：夹紧数值、坏 id 清空、format 只认 1/3、max 不小于 min', () => {
  const c = normalizePostCfg({ timesPerDay: 99, minGapMinutes: -5, channelId: 'abc', guildId: '12x', format: 2, maxChars: 10, minChars: 500 });
  assert.equal(c.timesPerDay, 24);
  assert.equal(c.minGapMinutes, 0);
  assert.equal(c.channelId, '', '坏 channelId 必须清空，否则只会得到 10003 让用户猜');
  assert.equal(c.guildId, '');
  assert.equal(c.format, 3, 'HTML/JSON 不开放');
  assert.equal(c.maxChars, 500, 'max 不能小于 min');
  assert.equal(c.minChars, 500);

  assert.equal(normalizePostCfg({ format: 1 }).format, 1);
  assert.equal(normalizePostCfg({}).dryRun, true, '默认试运行');
  assert.equal(normalizePostCfg({}).askFirst, true);
});

test('channelPost 必须进 DEFAULTS：pruneTo 之后还在（别重犯 bySender 那次）', () => {
  assert.deepEqual(DEFAULTS.channelPost, { ...POST_DEFAULTS });
  for (const k of Object.keys(POST_DEFAULTS)) {
    assert.ok(k in DEFAULTS.channelPost, `DEFAULTS 缺键 ${k}，会被 pruneTo 静默裁掉`);
  }
});

test('postSteps：四条灯的状态与 ready', () => {
  const ready = postSteps(
    { guildId: '111', channelId: '222', verifiedAt: 1 },
    { guildEnabled: true, inGuild: true, forumChannels: [{ id: '222' }], perm: true },
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.blocked, false);

  // 没探测过权限：不算 fail，只是 todo
  const unknown = postSteps({ guildId: '111', channelId: '', verifiedAt: 0 }, { guildEnabled: true, inGuild: true, forumChannels: [], perm: null });
  assert.equal(unknown.blocked, false);
  assert.equal(unknown.ready, false);

  // 权限被拒：blocked
  const denied = postSteps({ guildId: '111', channelId: '', verifiedAt: 0 }, { guildEnabled: true, inGuild: true, forumChannels: null, perm: false, permError: { code: '11253' } });
  assert.equal(denied.blocked, true);
  assert.match(denied.steps.find((s) => s.id === 'perm').detail, /论坛/);

  // 选中的版块消失了：fail
  const gone = postSteps({ guildId: '111', channelId: '999', verifiedAt: 0 }, { guildEnabled: true, inGuild: true, forumChannels: [{ id: '222' }], perm: true });
  assert.equal(gone.steps.find((s) => s.id === 'channel').state, 'fail');
});

test('postSteps：没选频道 ≠ 机器人被移出频道（两条的下一步完全不同）', () => {
  /**
   * 第 1 盏灯只管总开关；"选频道"归第 3 盏。
   * 曾经把它们混在一起，主人 `guild.enabled=true` 却看到"第一步没亮"，
   * 反复确认开关都没错——那是判据的错，不是他的错。
   */
  const on = postSteps({ guildId: '', channelId: '' }, { guildEnabled: true, inGuild: null, forumChannels: [], perm: null });
  assert.equal(on.steps.find((s) => s.id === 'guild').state, 'ok', '总开关开着，第 1 盏就该绿');

  const noGuild = on.steps.find((s) => s.id === 'channel');
  assert.equal(noGuild.state, 'todo');
  assert.match(noGuild.detail, /还没选频道/);
  assert.doesNotMatch(noGuild.detail, /还没进任何频道/);

  const lost = postSteps({ guildId: '111', channelId: '' }, { guildEnabled: true, inGuild: false, forumChannels: null, perm: null });
  const l = lost.steps.find((s) => s.id === 'channel');
  assert.equal(l.state, 'fail');
  assert.match(l.detail, /被移出/);
});

test('postSteps：总开关关着时第 1 盏必须是待办（别被其它项掩盖）', () => {
  const off = postSteps({ guildId: '111', channelId: '222' }, { guildEnabled: false, inGuild: true, forumChannels: [{ id: '222' }], perm: true });
  const g = off.steps.find((s) => s.id === 'guild');
  assert.equal(g.state, 'todo');
  assert.equal(g.jump, 'ch-home');
});

test('humanError：已知码给人话，未知码原样显示不编解释', () => {
  const p = humanError('11253');
  assert.match(p.title, /论坛/);
  assert.ok(p.todo.some((s) => /移出频道/.test(s)), '必须提"移出重加"这一步');

  const unknown = humanError('123456', 'some raw message');
  assert.match(unknown.title, /没见过的错误/);
  assert.ok(unknown.todo.some((s) => s.includes('123456')));
});

/* ---------------- 「链路不通时能不能正确指引用户」 ---------------- */

test('pickErrorCode：优先 qqCode，其次 message 里的已知码', () => {
  // 1. 框架 2026-11-17 起透传的官方业务码
  assert.equal(pickErrorCode({ qqCode: 11253, code: 'INTERNAL', message: 'HTTP 400 ...' }), '11253');
  // 2. 老框架：码只出现在消息体里
  assert.equal(
    pickErrorCode({ code: 'INTERNAL', message: 'HTTP 400 PUT /channels/9/threads: 11253 appid no permission' }),
    '11253',
  );
  // 3. 认不出就回原始 code，别硬猜
  assert.equal(pickErrorCode({ code: 'INTERNAL', message: 'boom' }), 'INTERNAL');
  // 4. **不能把路径里的频道 id 当错误码**（503017 之类的 6 位 id 最容易误命中）
  assert.equal(pickErrorCode({ message: 'PUT /channels/2224603/threads failed' }), '');
  assert.equal(pickErrorCode({ message: 'channel 503017 不存在' }), '503017', '真的是码时仍要认出来');
});

test('humanError：say 是一句可以直接转述的话，且带"移出频道再重新添加"', () => {
  const h = humanError(11253);
  assert.ok(h.say.includes(h.title), 'say 以标题开头');
  assert.ok(h.say.includes('移出频道'), '最关键的一步必须在 say 里');
  assert.ok(/1\)/.test(h.say) && /2\)/.test(h.say), '步骤要有编号，模型才好照读');

  const unknown = humanError('999999', 'raw boom');
  assert.match(unknown.say, /不要自己猜/);
  assert.ok(unknown.say.includes('999999'), '未知码要把原文带上');
});

test('guide：前置条件不满足时也带 say（模型照读就行）', () => {
  const g = guide('还没选发帖版块', ['点面板「发帖」→ 03 卡选一个']);
  assert.equal(g.ok, false);
  assert.equal(g.message, '还没选发帖版块');
  assert.deepEqual(g.todo, ['点面板「发帖」→ 03 卡选一个']);
  assert.ok(g.say.includes('请告诉主人'));
  assert.ok(g.say.includes('03 卡'));
});

/* ================================================================== *
 * C. 落盘
 * ================================================================== */

test('createPostStore：读空、写、原子替换、坏文件降级不抛', () => {
  const dir = tmp();
  const store = createPostStore({ dirOf: () => dir, log: () => {} });
  assert.deepEqual(store.read().history, []);

  store.save({ plan: { day: '2026-11-17', times: [600], done: [], retry: {} }, history: [{ at: 1, title: 'a' }] });
  assert.equal(store.read().history.length, 1);

  writeFileSync(store.file(), '{坏掉的 json');
  const fallback = store.read();
  assert.deepEqual(fallback.history, [], '读坏了要回空记录，不能让发帖功能整个瘫掉');
  assert.equal(fallback.plan.day, '');
});

test('createPostStore：历史最多 100 条', () => {
  const dir = tmp();
  const store = createPostStore({ dirOf: () => dir });
  store.save({ plan: { day: '', times: [], done: [], retry: {} }, history: Array.from({ length: 150 }, (_, i) => ({ at: i })) });
  const saved = JSON.parse(readFileSync(store.file(), 'utf8'));
  assert.equal(saved.history.length, 100);
});

/* ================================================================== *
 * D. 主流程（假接口）
 * ================================================================== */

function makePost(over = {}) {
  const dir = tmp();
  const cfg = {
    guild: { enabled: true },
    channelPost: normalizePostCfg({
      enabled: true, guildId: '111', channelId: '222', dryRun: false, timesPerDay: 1,
      windowStart: '00:00', windowEnd: '23:59', ...over.cfg,
    }),
  };
  const calls = [];
  const memos = [];
  let clock = at(23, 59);
  const post = createChannelPost({
    cfgOf: () => cfg,
    patchCfg: (p) => { Object.assign(cfg.channelPost, p.channelPost || {}); },
    dirOf: () => dir,
    now: () => clock,
    callQq: async (m, a) => {
      calls.push([m, a]);
      if (over.callQq) { const r = await over.callQq(m, a); if (r !== undefined) return r; }
      if (m === 'putThread') return { task_id: 'T1', create_time: '1645503180' };
      if (m === 'getThreadsList') return { threads: [], is_finish: 1 };
      if (m === 'getGuildChannels') return [{ id: '222', type: 10007, name: '日记本' }, { id: '333', type: 0, name: '闲聊' }];
      throw new Error('unexpected ' + m);
    },
    systemTurn: over.systemTurn || (async () => '{"title":"风很大","text":"今天风很大。"}'),
    ledgerRecent: over.ledgerRecent || (() => [{ at: clock - 60_000, who: '主人', text: '今天好热', kind: 'user' }]),
    journalAdd: (r) => memos.push(r),
    log: () => {},
  });
  return { post, cfg, calls, memos, dir, advance: (ms) => { clock += ms; }, setClock: (v) => { clock = v; }, getClock: () => clock };
}

test('publish：总开关关着 / 没选版块 / 试运行 都不调接口', async () => {
  const a = makePost({ cfg: { enabled: false } });
  assert.equal((await a.post.publish({ title: 't', text: 'x' })).ok, false);
  assert.equal(a.calls.length, 0);

  const b = makePost({ cfg: { channelId: '' } });
  assert.equal((await b.post.publish({ title: 't', text: 'x' })).ok, false);
  assert.equal(b.calls.length, 0);

  const c = makePost({ cfg: { dryRun: true } });
  const r = await c.post.publish({ title: 't', text: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(c.calls.length, 0, '试运行不能碰发布接口');
});

test('sendDraft：真发走 putThread(args 数组)、记账 pending、写记忆、verifiedAt 落配置', async () => {
  const { post, cfg, calls, memos } = makePost();
  const r = await post.sendDraft({ title: '风很大', text: '今天风很大。', force: true });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'pending');

  const put = calls.find((c) => c[0] === 'putThread');
  assert.ok(put, '必须调 putThread');
  assert.ok(Array.isArray(put[1]), 'qq.call 只认 args 数组（传 params 对象会静默丢参）');
  assert.equal(put[1][0], '222');
  assert.equal(put[1][1].title, '风很大');
  assert.equal(put[1][1].format, 3);

  const st = post.state();
  assert.equal(st.history[0].state, 'pending');
  assert.equal(st.history[0].taskId, 'T1');
  assert.equal(st.today, 1);
  assert.ok(cfg.channelPost.verifiedAt > 0, 'verifiedAt 应在拿到 task_id 时写');
  assert.equal(memos.length, 1, '真发成功要写一条记忆');
  assert.match(memos[0].text, /我在频道里写过/);
});

test('sendDraft：失败要记账 failed 且不写记忆', async () => {
  const { post, memos } = makePost({
    callQq: async (m) => { if (m === 'putThread') { const e = new Error('boom'); e.code = '503004'; throw e; } return undefined; },
  });
  const r = await post.sendDraft({ title: 't', text: 'x', force: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /频/);
  assert.equal(memos.length, 0);
  assert.equal(post.state().history[0].state, 'failed');
});

test('material：只取文字子频道、按时间合并、素材为空返回空串', async () => {
  const seen = [];
  const { post } = makePost({
    ledgerRecent: ({ chatId }) => { seen.push(chatId); return [{ at: 1000, who: '甲', text: '早', kind: 'user' }]; },
  });
  const text = await post.preview().then(() => seen);
  assert.deepEqual(seen, ['333'], '只该查 type=0 的子频道，论坛版块里没有聊天');

  const empty = makePost({ ledgerRecent: () => [] });
  const r = await empty.post.preview();
  assert.equal(r.ok, true);
  assert.equal(r.excerptLines, 0);
});

test('write：模型给出半截 JSON 时不发，但记一条 failed（面板才看得见为什么没写出来）', async () => {
  /** 半截 JSON 是**必须失败**的那种：落进纯文本兜底会把 `{"title":…` 发到公开版块 */
  const { post, calls } = makePost({ systemTurn: async () => '{"title":"甲","text":"乙"' });
  const r = await post.write();
  assert.equal(r.ok, false);
  /** 给人看的话不能是技术错误：他改不了模型输出 */
  assert.match(r.message, /没写出来/);
  assert.doesNotMatch(r.message, /JSON/, '技术细节不该甩给用户');
  assert.equal(calls.filter((c) => c[0] === 'putThread').length, 0);

  const row = post.state().history[0];
  assert.equal(row.state, 'failed');
  /** 定时的这一篇失败时没人在场，`lastError` 是面板唯一的提示来源 */
  assert.equal(post.state().lastError?.message, row.error);
});

test('write：模型第一次写坏了，会自动再要一次并成功', async () => {
  /**
   * 2026-11-17 实机：模型连续两次都不给 JSON，功能等于不可用。现在自动重试一次，
   * 而且第二次用的是更简单的格式（标题 + --- + 正文）。
   */
  let n = 0;
  const h = makePost({
    systemTurn: async () => {
      n += 1;
      return n === 1 ? '{"title":"风很大","text":"今天' : '风很大\n---\n今天风很大，吹得人直想回家。';
    },
  });
  const r = await h.post.write({ force: true });
  assert.equal(r.ok, true);
  assert.equal(n, 2, '应该恰好重试一次');
  assert.equal(h.calls.filter((c) => c[0] === 'putThread').length, 1, '只发一篇，不能把失败的也发出去');
});

test('write：重试也失败就停手（不要无限重试烧钱）', async () => {
  let n = 0;
  const h = makePost({ systemTurn: async () => { n += 1; return '{"title":"甲","text":"乙"'; } });
  const r = await h.post.write({ force: true });
  assert.equal(r.ok, false);
  assert.equal(n, 2, '只重试一次');
  assert.equal(h.calls.filter((c) => c[0] === 'putThread').length, 0);
});

test('state.lastError：比最近一次成功更晚的失败才亮；成功后自动熄', async () => {
  let fail = true;
  const h = makePost({ systemTurn: async () => { if (fail) throw new Error('模型挂了'); return '{"title":"甲","text":"乙"}'; } });
  await h.post.write();
  assert.ok(h.post.state().lastError, '失败要亮');

  fail = false;
  await h.post.write({ force: true });
  assert.equal(h.post.state().lastError, null, '之后成功了一篇，就不该继续亮老失败');
});

test('preview：只生成不发布、不记账、不耗次数', async () => {
  const { post, calls } = makePost();
  const r = await post.preview();
  assert.equal(r.ok, true);
  assert.equal(r.preview, true);
  assert.equal(r.title, '风很大');
  assert.equal(calls.filter((c) => c[0] === 'putThread').length, 0);
  assert.equal(post.state().history.length, 0);
  assert.equal(post.state().today, 0);
});

test('tick：首次排期落盘；到期发一篇；成功后标 done 不再发', async () => {
  const { post, calls } = makePost();
  await post.tick();
  const st = post.state();
  assert.equal(st.plan.times.length, 1);
  assert.equal(st.plan.done.length, 1);
  assert.equal(calls.filter((c) => c[0] === 'putThread').length, 1);

  await post.tick();
  assert.equal(calls.filter((c) => c[0] === 'putThread').length, 1, '同一档不能发两次');
});

test('tick：失败按 2 分钟排重试，没到点不重试', async () => {
  let fail = true;
  // 窗口卡在 08:00–08:01 且时钟从 09:00 起：既保证"一定到期"，又保证后续 advance
  // 不会跨天（跨天会触发重新排期，把 retry 清掉，测的就不是重试了）
  const h = makePost({
    cfg: { windowStart: '08:00', windowEnd: '08:01' },
    systemTurn: async () => { if (fail) throw new Error('模型挂了'); return '{"title":"甲","text":"乙"}'; },
  });
  h.setClock(at(9, 0));
  await h.post.tick();
  const plan1 = h.post.state().plan;
  assert.equal(plan1.done.length, 0, '失败不能标 done');
  const due = plan1.times[0];
  assert.ok(plan1.retry[due], '要排重试');
  assert.equal(plan1.retry[due].count, 1);

  // 1 分钟后重试还没到点
  h.advance(60_000);
  await h.post.tick();
  assert.equal(h.post.state().plan.retry[due].count, 1, '没到 2 分钟不该重试');

  // 过 2 分钟重试一次，这次成功
  fail = false;
  h.advance(2 * 60_000);
  await h.post.tick();
  const plan2 = h.post.state().plan;
  assert.equal(plan2.done.length, 1);
  assert.equal(plan2.retry[due], undefined);
});

test('tick：连续失败 3 次后放弃这一档（第 4 次不再排重试）', async () => {
  const h = makePost({
    cfg: { windowStart: '08:00', windowEnd: '08:01' },
    systemTurn: async () => { throw new Error('一直挂'); },
  });
  h.setClock(at(9, 0));
  await h.post.tick();                                   // 第 1 次 → 重试 2 分钟
  h.advance(2 * 60_000); await h.post.tick();            // 第 2 次 → 5 分钟
  h.advance(5 * 60_000); await h.post.tick();            // 第 3 次 → 15 分钟
  h.advance(15 * 60_000); await h.post.tick();           // 第 4 次 → 放弃
  const plan = h.post.state().plan;
  assert.equal(plan.done.length, 1, '放弃时把这一档标 done');
  assert.deepEqual(plan.retry, {});
});

test('sync：按标题 + 时间窗认领成 live；时间差超过 10 分钟不认领', async () => {
  const at0 = at(12, 0);
  const iso = (ms) => new Date(ms).toISOString();

  // 造一个带列表的实例，时间对齐
  const h2 = makePost({
    callQq: async (m, a) => {
      if (m === 'getThreadsList') {
        return { threads: [{ thread_info: { title: '风很大', date_time: iso(at0), thread_id: 'TH1' } }], is_finish: 1 };
      }
      if (m === 'putThread') return { task_id: 'T1' };
      return [{ id: '222', type: 10007, name: '日记本' }];
    },
  });
  h2.setClock(at0);
  await h2.post.sendDraft({ title: '风很大', text: '正文', force: true });
  const r = await h2.post.sync();
  assert.equal(r.ok, true);
  assert.equal(r.changed, 1);
  assert.equal(h2.post.state().history[0].state, 'live');
  assert.equal(h2.post.state().history[0].threadId, 'TH1');

  // 同一标题但差 30 分钟：不能认领（标题会撞，必须靠时间区分）
  const h3 = makePost({
    callQq: async (m) => {
      if (m === 'getThreadsList') {
        return { threads: [{ thread_info: { title: '风很大', date_time: iso(at0 - 30 * 60_000), thread_id: 'TH9' } }] };
      }
      if (m === 'putThread') return { task_id: 'T1' };
      return [{ id: '222', type: 10007 }];
    },
  });
  h3.setClock(at0);
  await h3.post.sendDraft({ title: '风很大', text: '正文', force: true });
  const r3 = await h3.post.sync();
  assert.equal(r3.changed, 0);
  assert.equal(h3.post.state().history[0].state, 'pending');
});

test('sync：列表格式不完整时不动任何记录', async () => {
  const h = makePost({
    callQq: async (m) => {
      if (m === 'getThreadsList') return { nope: true };   // 缺 threads
      if (m === 'putThread') return { task_id: 'T1' };
      return [{ id: '222', type: 10007 }];
    },
  });
  await h.post.sendDraft({ title: 't', text: 'x', force: true });
  const r = await h.post.sync();
  assert.equal(r.ok, false);
  assert.match(r.warning, /格式不完整/);
  assert.equal(h.post.state().history[0].state, 'pending', '读不全就绝不判死');
});

test('sync：pending 超过 30 分钟转 stale（含义是"没看到"，不是失败）', async () => {
  const h = makePost();
  await h.post.sendDraft({ title: '风很大', text: '正文', force: true });
  h.advance(31 * 60_000);
  const r = await h.post.sync();
  assert.equal(r.ok, true);
  assert.equal(h.post.state().history[0].state, 'stale');
});

test('diagnose：权限被拒时 perm=false 并带上错误码；版块列表只留论坛', async () => {
  const h = makePost({
    callQq: async (m) => {
      if (m === 'getGuildChannels') return [{ id: '222', type: 10007, name: '日记本' }, { id: '333', type: 0 }];
      if (m === 'getThreadsList') { const e = new Error('no perm'); e.code = '11253'; throw e; }
      return undefined;
    },
  });
  const d = await h.post.diagnose();
  assert.equal(d.ok, true);
  assert.equal(d.forumChannels.length, 1);
  assert.equal(d.forumChannels[0].id, '222');
  const perm = d.steps.find((s) => s.id === 'perm');
  assert.equal(perm.state, 'fail');
  assert.match(perm.detail, /论坛/);
});

test('addDraft：只记待发，不调接口、不写记忆，也不计入"今天发了几篇"', () => {
  const { post, calls, memos } = makePost();
  const r = post.addDraft({ title: '风很大', text: '今天风很大。' });
  assert.equal(r.ok, true);
  assert.equal(r.title, '风很大');
  assert.equal(calls.length, 0, '待发不能碰任何接口');
  assert.equal(memos.length, 0, '还没发出去，不该写"我写过"');

  const row = post.state().history[0];
  assert.equal(row.state, 'draft');
  assert.equal(row.source, 'tool');
  assert.equal(post.state().today, 0);
});

test('addDraft：空正文拒绝；缺标题用正文首句兜底', () => {
  const { post } = makePost();
  assert.equal(post.addDraft({ title: 'x', text: '   ' }).ok, false);
  const r = post.addDraft({ text: '今天风很大，吹得人直想回家。' });
  assert.equal(r.ok, true);
  assert.match(r.title, /今天风很大/);
});

test('tick：她自己已经发满 today 时，排期这一档直接跳过（总量不超 timesPerDay）', async () => {
  const h = makePost({ cfg: { windowStart: '08:00', windowEnd: '08:01', timesPerDay: 1 } });
  h.setClock(at(9, 0));
  // 先"她自己"发一篇：这一篇同样占今天的额度
  await h.post.sendDraft({ title: '甲', text: '乙', force: true });
  assert.equal(h.post.state().today, 1);

  await h.post.tick();
  assert.equal(h.calls.filter((c) => c[0] === 'putThread').length, 1, '已经发满就不该再补一篇');
  assert.equal(h.post.state().plan.done.length, 1, '这一档要标 done，否则每分钟都会再试');
});

test('state.plan：跨零点后不显示昨天的排期', async () => {
  const h = makePost({ cfg: { windowStart: '00:00', windowEnd: '23:59' } });
  await h.post.tick();                       // 今天排期落盘
  assert.ok(h.post.state().plan.times.length > 0);

  h.advance(26 * 3600_000);                  // 跨到明天（此时还没 tick）
  const st = h.post.state();
  assert.deepEqual(st.plan.times, [], '新的一天还没排期，别把昨天那张表给面板');
  assert.equal(st.plan.day, dayKey(new Date(h.getClock())));
});

test('postSteps：配置齐了但没试发过 → ready 为真、verified 为假（不能报"还差一项"）', () => {
  /**
   * 这条修的是一个真实的困惑：配置全对、只是还没点过「真发」，体检却永远显示
   * 「还差 1 项」，用户以为哪里没配好，翻半天找不到问题。
   * **能不能发只取决于配置，不取决于"有没有点过按钮"**。
   */
  const r = postSteps(
    { guildId: '111', channelId: '222', verifiedAt: 0 },
    { guildEnabled: true, inGuild: true, forumChannels: [{ id: '222' }], perm: true },
  );
  assert.equal(r.ready, true);
  assert.equal(r.verified, false);
  assert.equal(r.pending, 0, '「发过一篇」不算未通过项');
  assert.equal(r.steps.find((s) => s.id === 'sent').state, 'info', '它是中性提示，不是待办');
});

test('postSteps：失败项带分步 todo，总开关关着时给「去频道总览」的跳转', () => {
  const off = postSteps({ guildId: '111', channelId: '' }, { guildEnabled: false, inGuild: null, forumChannels: null, perm: null });
  const g = off.steps.find((s) => s.id === 'guild');
  assert.equal(g.jump, 'ch-home', '要让面板能一键跳到频道总览');
  assert.match(g.detail, /总开关与粒度/, '要写到具体卡名，用户才知道在哪');
  assert.match(g.detail, /启用频道/, '要写到具体开关名');

  const denied = postSteps(
    { guildId: '111', channelId: '' },
    { guildEnabled: true, inGuild: true, forumChannels: null, perm: false, permError: { code: '11253' } },
  );
  const p = denied.steps.find((s) => s.id === 'perm');
  assert.ok(Array.isArray(p.todo) && p.todo.length >= 3, '权限失败必须把三步走带出来，不能只给一句标题');
  assert.ok(p.todo.some((x) => /移出频道/.test(x)), '最容易漏的那步要在里面');

  /** 每一项都得说清"点哪里"，不能只写"还没做" */
  for (const s of denied.steps.filter((x) => x.state !== 'ok')) {
    assert.ok(String(s.detail).length >= 8, `${s.id} 的说明太短，等于没指引`);
  }
});

test('listGuilds：走 getMyGuilds，不依赖会话映射（没聊过天也能列出来）', async () => {
  const h = makePost({
    callQq: async (m) => (m === 'getMyGuilds' ? [{ id: '111', name: '我的频道' }] : undefined),
  });
  assert.deepEqual(await h.post.listGuilds(), [{ id: '111', name: '我的频道' }]);

  /** 方法名写错时 qq.call 只会报"未知方法"，这里断言的是**用对了方法名** */
  assert.ok(h.calls.some((c) => c[0] === 'getMyGuilds'), '必须调 getMyGuilds（不是 getGuilds）');
});

test('listSubChannels：列出全部子频道并标 isForum（不只论坛版块）', async () => {
  const h = makePost();
  const subs = await h.post.listSubChannels('111');
  assert.equal(subs.length, 2, '文字子频道也要列出来——用户要看的是完整结构');
  assert.equal(subs.find((s) => s.type === 10007).isForum, true);
  assert.equal(subs.find((s) => s.type === 0).isForum, false);
  assert.deepEqual(await h.post.listSubChannels('abc'), [], '坏 id 不发请求');
});

test('humanError：需要去外部后台修的（论坛权限）必须带地址和可照做的步骤', () => {
  const h = humanError(11253);
  assert.match(h.url, /q\.qq\.com/, '要能点过去，不能只写"去开放平台"');
  assert.ok(h.todo.some((x) => /接口权限|能力配置/.test(x)), '要指到具体菜单');
  assert.ok(h.todo.some((x) => /移出频道/.test(x)));

  const denied = postSteps(
    { guildId: '111', channelId: '' },
    { guildEnabled: true, inGuild: true, forumChannels: null, perm: false, permError: { code: '11253' } },
  );
  assert.match(denied.steps.find((s) => s.id === 'perm').url, /q\.qq\.com/, '体检项要把地址带给面板');
});

test('shareUrlOf：二维码内容就是 appid 拼的 URL（这张码是实测解出来的）', () => {
  assert.equal(
    shareUrlOf('102056878'),
    'https://qun.qq.com/qunpro/robot/share?robot_appid=102056878',
  );
  assert.equal(shareUrlOf(''), '', '没 appid 就别拼，面板据此显示"框架没连上"');
  assert.equal(shareUrlOf('abc'), '', '纯字母不是 appid，拼出来只会打不开');
  assert.equal(
    shareUrlOf(' 102 056 878 '),
    'https://qun.qq.com/qunpro/robot/share?robot_appid=102056878',
    '粘贴带空格时要把非数字剔掉',
  );
});

test('whoOf：机器人自己的话算「我」，系统事件算「系统」，人算名字', () => {
  /**
   * 账本里机器人发言的 `kind` 是会话类型、`user_name` 才是空的 —— 靠 kind 判会全错，
   * 结果是她在日记里把自己的话当成别人说的（或反过来）。
   */
  assert.equal(whoOf({ who: '（未知）', kind: 'group' }), '我');
  assert.equal(whoOf({ who: '', kind: 'guild' }), '我');
  assert.equal(whoOf({ who: '（未知）', kind: 'notice' }), '（系统）');
  assert.equal(whoOf({ who: '张三', kind: 'group' }), '张三');
  assert.equal(whoOf({ who: '张三', kind: 'notice' }), '张三', '有名字就是人，即使 kind 标了 notice');
});

test('material：系统通知不进素材，机器人发言标成「我」', async () => {
  const seen = [];
  const h = makePost({
    ledgerRecent: ({ chatId }) => {
      seen.push(chatId);
      return [
        { at: 1000, who: '（未知）', text: '我说的话', kind: 'group' },
        { at: 2000, who: '（未知）', text: '有人入群了', kind: 'notice' },
        { at: 3000, who: '张三', text: '你好', kind: 'group' },
      ];
    },
  });
  const r = await h.post.preview();
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['333'], '只查文字子频道');
});

test('dayKey / asHHMM 基本形状', () => {
  assert.match(dayKey(new Date(2026, 10, 17)), /^2026-11-17$/);
  assert.equal(asHHMM(600), '10:00');
  assert.equal(asHHMM(1439), '23:59');
});
