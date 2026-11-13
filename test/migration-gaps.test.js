// 账号迁移缺口（审计 §3 的 P1/P2/P3）+ 4.5 流水层 + 深链。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const U = (p) => pathToFileURL(p).href;

const OLD = 'AAAA1111BBBB2222CCCC3333DDDD4444';
const UIN = '10001';

function seedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-mig-gap-'));
  mkdirSync(dir, { recursive: true });
  process.env.DSH_ROOST_DATA = dir;
  const w = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2), 'utf8');
  w('config.json', {
    model: { byChat: { [OLD]: { model: 'm-old' } } },
    persona: { byChat: { [OLD]: 'lazycat' } },
    group: { overrides: { [OLD]: { mute: true } } },
    speakUp: { chatId: OLD },
    awake: { groups: [{ chatId: OLD, name: '某群' }] },
  });
  w('profiles.json', [{ key: OLD, name: '阿岚', impression: '爱发图', tips: '' }]);
  w('closing.json', { chats: { [OLD]: { at: Date.now(), point: '聊到搬家', resume: '', why: '', turns: 2 } } });
  w('memory.json', { global: [], chats: { [OLD]: ['旧事实'] }, meta: { global: {}, chats: { [OLD]: { 旧事实: { w: 2, at: Date.now() } } } } });
  w('sessions.json', { chats: { [OLD]: { sessionId: 'sid-old', title: '旧会话', kind: 'c2c' } } });
  return dir;
}

const fakeStore = () => ({
  reload() {}, close() {},
  rekey() { return 0; },
  get() { return ''; },
  list() { return []; },
});

test('一键改写：配置五处键 / 人物档案 / 收尾记录都合到号码键', async () => {
  const dir = seedDir();
  const { createRewriter } = await import('../src/rewrite.js');
  let reloaded = 0;
  const rw = createRewriter({
    memory: fakeStore(), journal: fakeStore(), graph: fakeStore(), sessions: fakeStore(),
    boundList: async () => ({ ok: true, users: [{ uin: UIN, claims: [{ openid: OLD, state: 'active' }] }], groups: [] }),
    backupRoot: join(dir, 'backups'),
    onReload: () => { reloaded += 1; },
    log: () => {},
  });
  const r = await rw.apply({ uins: [UIN], confirm: '改写' });
  assert.equal(r.ok, true, r.error || r.code);

  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(cfg.model.byChat[UIN]?.model, 'm-old', '单聊模型要跟着换键');
  assert.equal(cfg.model.byChat[OLD], undefined, '旧键要删掉');
  assert.equal(cfg.persona.byChat[UIN], 'lazycat', '人格绑定要跟着换键');
  assert.ok(cfg.group.overrides[UIN], '按群覆写要跟着换键');
  assert.equal(cfg.speakUp.chatId, UIN, '主动搭话目标要换');
  assert.equal(cfg.awake.groups[0].chatId, UIN, '群主动白名单要换');

  const profiles = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8'));
  const arr = Array.isArray(profiles) ? profiles : profiles.people;
  assert.equal(arr.length, 1, '同一个人不能裂两条');
  assert.equal(arr[0].key, UIN);

  const closing = JSON.parse(readFileSync(join(dir, 'closing.json'), 'utf8'));
  assert.ok(closing.chats[UIN], '收尾记录要换键');
  assert.equal(closing.chats[OLD], undefined);

  const mem = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
  assert.deepEqual(mem.chats[UIN], ['旧事实'], '记忆本体照旧合并');

  assert.ok(reloaded >= 1, '改完要重新读配置，否则面板还是旧值');
  assert.ok(r.changed.config >= 5, `配置改了 ${r.changed.config} 处，应该至少 5`);
  assert.equal(r.changed.profiles, 1);
  assert.equal(r.changed.closing, 1);
});

