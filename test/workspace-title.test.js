/**
 * 默认工作区叫「Roost·QQ」，但只在第一次创建 / 还带着自动名时生效。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_WORKSPACE_TITLE, workspaceTitleFor } from '../src/workspace-title.js';

const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('默认名是 Roost·QQ，不再是目录名 workspace', () => {
  assert.equal(DEFAULT_WORKSPACE_TITLE, 'Roost·QQ');
  /** 第一次创建：DSH 按目录名取的名字，要换成默认名 */
  assert.equal(
    workspaceTitleFor({ currentTitle: 'workspace', dirName: 'workspace' }),
    DEFAULT_WORKSPACE_TITLE,
  );
  /** 还没拿到 title 也按第一次创建处理 */
  assert.equal(workspaceTitleFor({ currentTitle: '', dirName: 'workspace' }), DEFAULT_WORKSPACE_TITLE);
  /** 自定义目录时同理：自动名 = 目录名 */
  assert.equal(
    workspaceTitleFor({ currentTitle: 'MyBot', dirName: 'MyBot' }),
    DEFAULT_WORKSPACE_TITLE,
  );
});

test('用户自己改过名：一个字都不碰', () => {
  assert.equal(workspaceTitleFor({ currentTitle: '我的机器人', dirName: 'workspace' }), '');
  assert.equal(workspaceTitleFor({ currentTitle: 'Roost·QQ', dirName: 'workspace' }), '');
});

test('面板里显式填的名字最大；历史「QQ」也归一到默认名', () => {
  assert.equal(
    workspaceTitleFor({ configuredName: '小栖', currentTitle: 'workspace', dirName: 'workspace' }),
    '小栖',
  );
  assert.equal(workspaceTitleFor({ currentTitle: 'QQ', dirName: 'workspace' }), DEFAULT_WORKSPACE_TITLE);
});

test('只改名字：DEFAULTS.name 仍为空、目录与文件根白名单没动', () => {
  const config = src('src/config.js');
  assert.match(config, /workspace:\s*\{[\s\S]{0,400}?name:\s*''/, '不能把默认名写进 DEFAULTS，否则每次都会盖掉用户改名');
  const host = src('src/host.js');
  assert.ok(host.includes('workspaceTitleFor({'), 'workspaceId 要走纯函数');
  assert.equal(host.includes("? 'workspace' : ''"), false, '旧的历史兼容分支要撤掉');
  assert.ok(host.includes("join(dataDir(), 'workspace')"), '目录仍是 <数据目录>/workspace');
});

test('向导：默认值、改名回落、说明都是 Roost·QQ', () => {
  const client = src('client/client.js');
  assert.ok(client.includes("const DEFAULT_WORKSPACE_TITLE = 'Roost·QQ'"), '前端要有同一份默认名');
  assert.ok(client.includes('r.configured?.name || DEFAULT_WORKSPACE_TITLE'), '向导预填默认名');
  assert.ok(client.includes('title: name.trim() || DEFAULT_WORKSPACE_TITLE'), '改名回落也要换');
  assert.equal(client.includes("name.trim() || 'workspace'"), false, '不许再把名字回落成 workspace');
  const manual = src('docs/USER-MANUAL.md');
  assert.match(manual, /"name":\s*""[\s\S]{0,160}Roost·QQ/, '手册要写清默认名');
});
