/**
 * E7 接线测试：锁「代码写了但没接上」。
 *
 * 脱敏是横切关注点，最怕的是纯函数写好了、日志器那一层忘了调。
 * 所以这里用源码切片把五个接线点钉住，再真跑 host 与 audit 落盘。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = () => () => {};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

async function boot({ token = 'SERVERTOKEN-ABCDEFG' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-redact-wire-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    server: { port: 17321, token },
    tts: { apiKey: 'TTSKEY-123456789' },
  }), 'utf8');

  const seen = { info: [], warn: [], error: [], debug: [] };
  const routes = new Map();
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: () => noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: {
      info: (m) => seen.info.push(String(m)),
      warn: (m) => seen.warn.push(String(m)),
      error: (m) => seen.error.push(String(m)),
      debug: (m) => seen.debug.push(String(m)),
    },
    effect: (cb) => {
      const off = typeof cb === 'function' ? cb() : null;
      if (typeof off === 'function') cleanups.push(off);
      return noop;
    },
    on: () => noop,
    dataDir: data,
    dir,
  };
  const host = await import(`../src/host.js?red=${Date.now()}-${Math.random()}`);
  host.apply(ctx);

  const call = async (path, body, method = 'POST', raw = false) => {
    const res = { statusCode: 0, setHeader() {}, end(s) { this.body = raw ? s : JSON.parse(s); } };
    const req = {
      method, url: path, headers: { host: '127.0.0.1:8931' },
      async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); },
    };
    const h = routes.get(path);
    assert.ok(h, `路由没注册：${path}`);
    await h(req, res);
    return res;
  };
  return {
    call, data, seen,
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test('五个接线点都在：addLog / log 四档 / fmtLog 对象 / provider / audit.note', () => {
  const host = read('../src/host.js');
  assert.ok(host.includes('text: redactText(text) }'), 'addLog 入口没脱敏');
  assert.ok(host.includes('debug: (...a) => { const m = redactText(joinLog(a)); raw.debug(m); }'),
    'debug 以前是裸引用，最容易漏');
  for (const lv of ['info', 'warn', 'error']) {
    assert.ok(host.includes(`${lv}: (...a) => { const m = redactText(joinLog(a)); raw.${lv}(m);`),
      `log.${lv} 没脱敏`);
  }
  assert.ok(host.includes('return JSON.stringify(redactValue(a));'), '对象参数没按字段名脱敏');
  assert.ok(host.includes('ctx.effect(() => addSecretProvider(() => collectSecrets(cfg)));'),
    '配置密钥没按实例挂给脱敏器（多实例不能互相覆盖）');
  assert.ok(host.includes('OUTBOUND_TEXT_KEY.test(k)'), '面板回显没脱敏');
  assert.ok(host.includes('safeOutbound(v, depth + 1)'), '面板回显只护顶层，嵌套文案没递归');
  assert.ok(host.includes('redactText((e && e.stack) || e)'), '激活错误日志没脱敏');
  const audit = read('../src/audit.js');
  assert.ok(audit.includes("typeof v === 'string' ? redactText(v) : v"), 'audit 整行没脱敏');
});

test('真跑 host：/logs 正常、启动日志里没有明文密钥', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.call('/roost/api/logs', null, 'GET');
  assert.equal(r.body.ok, true);
  assert.ok(Array.isArray(r.body.entries));
  const all = [...b.seen.info, ...b.seen.warn, ...b.seen.error, ...b.seen.debug,
    ...r.body.entries.map((e) => e.text)].join('\n');
  assert.ok(!all.includes('SERVERTOKEN-ABCDEFG'), '宿主日志里漏了明文 token');
  assert.ok(!all.includes('TTSKEY-123456789'), '宿主日志里漏了明文 apiKey');
});

test('audit 落盘：note 里的凭证被抹掉，op / chatId 原样保留', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-audit-redact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  t.after(() => {
    if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = oldEnv;
  });
  const { audit } = await import(`../src/audit.js?red=${Date.now()}`);
  audit({ op: 'memory.clear', chatId: 'g1', peer: 'owner', note: 'Bearer abcdef1234567890 token=ghijkl987654' });
  const line = readFileSync(join(dir, 'audit.log'), 'utf8').trim();
  const row = JSON.parse(line);
  assert.equal(row.op, 'memory.clear');
  assert.equal(row.chatId, 'g1');
  assert.ok(!line.includes('abcdef1234567890'), line);
  assert.ok(!line.includes('ghijkl987654'), line);
  assert.match(row.note, /\*\*\*/);
  assert.equal(existsSync(join(dir, 'audit.log')), true);
});