test('目标键已有值时不覆盖（用户手动重选过的优先）', async () => {
  const dir = seedDir();
  const cfgFile = join(dir, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.persona.byChat[UIN] = 'already-set';
  writeFileSync(cfgFile, JSON.stringify(cfg), 'utf8');
  const { createRewriter } = await import('../src/rewrite.js');
  const rw = createRewriter({
    memory: fakeStore(), journal: fakeStore(), graph: fakeStore(), sessions: fakeStore(),
    boundList: async () => ({ ok: true, users: [{ uin: UIN, claims: [{ openid: OLD, state: 'active' }] }], groups: [] }),
    backupRoot: join(dir, 'backups'), log: () => {},
  });
  const r = await rw.apply({ uins: [UIN], confirm: '改写' });
  assert.equal(r.ok, true);
  const after = JSON.parse(readFileSync(cfgFile, 'utf8'));
  assert.equal(after.persona.byChat[UIN], 'already-set', '不能覆盖已有值');
  assert.equal(after.persona.byChat[OLD], undefined);
});

test('归户：私聊说话人 openid === chatId 时归到号码，群成员不归', async () => {
  const { canonicalKey } = await import('../src/profiles.js');
  assert.equal(canonicalKey(OLD, [UIN], OLD), UIN, '私聊：当前 openid 应归户');
  assert.equal(canonicalKey('member-openid', [UIN], 'GROUP_OPENID'), 'member-openid', '群成员不能被合并');
  assert.equal(canonicalKey(OLD, [UIN]), OLD.toLowerCase(), '不传 current 时保持老行为（键统一小写）');
  assert.equal(canonicalKey('OLDER', [UIN, 'OLDER']), UIN, '命中别名仍归户（老行为不变）');
});

test('会话 / 收尾读取支持别名回退（只绑定不改写也能接上）', async () => {
  const dir = seedDir();
  const { createSessions } = await import('../src/sessions.js');
  const s = createSessions({ dataDir: dir, log: () => {} });
  assert.equal(s.get('NEW_OPENID', [UIN, OLD]), 'sid-old', '新键没有时回退到旧键');
  assert.equal(s.get('NEW_OPENID'), '', '不传别名时保持老行为');

  const { createClosing } = await import('../src/closing.js');
  const c = createClosing({ enabled: true, coolMinutes: 30, maxChats: 10, ttlDays: 7 });
  const rec = c.get('NEW_OPENID', [UIN, OLD]);
  assert.equal(rec?.point, '聊到搬家', '收尾记录也要能按别名读到');
  assert.equal(c.get('NEW_OPENID'), null, '不传别名时保持老行为');
});

test('4.5 流水层：用量按人格分桶，原 total/chats 结构不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-usage-'));
  mkdirSync(dir, { recursive: true });
  process.env.DSH_ROOST_DATA = dir;
  const { createUsage } = await import('../src/usage.js');
  const u = createUsage({ file: join(dir, 'usage.json'), log: () => {} });
  const at = Date.UTC(2026, 10, 13, 4);
  u.record({ chatId: 'CHAT_A', at, model: 'm', personaId: 'lazycat', usage: { uncached: 100, output: 50 } });
  const raw = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'));
  const day = Object.values(raw.days)[0];
  assert.ok(day.total.uncached >= 100, 'total 照旧');
  assert.ok(day.chats.CHAT_A, 'chats 照旧按逻辑 chatId');
  assert.ok(day.personas?.lazycat, '人格桶要存在');
  assert.equal(day.personas.lazycat.uncached, 100);
  /** 不传 personaId 时不产生空桶 */
  u.record({ chatId: 'CHAT_B', at, model: 'm', usage: { uncached: 10 } });
  const raw2 = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'));
  const day2 = Object.values(raw2.days)[0];
  assert.deepEqual(Object.keys(day2.personas), ['lazycat']);
});

test('深链 ?tab=xxx 真的能直达（以前只有文案）', async () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.ok(src.includes("URLSearchParams(location.search"), '要真的解析 location.search');
  assert.ok(/if \(want && ALL_TABS\.includes\(want\)\) return want/.test(src), '命中合法页签才直达');

  /** 真渲染：把 location 指到 ?tab=memory，首屏应该是记忆页 */
  const store = {};
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  globalThis.location = { search: '?tab=memory' };
  globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  const rt = makeReact();
  const mod = loadClient(rt.React, src);
  rt.reset();
  const tree = expand(mod.RoostPage(), rt);
  const txt = textOf(tree);
  assert.ok(txt.includes('记忆星图'), `深链没落到记忆页：${txt.slice(0, 80)}`);
  delete globalThis.location;
});

/* ---------- 假 React（与其它渲染测试同一套） ---------- */
function makeReact() {
  const hooks = []; let i = 0;
  return {
    reset() { i = 0; hooks.length = 0; },
    React: {
      createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
      useState: (init) => { const k = i++; if (!(k in hooks)) hooks[k] = typeof init === 'function' ? init() : init; return [hooks[k], () => {}]; },
      useEffect: () => { i++; }, useCallback: (fn) => { i++; return fn; },
      useRef: (v) => { const k = i++; if (!(k in hooks)) hooks[k] = { current: v }; return hooks[k]; },
      useMemo: (fn) => { i++; return fn(); }, Fragment: 'fragment',
    },
  };
}
function loadClient(react, src) {
  let mod = null;
  const win = { __ModuleLoader__: { load: (cfg) => { mod = cfg.factory((n) => (n === 'react' ? react : {})); } } };
  new Function('window', src)(win);
  return mod;
}
function expand(node, rt) {
  if (node == null || node === false || node === true) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((n) => expand(n, rt)).filter((x) => x !== null);
  if (typeof node.type === 'function') { rt.reset(); return expand(node.type(node.props || {}), rt); }
  return { ...node, props: { ...node.props, children: expand(node.props?.children, rt) } };
}
function textOf(n) {
  if (n == null || n === false) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  return textOf(n.props?.children);
}
