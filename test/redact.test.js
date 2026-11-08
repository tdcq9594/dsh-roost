/**
 * E7 日志脱敏：纯函数回归。
 *
 * 现成方案来自调研对象 `[A]/src/core/redact.js` 的文本正则 + 我们框架
 * `bot/src/runtime.js` 的对象递归；这里锁的是「两种输入形态都盖住、
 * 但不误伤普通中文与 URL」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SENSITIVE_KEY, clearSecrets, redactText, redactValue,
  registerSecret, setSecretProvider,
} from '../src/redact.js';
import { collectSecrets } from '../src/config.js';

test.beforeEach(() => clearSecrets());

test('Authorization / Bearer / token= 一行里全抹掉', () => {
  const line = 'Authorization: Bearer abcdef1234567890 token=ghijkl987654 password: "mnopqr1111"';
  const out = redactText(line);
  assert.ok(!out.includes('abcdef1234567890'), out);
  assert.ok(!out.includes('ghijkl987654'), out);
  assert.ok(!out.includes('mnopqr1111'), out);
  assert.match(out, /\*\*\*/);
});

test('JSON.stringify 出来的 {"apiKey":"…"} 也要盖住（日志参数常是对象）', () => {
  const out = redactText(JSON.stringify({ apiKey: 'sk-live-abcdefghijklmnop', note: '没事' }));
  assert.ok(!out.includes('sk-live-abcdefghijklmnop'), out);
  assert.ok(out.includes('没事'));
});

test('sk- 密钥与 URL 查询参数', () => {
  assert.equal(redactText('key=sk-abcdefghijklmnop1234'), 'key=sk-***');
  assert.equal(redactText('GET https://x/y?access_token=SECRETVALUE123&a=1'),
    'GET https://x/y?access_token=***&a=1');
});

test('普通中文、非敏感参数、不含凭证的 Bearer 短串不被改坏', () => {
  const plain = '她刚才在群里回了一句「今天天气不错」，耗时 1.2 秒';
  assert.equal(redactText(plain), plain);
  assert.equal(redactText('https://x/y?page=2&kw=天气'), 'https://x/y?page=2&kw=天气');
});

test('registerSecret：已知裸串整段替换，短串不注册（免得误伤）', () => {
  registerSecret('short');
  assert.equal(redactText('short'), 'short');
  registerSecret('SUPERSECRET-ABCDEFG');
  assert.equal(redactText('出错啦 SUPERSECRET-ABCDEFG 请检查'), '出错啦 *** 请检查');
});

test('setSecretProvider：配置改了之后自动跟随，不用重新注册', () => {
  let current = ['OLDTOPSECRET123'];
  setSecretProvider(() => current);
  assert.equal(redactText('用了 OLDTOPSECRET123'), '用了 ***');
  current = ['NEWTOPSECRET456'];
  assert.equal(redactText('用了 NEWTOPSECRET456'), '用了 ***');
  assert.ok(redactText('用了 OLDTOPSECRET123').includes('OLDTOPSECRET123'), '旧密钥不该被硬缓存');
  setSecretProvider(null);
});

test('setSecretProvider 抛错时日志照写（旁路不能拖垮主链路）', () => {
  setSecretProvider(() => { throw new Error('读配置炸了'); });
  assert.equal(redactText('一句普通的日志'), '一句普通的日志');
  assert.equal(redactText('Bearer abcdef1234567890'), 'Bearer ***');
  setSecretProvider(null);
});

test('redactValue：字段名掩码 + 递归 + 不改原对象', () => {
  const src = { token: 'abcdef123456', nested: { password: 'ghijkl9876', text: '正常内容' }, list: [1, 'Bearer abcdef1234567890'] };
  const out = redactValue(src);
  assert.equal(out.token, '***');
  assert.equal(out.nested.password, '***');
  assert.equal(out.nested.text, '正常内容');
  assert.equal(out.list[1], 'Bearer ***');
  assert.equal(src.token, 'abcdef123456', '不能改调用方还给别处用的对象');
  assert.equal(SENSITIVE_KEY.test('client_secret'), true);
  assert.equal(SENSITIVE_KEY.test('message'), false);
});

test('redactValue：数组截断、深层截断、Error 取 stack', () => {
  const arr = Array.from({ length: 30 }, (_, i) => i);
  assert.equal(redactValue(arr).length, 20);
  let deep = { v: 1 };
  for (let i = 0; i < 10; i++) deep = { next: deep };
  assert.equal(JSON.stringify(redactValue(deep)).includes('…'), true);
  assert.match(redactValue(new Error('token=abcdef123456')), /token=\*\*\*/);
});

test('redactText 幂等：日志层会过两道，结果不能再被改坏', () => {
  const once = redactText('Bearer abcdef1234567890 token=ghijkl987654');
  assert.equal(redactText(once), once);
  assert.equal(redactText(redactText(once)), once);
});

test('collectSecrets 与 config 的 SECRET_PATHS 共用一份名单', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-redact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const cfg = {
    server: { token: 'SERVERTOKEN123' },
    memory: { embedding: { apiKey: 'EMBKEY123456' } },
    tts: { apiKey: '', gptSovits: { apiKey: '******' }, mimo: { apiKey: 'MIMOKEY123456' } },
  };
  const secrets = collectSecrets(cfg);
  assert.deepEqual(secrets, ['SERVERTOKEN123', 'EMBKEY123456', 'MIMOKEY123456']);
  setSecretProvider(() => collectSecrets(cfg));
  assert.equal(redactText('裸串 SERVERTOKEN123 出现在日志里'), '裸串 *** 出现在日志里');
  setSecretProvider(null);
});

test('补漏：Basic / 全角冒号等号 / URL 编码等号 / PEM / 带点的 sk-', () => {
  assert.ok(!redactText('Authorization: Basic dXNlcjpwYXNzd29yZA==').includes('dXNlcjpwYXNzd29yZA=='));
  assert.ok(!redactText('Authorization: basic dXNlcjpwYXNzd29yZA==').includes('dXNlcjpwYXNzd29yZA=='));
  assert.equal(redactText('用的是 Basic authentication 方式'), '用的是 Basic authentication 方式');
  assert.ok(!redactText('token：QUANJIAOSECRET123').includes('QUANJIAOSECRET123'));
  assert.ok(!redactText('apiKey＝QUANJIAOSECRET456').includes('QUANJIAOSECRET456'));
  assert.ok(!redactText('?token%3DURLENCODED123').includes('URLENCODED123'));
  assert.ok(!redactText('key=sk-proj-abcdefghijklmnop.qrstuv').includes('abcdefghijklmnop'));
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactText(pem), '(私钥已隐藏)');
});

test('redactValue 健壮性：Date / Map / Set / Buffer / BigInt / 抛错的 getter 都不炸', () => {
  assert.match(redactValue(new Date('2026-11-08T00:00:00Z')), /^2026-11-08/);
  assert.deepEqual(redactValue(new Map([['token', 'abcdef123456']])), { token: '***' });
  assert.deepEqual(redactValue(new Set([1, 2])), [1, 2]);
  assert.equal(redactValue(Buffer.from([1, 2, 3])), '<二进制 3 字节>');
  assert.equal(redactValue(10n), '10');
  const bad = {};
  Object.defineProperty(bad, 'boom', { enumerable: true, get() { throw new Error('不许读'); } });
  const out = redactValue({ bad, token: 'abcdef123456' });
  assert.equal(out.token, '***');
  assert.match(String(out.bad), /不可读/, '怪对象不该让整条日志写不出来');
});
