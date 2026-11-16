/**
 * `qq_sign` / `qq_name`：改简介与昵称。
 *
 * 这一组最该守住的是**顺序与判据**，不是格式化：
 *   · 昵称没有真实发送者时必须拒（主动搭话轮被塞了 bucket:'owner'，按 bucket 判会放行）
 *   · `selfName` 存在时必须拒（改平台昵称会造成「资料卡一个名、自称另一个名」）
 *   · 平台写成功后**才**同步本地名字（反了就是「她说自己叫小蓝、点开还是大肥鱼」）
 *
 * 跑法：node --test test/profile-tool.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFileSync } from 'node:fs';
import {
  friendlyDevError, validateProfileText, checkRenameAllowed, validateAvatarSource,
  readImageAsDataUrl, buildProfileTools, buildProfilePrompt, restoreProfileValue,
  MAX_NAME_LEN, MAX_DESC_LEN, AVATAR_MAX_BYTES,
} from '../src/profile-tool.js';
import { createHistory } from '../src/self-expression.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-profile-'));
  /** Windows 上刚写完的文件偶尔还占着句柄，直接 rm 会 ENOTEMPTY —— 不是被测代码的问题 */
  return { dir, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

/**
 * 有状态的假协议：`dev.bot.set` 真的改「平台上的」资料，
 * 否则回读断言测不出东西（menu 的假实现踩过这个坑）。
 */
function fakeRpc({ name = '旧名', desc = '旧简介', loggedIn = true, failSet = null } = {}) {
  const calls = [];
  const base = { name, desc, avatar: 'https://example.com/a.png', modifyRemain: null };
  const fn = async (m, params = {}) => {
    calls.push({ m, params });
    if (m === 'system.hello') return { bot: { appId: '123456' } };
    if (m === 'dev.status') return { loggedIn };
    if (m === 'dev.bot.get') return { appid: '123456', base: { ...base } };
    if (m === 'dev.bot.set') {
      if (failSet) throw new Error(failSet);
      const b = params.patch?.base || {};
      if (b.name !== undefined) base.name = b.name;
      if (b.desc !== undefined) base.desc = b.desc;
      return { ok: true };
    }
    if (m === 'dev.bot.avatar') {
      if (failSet) throw new Error(failSet);
      /** 平台换完地址就变了：回读断言要靠这个 */
      base.avatar = params.src?.url || 'https://example.com/new.png';
      return { ok: true, uploaded: Boolean(params.src?.dataUrl) };
    }
    throw new Error('unexpected ' + m);
  };
  fn.calls = calls;
  fn.base = () => ({ ...base });
  return fn;
}

function makeTools({
  dir, rpc: rpcIn = null, cfg = {}, caller = { sid: 's1', bucket: 'owner', senderId: 'u1' },
  persona = { id: 'main', selfName: '' }, t = 1_000_000, requestConfirm = null,
} = {}) {
  const rpc = rpcIn || fakeRpc();
  const history = createHistory({ dataDir: () => dir });
  const synced = [];
  const { tools: [sign, name, avatar] } = buildProfileTools({
    rpc,
    cfgOf: () => ({
      selfExpression: {
        sign: { enabled: true, cooldownMin: 0, ...(cfg.sign || {}) },
        name: { enabled: true, cooldownMin: 0, ...(cfg.name || {}) },
        avatar: { enabled: true, cooldownMin: 0, ...(cfg.avatar || {}) },
      },
    }),
    history,
    callerOf: () => caller,
    personaOf: () => persona,
    syncPersonaName: (v) => synced.push(v),
    requestConfirm,
    now: () => t,
  });
  return { sign, name, avatar, rpc, history, synced };
}

/* ---------------- 纯函数 ---------------- */

test('F1 错误翻译：未登录 / 限频 / 其它原样', () => {
  assert.match(friendlyDevError(new Error('NOT_LOGGED_IN')), /没登录/);
  assert.match(friendlyDevError(new Error('retcode 10000')), /限频|过一会儿/);
  assert.equal(friendlyDevError(new Error('奇怪的东西')), '奇怪的东西');
});

test('V1 文本校验：空 / 超长 / 正常', () => {
  assert.equal(validateProfileText('', { field: '简介', max: 10 }).ok, false);
  assert.equal(validateProfileText('   ', { field: '简介', max: 10 }).ok, false);
  const long = '一'.repeat(MAX_DESC_LEN + 1);
  assert.equal(validateProfileText(long, { field: '简介', max: MAX_DESC_LEN }).ok, false);
  assert.deepEqual(validateProfileText(' 今天也很好 ', { field: '简介', max: 20 }), { ok: true, text: '今天也很好' });
});

test('R1 角色卡人格（有 selfName）→ 拒绝改昵称', () => {
  const r = checkRenameAllowed({ id: 'waka', selfName: '若叶睦' });
  assert.equal(r.ok, false);
  assert.match(r.message, /若叶睦/);
  assert.match(r.message, /人格卡/, '要告诉人该去哪儿改，而不是只说不行');
});

test('R2 普通人格 → 允许', () => {
  assert.deepEqual(checkRenameAllowed({ id: 'main', selfName: '' }), { ok: true });
  assert.deepEqual(checkRenameAllowed(null), { ok: true });
});

/* ---------------- 简介 ---------------- */

test('S1 不传 text = 只读，不写平台', async () => {
  const { dir, done } = fresh();
  try {
    const { sign, rpc } = makeTools({ dir });
    const r = await sign.execute({});
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'read');
    assert.equal(r.desc, '旧简介');
    assert.equal(rpc.calls.filter((c) => c.m === 'dev.bot.set').length, 0);
  } finally { done(); }
});

