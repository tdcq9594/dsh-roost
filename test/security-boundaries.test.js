/**
 * 2026-11-14 对抗测试清单 §2 / §3 的回归守门。
 *
 * 这批问题的共性是「单点看着没问题，两处口径不一致就漏」：
 * 发文件用 realpathSync、读页面 / 读界面数据只比字符串；前端弹了确认框、
 * 服务端不校验；vision 的 extId 从请求体自报。所以这里既有静态契约
 * （钉住前后端字段），也有行为断言（钉住真的拦得住）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readUiData } from '../src/ext-ui.js';
import { createGroupAdmin } from '../src/group-admin.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const HOST = read('../src/host.js');
const UI = read('../src/ext-ui.js');
const LLM = read('../src/ext-llm.js');
const CLIENT = read('../client/client.js');
const ADMIN = read('../src/group-admin.js');

test('符号链接：/ext-pages、readUiData 都解真实路径，与 checkExtFile 同口径', () => {
  assert.match(HOST, /realpathSync\(root\)/, '/ext-pages 要解扩展目录的真实路径');
  assert.match(HOST, /realpathSync\(abs\)/, '/ext-pages 要解目标文件的真实路径');
  assert.match(UI, /realpathSync\(abs\)/, 'readUiData 也要解目标文件');
  assert.match(UI, /realpathSync\(root\)/, 'readUiData 也要解根目录');
});

test('readUiData：指向扩展目录外的符号链接被拒', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'roost-symlink-'));
  const extDir = join(base, 'ext');
  const outsideDir = join(base, 'outside');
  const link = join(extDir, 'link');
  try {
    mkdirSync(extDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'ui-data.json'), JSON.stringify([{ title: '宿主配置不该被读到' }]));
    /**
     * 用目录链接而不是文件链接：Windows 上文件 symlink 要开发者模式，
     * junction 不需要特权，realpathSync 一样会解析到目录外。
     */
    try {
      symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('当前系统不允许建目录链接');
      return;
    }
    const r = readUiData({ dir: extDir, spec: { view: { source: { file: 'link/ui-data.json' } } } });
    assert.equal(r.ok, false, '软链指到目录外必须失败');
    assert.match(r.reason, /目录外面|符号链接/);
    assert.deepEqual(r.rows, []);
  } finally {
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ }
  }
});

test('vision 会话 id 从令牌取，不许扩展自报', () => {
  assert.match(HOST, /llmVision\(\{ \.\.\.body, extId: String\(client\?\.extId \?\? ''\) \}\)/,
    'llm.vision hook 要用 client.extId 顶掉请求体');
  assert.match(LLM, /String\(body\?\.extId \|\| 'unknown'\)/, '缺绑定时退回 unknown，别共用空 id');
});

test('群管：三个破坏性路由要服务端强确认，前端每一处都带上', () => {
  for (const path of ['/group/mute', '/group/kick', '/group/join']) {
    assert.ok(HOST.includes(`route('${path}'`), `缺 ${path} 路由`);
  }
  assert.equal((HOST.match(/body\?\.confirm !== true/g) || []).length, 3, '三个路由都要校验 confirm');
  assert.ok(HOST.includes("String(body?.action || 'list') !== 'list'"), 'join 的 list（默认值）是只读，不该要确认');
  /** 前端 4 个 ConfirmLink 回调都要带 confirm:true（不锁格式，只数出现次数） */
  assert.ok((CLIENT.match(/confirm:\s*true/g) || []).length >= 4,
    '禁言 / 踢出 / 通过 / 拒绝四处都要传 confirm:true');
});

test('群管：主人和机器人自己在本地就被挡，不用等官方回 protected', async () => {
  const calls = [];
  const adm = createGroupAdmin({
    rpc: async (m, p) => { calls.push([m, p]); return { ok: true }; },
    protectedTargets: () => ['OWNER_OPENID'],
  });
  const muted = await adm.mute({ groupId: 'g1', targets: ['OWNER_OPENID'], seconds: 60 });
  assert.equal(muted.ok, false);
  assert.equal(muted.reason, 'protected_owner');
  const kicked = await adm.kick({ groupId: 'g1', targets: ['someone', 'OWNER_OPENID'] });
  assert.equal(kicked.ok, false);
  assert.equal(kicked.reason, 'protected_owner');
  assert.equal(calls.length, 0, '挡在本地，一次协议调用都不该发出去');
  /** 没注入保护名单时行为不变，别影响模型层的 qq_mute */
  const plain = createGroupAdmin({ rpc: async () => ({ ok: true }) });
  assert.equal((await plain.mute({ groupId: 'g1', targets: ['u1'], seconds: 10 })).ok, true);
});

test('接线：保护名单由宿主从 ownerId() 注入，不是写死在协议层', () => {
  assert.match(HOST, /protectedTargets: \(\) => \[ownerId\(\)\]/, 'host 要注入主人 openid');
  assert.match(ADMIN, /protected_owner/, '要有本地拒绝原因');
});
