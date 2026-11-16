/**
 * 扩展市场的「网络」与「并发」两件事。
 *
 * 面板上曾经只显示一个 `fetch failed` —— undici 的兜底文案，真正的原因
 * 藏在 `e.cause.code` 里。这一组守的是：
 *   · 常见网络错误码都翻成人话，且带主机名
 *   · 网络错误重试一次，HTTP 状态码错误不重试（重试也一样，白让用户等）
 *   · 同一个 id 不能同时装两次 / 装着的时候不能卸
 *
 * 跑法：node --test test/ext-market-net.test.js
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createExtRegistry } from '../src/ext-registry.js';
import { createExtMarket, describeFetchError, defaultFetchText } from '../src/ext-market.js';

const HOMES = [];
after(() => {
  for (const d of HOMES) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  }
});
function tmpHome() {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-market-net-'));
  HOMES.push(d);
  return d;
}

/** 造一个带 cause.code 的 undici 风格错误 */
function netError(code) {
  const e = new TypeError('fetch failed');
  e.cause = { code };
  return e;
}

// ------------------------------------------------------------ 错误翻译

test('N1 网络错误码都翻成人话，并带上主机名', () => {
  const url = 'https://raw.githubusercontent.com/x/y/index.json';
  const cases = [
    ['ENOTFOUND', /域名解析不出来/],
    ['EAI_AGAIN', /DNS 查询超时/],
    ['ECONNREFUSED', /连接被拒绝/],
    ['ECONNRESET', /连接被重置/],
    ['ETIMEDOUT', /连接超时/],
    ['UND_ERR_CONNECT_TIMEOUT', /连接超时/],
    ['UND_ERR_HEADERS_TIMEOUT', /等响应头超时/],
    ['UND_ERR_SOCKET', /连接被对端关闭/],
    ['CERT_HAS_EXPIRED', /TLS 证书过期/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /TLS 证书不可信/],
  ];
  for (const [code, re] of cases) {
    const msg = describeFetchError(netError(code), { url });
    assert.match(msg, re, `${code} 该翻成：${msg}`);
    assert.match(msg, /raw\.githubusercontent\.com/, '要带主机名，否则用户不知道是哪个地址');
  }
});

test('N2 代理这条要给出口径：Node 的 fetch 不读系统代理', () => {
  const msg = describeFetchError(netError('ECONNREFUSED'), { url: 'https://a.example/x' });
  assert.match(msg, /不读系统代理/, '否则用户只会去反复开关系统代理');
});

test('N3 超时单独说，别混进「连接超时」', () => {
  const e = new Error('This operation was aborted');
  e.name = 'TimeoutError';
  const msg = describeFetchError(e, { url: 'https://a.example/x', timeoutMs: 30_000 });
  assert.match(msg, /请求超时/);
  assert.match(msg, /30 秒/);
});

test('N4 认不出的错误也要有兜底文案，不能回一句 fetch failed', () => {
  const msg = describeFetchError(new TypeError('fetch failed'), { url: 'https://a.example/x' });
  assert.match(msg, /网络请求失败/);
  assert.match(msg, /a\.example/);
});

// ------------------------------------------------------------ 重试

test('N5 网络错误重试一次（长连接失效换一条就好）', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw netError('UND_ERR_SOCKET');
  };
  await assert.rejects(
    () => defaultFetchText('http://127.0.0.1/index.json', {}, {
      fetchImpl, waitFn: async () => {},
    }),
    /连接被对端关闭/,
  );
  assert.equal(calls, 2, '一次原始 + 一次重试');
});

test('N6 HTTP 状态码不重试（重试也一样，只是让用户多等一轮）', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 404, text: async () => '' };
  };
  await assert.rejects(
    () => defaultFetchText('http://127.0.0.1/index.json', {}, {
      fetchImpl, waitFn: async () => {},
    }),
    /HTTP 404/,
  );
  assert.equal(calls, 1, '4xx 不该重试');
});

test('N7 第二次成功就正常返回，不因为第一次失败就放弃', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw netError('ECONNRESET');
    return { ok: true, status: 200, text: async () => '{"plugins":[]}' };
  };
  const body = await defaultFetchText('http://127.0.0.1/index.json', {}, {
    fetchImpl, waitFn: async () => {},
  });
  assert.equal(body, '{"plugins":[]}');
  assert.equal(calls, 2);
});

// ------------------------------------------------------------ 并发锁

function rig({ download } = {}) {
  const dir = tmpHome();
  const registry = createExtRegistry({ dir });
  const index = JSON.stringify({
    repo: 'o/r', branch: 'main',
    plugins: [{ id: 'bili', kind: 'dsh-extension', name: 'B站', path: 'plugins/bili', sha256: 'a'.repeat(64) }],
  });
  /**
   * 可控闸门：默认让下载「卡住」以模拟正在安装。
   *
   * 不用 `new Promise(() => {})` —— 永不 settle 的 promise 会一直挂在事件循环里，
   * 测试进程退出时容易被报成 unhandled rejection，也会让 `install` 的 finally
   * 永远不执行。`release()` 让那条流程走完（必然失败于哈希不符，catch 掉即可）。
   */
  let release;
  const gate = new Promise((r) => { release = r; });
  const market = createExtMarket({
    dir, registry,
    fetchText: async () => index,
    download: download ?? (() => gate),
    log: { info: () => {}, warn: () => {} },
  });
  return { dir, registry, market, release };
}

test('N8 同一个 id 不能同时装两次（会抢同一个暂存目录）', async () => {
  const { market, release } = rig();
  const first = market.install('bili');
  const second = await market.install('bili');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'busy');
  assert.match(second.message, /正在安装/);
  /** 放行那条卡住的流程并等它结束，别留悬挂 promise */
  release();
  await first.catch(() => {});
});

test('N9 装着的时候不许卸（卸载会删掉刚 rename 上来的目录）', async () => {
  const { market, release } = rig();
  const first = market.install('bili');
  const r = market.remove('bili');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'busy');
  assert.match(r.message, /正在安装/);
  release();
  await first.catch(() => {});
});

test('N10 装完之后锁要释放（否则这个扩展再也装不了）', async () => {
  const dir = tmpHome();
  const registry = createExtRegistry({ dir });
  const index = JSON.stringify({
    repo: 'o/r', branch: 'main',
    plugins: [{ id: 'bili', kind: 'dsh-extension', name: 'B站', path: 'plugins/bili', sha256: 'a'.repeat(64) }],
  });
  let fail = true;
  const market = createExtMarket({
    dir, registry,
    fetchText: async () => index,
    download: async () => {
      if (fail) throw new Error('下载中断');
      return 0;
    },
    log: { info: () => {}, warn: () => {} },
  });
  const a = await market.install('bili');
  assert.equal(a.ok, false, '第一次失败');
  fail = false;
  /** 锁没释放的话，这里会拿到 busy 而不是「哈希不符」（下载返回 0 字节，必然对不上） */
  const b = await market.install('bili');
  assert.notEqual(b.reason, 'busy', '失败之后锁必须释放');
});