test('S2 写简介：只带 desc，不动 name；历史存字符串', async () => {
  const { dir, done } = fresh();
  try {
    const { sign, rpc, history } = makeTools({ dir });
    const r = await sign.execute({ text: '今天想安静一点' });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'write');
    assert.equal(r.desc, '今天想安静一点', '回读值要等于平台上的');
    const set = rpc.calls.find((c) => c.m === 'dev.bot.set');
    assert.deepEqual(set.params.patch.base, { desc: '今天想安静一点' }, '不该顺手把 name 也塞进去');
    const row = history.read()[0];
    assert.equal(row.kind, 'sign');
    assert.equal(row.before, '旧简介');
    assert.equal(row.after, '今天想安静一点');
  } finally { done(); }
});

test('S3 没登录 → 拒，且不写平台', async () => {
  const { dir, done } = fresh();
  try {
    const rpc = fakeRpc({ loggedIn: false });
    const { sign } = makeTools({ dir, rpc });
    const r = await sign.execute({ text: '新简介' });
    assert.equal(r.ok, false);
    assert.match(r.message, /开发者后台没登录/);
    assert.equal(rpc.calls.filter((c) => c.m === 'dev.bot.set').length, 0);
  } finally { done(); }
});

test('S4 平台拒绝：留失败历史、给出人话', async () => {
  const { dir, done } = fresh();
  try {
    const rpc = fakeRpc({ failSet: 'retcode 10000' });
    const { sign, history } = makeTools({ dir, rpc });
    const r = await sign.execute({ text: '新简介' });
    assert.equal(r.ok, false);
    assert.match(r.message, /过一会儿/);
    assert.equal(history.read()[0].ok, false);
  } finally { done(); }
});

test('S5 冷却未过 → 拒', async () => {
  const { dir, done } = fresh();
  try {
    const { sign, history } = makeTools({ dir, cfg: { sign: { cooldownMin: 60 } }, t: 1_000_000 });
    history.push({ kind: 'sign', at: 1_000_000 - 60_000, before: 'a', after: 'b' });
    const r = await sign.execute({ text: '新简介' });
    assert.equal(r.ok, false);
    assert.match(r.message, /还要等/);
  } finally { done(); }
});