test('面板日志经 addLog 独立调用点也脱敏（不只 log.* 那条路）', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.call('/roost/api/backup/export', null, 'GET', true);
  // 导出接口走 log.info；再查 /logs 确认面板侧同样干净
  assert.ok(r.statusCode === 200 || r.statusCode === 500);
  const logs = await b.call('/roost/api/logs', null, 'GET');
  for (const e of logs.body.entries || []) {
    assert.ok(!String(e.text).includes('SERVERTOKEN-ABCDEFG'), `面板日志漏明文：${e.text}`);
  }
  assert.ok(!b.seen.info.some((m) => m.includes('SERVERTOKEN-ABCDEFG')));
});

test('真行为：/quick 的 op / chatId 回显与 audit 落盘都不留明文凭证', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.call('/roost/api/quick', {
    op: 'Bearer QOPSECRET123456', chatId: 'token=CHATSECRET123456',
  });
  assert.equal(r.statusCode, 400);
  const out = JSON.stringify(r.body);
  assert.ok(!out.includes('QOPSECRET123456'), `面板回显漏明文：${out}`);
  assert.ok(!out.includes('CHATSECRET123456'), `面板回显漏明文：${out}`);
  const f = join(b.data, 'audit.log');
  if (existsSync(f)) {
    const line = readFileSync(f, 'utf8');
    assert.ok(!line.includes('QOPSECRET123456'), `audit 漏明文：${line}`);
    assert.ok(!line.includes('CHATSECRET123456'), `audit 漏明文：${line}`);
  }
});

test('真行为：/mood 回显与宿主日志都脱敏（断言用截断后的真实串）', async (t) => {
  const b = await boot();
  t.after(b.done);
  /** `/mood` 内部 `String(raw).slice(0, 20)` 会截成 `Bearer MOODSECRET123`，
   *  查完整串是恒真断言（对抗测试抓到过），必须按截断后的串来查 */
  const r = await b.call('/roost/api/mood', { feedback: 'Bearer MOODSECRET123456' });
  const out = JSON.stringify(r.body);
  assert.ok(!out.includes('MOODSECRET123'), `面板回显漏明文：${out}`);
  assert.ok(b.seen.warn.length > 0, '这条用例必须真产生一条宿主日志，否则断言是空的');
  assert.ok(!b.seen.warn.some((m) => m.includes('MOODSECRET123')), '宿主日志漏明文');
});

test('真行为：配置密钥以裸串进 /mood，响应与日志仍不留明文（挡住 collectSecrets / provider 失效）', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.call('/roost/api/mood', { feedback: 'SERVERTOKEN-ABCDEFG' });
  assert.ok(!JSON.stringify(r.body).includes('SERVERTOKEN-ABCDEFG'), '面板回显漏了配置密钥');
  assert.ok(b.seen.warn.length > 0);
  assert.ok(!b.seen.warn.some((m) => m.includes('SERVERTOKEN-ABCDEFG')), '宿主日志漏了配置密钥');
});

test('真行为：redactValue 真的按字段名脱敏（不是恒等）', async () => {
  const { redactValue } = await import('../src/redact.js');
  const out = redactValue({ token: 'abcdef123456', text: '正常内容' });
  assert.equal(out.token, '***');
  assert.equal(out.text, '正常内容');
});

test('真行为：provider 累加，B 卸载不会把 A 的保护一起清掉', async (t) => {
  const { addSecretProvider, redactText: redact } = await import('../src/redact.js');
  const offA = addSecretProvider(() => ['SECRET-A-123456']);
  const offB = addSecretProvider(() => ['SECRET-B-123456']);
  t.after(() => { offA(); offB(); });
  assert.equal(redact('用 SECRET-A-123456'), '用 ***');
  assert.equal(redact('用 SECRET-B-123456'), '用 ***');
  offB();
  assert.equal(redact('用 SECRET-A-123456'), '用 ***');
});