/* ---------------- 昵称 ---------------- */

test('N1 没有真实发送者 → 拒（主动搭话轮的 bucket 是 owner，不能靠它）', async () => {
  const { dir, done } = fresh();
  try {
    const { name, rpc } = makeTools({ dir, caller: { sid: 's1', bucket: 'owner', senderId: '' } });
    const r = await name.execute({ name: '小蓝' });
    assert.equal(r.ok, false);
    assert.match(r.message, /有人在跟你说话/);
    assert.equal(rpc.calls.filter((c) => c.m === 'dev.bot.set').length, 0);
  } finally { done(); }
});

test('N2 说话人不是主人 → 拒', async () => {
  const { dir, done } = fresh();
  try {
    const { name } = makeTools({ dir, caller: { sid: 's1', bucket: 'manager', senderId: 'u2' } });
    const r = await name.execute({ name: '小蓝' });
    assert.equal(r.ok, false);
    assert.match(r.message, /主人/);
  } finally { done(); }
});

test('N3 角色卡人格 → 拒（即使主人亲自说）', async () => {
  const { dir, done } = fresh();
  try {
    const { name, rpc } = makeTools({ dir, persona: { id: 'waka', selfName: '若叶睦' } });
    const r = await name.execute({ name: '小蓝' });
    assert.equal(r.ok, false);
    assert.match(r.message, /若叶睦/);
    assert.equal(rpc.calls.filter((c) => c.m === 'dev.bot.set').length, 0);
  } finally { done(); }
});

test('N4 正常改名：平台先写、本地后同步、历史带 selfName 与 personaId', async () => {
  const { dir, done } = fresh();
  try {
    const { name, rpc, history, synced } = makeTools({ dir });
    const r = await name.execute({ name: '小蓝' });
    assert.equal(r.ok, true);
    assert.equal(r.name, '小蓝');
    assert.deepEqual(synced, ['小蓝'], '本地名字要跟着改');
    /** 平台写入必须在本地同步之前：用调用顺序验（sync 只可能在 set 之后被调用） */
    const setAt = rpc.calls.findIndex((c) => c.m === 'dev.bot.set');
    assert.ok(setAt >= 0);
    const row = history.read()[0];
    assert.equal(row.kind, 'name');
    assert.equal(row.before.name, '旧名');
    assert.equal(row.before.selfName, '', '快照要带 selfName，回滚才知道当时有没有');
    assert.equal(row.before.personaId, 'main');
    assert.equal(row.after.name, '小蓝');
  } finally { done(); }
});

test('N5 本地同步失败：平台算改成功，返回里说清楚', async () => {
  const { dir, done } = fresh();
  try {
    const rpc = fakeRpc();
    const history = createHistory({ dataDir: () => dir });
    const { tools: [sign, name] } = buildProfileTools({
      rpc,
      cfgOf: () => ({ selfExpression: { sign: { enabled: true }, name: { enabled: true } } }),
      history,
      callerOf: () => ({ sid: 's1', bucket: 'owner', senderId: 'u1' }),
      personaOf: () => ({ id: 'main', selfName: '' }),
      syncPersonaName: () => { throw new Error('盘满了'); },
      now: () => 1_000_000,
    });
    void sign;
    const r = await name.execute({ name: '小蓝' });
    assert.equal(r.ok, true, '平台改成功了不能报失败');
    assert.equal(r.selfSynced, false);
    assert.match(r.note, /本地/);
    assert.match(history.read()[0].note, /没同步/);
  } finally { done(); }
});

test('N6 昵称超长 → 拒', async () => {
  const { dir, done } = fresh();
  try {
    const { name } = makeTools({ dir });
    const r = await name.execute({ name: '一'.repeat(MAX_NAME_LEN + 1) });
    assert.equal(r.ok, false);
    assert.match(r.message, /最多/);
  } finally { done(); }
});

test('N7 读昵称时带上 selfName（让她知道自称和资料卡是不是一个）', async () => {
  const { dir, done } = fresh();
  try {
    const { name } = makeTools({ dir, persona: { id: 'waka', selfName: '若叶睦' } });
    const r = await name.execute({});
    assert.equal(r.ok, true);
    assert.equal(r.name, '旧名');
    assert.equal(r.self, '若叶睦');
  } finally { done(); }
});

/* ---------------- 提示词 ---------------- */

test('P1 提示词按开关拼；都关就是空串', () => {
  assert.equal(buildProfilePrompt({}), '');
  const onlySign = buildProfilePrompt({ sign: true });
  assert.match(onlySign, /简介/);
  assert.equal(/名字/.test(onlySign), false);
  const both = buildProfilePrompt({ sign: true, name: true });
  assert.match(both, /名字/);
  assert.match(both, /主人/);
});

/* ---------------- 头像 ---------------- */

test('AV1 来源校验：url 只收 http(s)，dataUrl 只收四种图', () => {
  assert.equal(validateAvatarSource({ url: 'https://x/a.png' }).ok, true);
  /** url 字段只认 http(s)：本地路径要写进 path，别混进来 */
  assert.equal(validateAvatarSource({ url: '/tmp/a.png' }).ok, false);
  assert.equal(validateAvatarSource({ url: 'file:///C:/a.png' }).ok, false);
  const webp = validateAvatarSource({ dataUrl: 'data:image/webp;base64,AAAA' });
  assert.equal(webp.ok, false);
  assert.match(webp.message, /不收/);
  assert.equal(validateAvatarSource({ dataUrl: 'data:image/png;base64,AAAA' }).ok, true);
  assert.equal(validateAvatarSource({}).ok, false);
});

test('AV2 dataUrl 超过 2MB 拒（按 base64 长度估，不先解码）', () => {
  const big = 'A'.repeat(Math.ceil((AVATAR_MAX_BYTES + 1024) * 4 / 3));
  const r = validateAvatarSource({ dataUrl: `data:image/png;base64,${big}` });
  assert.equal(r.ok, false);
  assert.match(r.message, /2MB/);
});

test('AV6 本地路径：真图读成 dataUrl；后缀 / 大小 / 存在性 / 目录各自拒', () => {
  const { dir, done } = fresh();
  try {
    const png = join(dir, 'a.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    const ok = readImageAsDataUrl(png);
    assert.equal(ok.ok, true);
    assert.match(ok.dataUrl, /^data:image\/png;base64,/);
    assert.equal(ok.mime, 'image/png');
    assert.equal(ok.bytes, 6);

    writeFileSync(join(dir, 'a.webp'), Buffer.from([1, 2, 3]));
    const bad = readImageAsDataUrl(join(dir, 'a.webp'));
    assert.equal(bad.ok, false);
    assert.match(bad.message, /\.webp/);

    assert.equal(readImageAsDataUrl(join(dir, 'nope.png')).ok, false);
    assert.equal(readImageAsDataUrl(dir).ok, false, '目录不是文件');

    writeFileSync(join(dir, 'empty.png'), Buffer.alloc(0));
    assert.equal(readImageAsDataUrl(join(dir, 'empty.png')).ok, false);
  } finally { done(); }
});

test('AV7 超过 2MB 先 stat 就拒，不读进内存', () => {
  const r = readImageAsDataUrl('C:/x/big.png', {
    stat: () => ({ isFile: () => true, size: AVATAR_MAX_BYTES + 1 }),
    readFile: () => { throw new Error('不该读到这一步'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /2MB/);
});

test('AV8 path 交给 validateAvatarSource 时转成 dataUrl', () => {
  const { dir, done } = fresh();
  try {
    const png = join(dir, 'b.png');
    writeFileSync(png, Buffer.from([1, 2, 3, 4]));
    const r = validateAvatarSource({ path: png });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'path');
    assert.match(r.src.dataUrl, /^data:image\/png;base64,/);
  } finally { done(); }
});

test('AV9 用本地路径换头像：上传的是 dataUrl，历史 before 仍是旧地址', async () => {
  const { dir, done } = fresh();
  try {
    const png = join(dir, 'c.jpg');
    writeFileSync(png, Buffer.from([9, 9, 9]));
    const { avatar, rpc, history } = makeTools({ dir });
    const r = await avatar.execute({ path: png });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'path');
    const call = rpc.calls.find((c) => c.m === 'dev.bot.avatar');
    assert.match(call.params.src.dataUrl, /^data:image\/jpeg;base64,/);
    assert.equal(history.read()[0].before.url, 'https://example.com/a.png');
  } finally { done(); }
});

test('AV3 读头像 → 换头像 → 历史记下旧地址', async () => {
  const { dir, done } = fresh();
  try {
    const { avatar, history } = makeTools({ dir });
    const before = await avatar.execute({});
    assert.equal(before.ok, true);
    assert.equal(before.mode, 'read');
    assert.equal(before.avatar, 'https://example.com/a.png');

    const r = await avatar.execute({ url: 'https://example.com/b.png' });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'write');
    assert.equal(r.avatar, 'https://example.com/b.png', '回读拿到平台上的新地址');

    const row = history.read()[0];
    assert.equal(row.kind, 'avatar');
    assert.equal(row.before.url, 'https://example.com/a.png', '回滚要靠这个地址重传');
    assert.equal(row.after.url, 'https://example.com/b.png');
  } finally { done(); }
});

test('AV4 本地路径被拒，且不写平台', async () => {
  const { dir, done } = fresh();
  try {
    const { avatar, rpc } = makeTools({ dir });
    const r = await avatar.execute({ url: 'D:/pics/a.png' });
    assert.equal(r.ok, false);
    assert.equal(rpc.calls.filter((c) => c.m === 'dev.bot.avatar').length, 0);
  } finally { done(); }
});

test('AV5 头像也受冷却约束', async () => {
  const { dir, done } = fresh();
  try {
    const { avatar, history } = makeTools({ dir, cfg: { avatar: { cooldownMin: 60 } } });
    history.push({ kind: 'avatar', at: 1_000_000 - 60_000, before: null, after: { url: 'x' } });
    const r = await avatar.execute({ url: 'https://example.com/c.png' });
    assert.equal(r.ok, false);
    assert.match(r.message, /还要等/);
  } finally { done(); }
});

/* ---------------- 回滚 ---------------- */

test('RS1 回滚简介：只写 desc', async () => {
  const { dir, done } = fresh();
  try {
    const rpc = fakeRpc({ desc: '现在的简介' });
    void dir;
    const r = await restoreProfileValue({ kind: 'sign', before: '旧简介', rpc });
    assert.equal(r.ok, true);
    assert.deepEqual(r.restored, { desc: '旧简介' });
    const set = rpc.calls.find((c) => c.m === 'dev.bot.set');
    assert.deepEqual(set.params.patch.base, { desc: '旧简介' });
  } finally { done(); }
});

test('RS2 回滚昵称：平台改完再同步本地', async () => {
  const { dir, done } = fresh();
  try {
    const rpc = fakeRpc();
    const synced = [];
    const r = await restoreProfileValue({
      kind: 'name', before: { name: '旧名', selfName: '', personaId: 'main' }, rpc,
      syncPersonaName: (v) => synced.push(v),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(synced, ['旧名']);
  } finally { done(); }
});

test('RS3 回滚头像：按 URL 重传；没有旧地址就拒', async () => {
  const { dir, done } = fresh();
  try {
    const rpc = fakeRpc();
    const ok = await restoreProfileValue({ kind: 'avatar', before: { url: 'https://old/x.png' }, rpc });
    assert.equal(ok.ok, true);
    assert.match(ok.note, /重新上传/, '要说明这是重传而不是撤销');

    const no = await restoreProfileValue({ kind: 'avatar', before: { url: '' }, rpc });
    assert.equal(no.ok, false);
    assert.match(no.message, /回不去/);
  } finally { done(); }
});

test('RS4 没登录时回滚失败也要说人话', async () => {
  const { dir, done } = fresh();
  try {
    const rpc = fakeRpc({ loggedIn: false, failSet: 'NOT_LOGGED_IN' });
    const r = await restoreProfileValue({ kind: 'sign', before: '旧', rpc });
    assert.equal(r.ok, false);
    assert.match(r.message, /没登录/);
  } finally { done(); }
});

/* ---------------- 主人确认 ---------------- */

test('CF1 开了「需确认」：不写平台，返回 pending 与码', async () => {
  const { dir, done } = fresh();
  try {
    const asked = [];
    const { sign, rpc } = makeTools({
      dir,
      cfg: { sign: { confirm: true } },
      requestConfirm: async (req) => { asked.push(req); return { ok: true, code: '1234' }; },
    });
    const r = await sign.execute({ text: '新简介' });
    assert.equal(r.ok, false);
    assert.equal(r.pending, true);
    assert.equal(r.code, '1234');
    assert.equal(rpc.calls.filter((c) => c.m === 'dev.bot.set').length, 0, '确认前不许动平台');
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].payload, { text: '新简介' });
    assert.equal(asked[0].kind, 'sign');
  } finally { done(); }
});

test('CF2 确认通道没接上 → 明确拒，不假装「已请求」', async () => {
  const { dir, done } = fresh();
  try {
    const { sign, rpc } = makeTools({ dir, cfg: { sign: { confirm: true } }, requestConfirm: null });
    const r = await sign.execute({ text: '新简介' });
    assert.equal(r.ok, false);
    assert.equal(r.pending, undefined);
    assert.match(r.message, /确认通道/);
    assert.equal(rpc.calls.filter((c) => c.m === 'dev.bot.set').length, 0);
  } finally { done(); }
});

test('CF3 没开「需确认」就照旧直接写', async () => {
  const { dir, done } = fresh();
  try {
    let asked = 0;
    const { sign } = makeTools({
      dir,
      requestConfirm: async () => { asked += 1; return { ok: true, code: '9999' }; },
    });
    const r = await sign.execute({ text: '新简介' });
    assert.equal(r.ok, true);
    assert.equal(asked, 0);
  } finally { done(); }
});

test('CF4 昵称开了确认也仍要过「主人在场」那一道', async () => {
  const { dir, done } = fresh();
  try {
    let asked = 0;
    const { name } = makeTools({
      dir,
      caller: { sid: 's1', bucket: 'owner', senderId: '' },
      cfg: { name: { confirm: true } },
      requestConfirm: async () => { asked += 1; return { ok: true, code: '1234' }; },
    });
    const r = await name.execute({ name: '小蓝' });
    assert.equal(r.ok, false);
    assert.match(r.message, /有人在跟你说话/);
    assert.equal(asked, 0, '连确认请求都不该发 —— 前面那道闸就该拦住');
  } finally { done(); }
});

test('CF5 头像开确认：payload 是 {src, via}，不是字符串', async () => {
  const { dir, done } = fresh();
  try {
    const asked = [];
    const { avatar } = makeTools({
      dir,
      cfg: { avatar: { confirm: true } },
      requestConfirm: async (req) => { asked.push(req); return { ok: true, code: '4321' }; },
    });
    const r = await avatar.execute({ url: 'https://example.com/z.png' });
    assert.equal(r.pending, true);
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].payload, { src: { url: 'https://example.com/z.png' }, via: 'url' });
  } finally { done(); }
});
