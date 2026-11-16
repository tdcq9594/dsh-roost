/**
 * 机器人自身设置（`/self/*`）的契约。
 *
 * 这条链只走**机器人身份**的官方 OpenAPI（AppID/Secret → access_token），
 * 和开发者后台 `bot.q.qq.com/cgi-bin/v2/*` 那条要网页登录态的链完全分开。
 *
 * 白名单必须写死：`qq.methods` 有 70+ 方法，按 group 字符串过滤等于把
 * 「框架改个分组名就多放行几个方法」的风险留给未来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { SELF_CONFIG_METHODS } from '../src/host.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const HOST = read('../src/host.js');
const CLIENT = read('../client/client.js');
const CAPS = read('../src/roost-capabilities.js');
/** 框架仓是另一个仓库，单独 clone dsh-roost 跑 CI 时不在同级目录 */
const FRAMEWORK_API = new URL('../../bot/src/api.js', import.meta.url);

const EXPECTED = [
  'getMe', 'getGlobalMenu', 'setGlobalMenu',
  'listPanels', 'getPanel', 'createPanel', 'updatePanel',
  'updatePanelTarget', 'deletePanel',
];

test('白名单恰好是这 9 个方法，不多不少', () => {
  assert.ok(SELF_CONFIG_METHODS instanceof Map);
  assert.deepEqual([...SELF_CONFIG_METHODS.keys()], EXPECTED);
});

test('每个方法都有分组、说明和位置参数骨架', () => {
  for (const [name, m] of SELF_CONFIG_METHODS) {
    assert.ok(typeof m.group === 'string' && m.group, `${name} 缺 group`);
    assert.ok(typeof m.desc === 'string' && m.desc, `${name} 缺 desc`);
    assert.ok(['read', 'write', 'danger'].includes(m.risk), `${name} 的 risk 档位不合法`);
    assert.ok(Array.isArray(m.args), `${name} 的 args 必须是位置参数数组`);
    assert.ok(m.args.length <= 12, `${name} 超过 qq.call 的 12 项上限`);
  }
});

test('默认风险档与框架 riskOf 一致：只读不弹确认，删面板是 danger', () => {
  const risk = (n) => SELF_CONFIG_METHODS.get(n)?.risk;
  for (const n of ['getMe', 'getGlobalMenu', 'listPanels', 'getPanel']) {
    assert.equal(risk(n), 'read', `${n} 是 GET，框架判 read`);
  }
  for (const n of ['setGlobalMenu', 'createPanel', 'updatePanel', 'updatePanelTarget']) {
    assert.equal(risk(n), 'write', `${n} 是写但可恢复，框架判 write`);
  }
  assert.equal(risk('deletePanel'), 'danger', 'DELETE 不可逆，框架判 danger');
});

test('白名单里没有越界方法', () => {
  for (const bad of [
    'sendC2C', 'sendGroup', 'config.set', 'deleteChannel',
    'removeMembers', 'uploadLocalFile', 'takeSeq', 'resetSecret',
  ]) {
    assert.equal(SELF_CONFIG_METHODS.has(bad), false, `${bad} 不该进自身设置白名单`);
  }
});

test('白名单里的方法在框架 QQApi 上都真的存在', (t) => {
  if (!existsSync(FRAMEWORK_API)) {
    t.skip('框架仓不在同级目录（单独 clone dsh-roost 跑 CI 时正常）');
    return;
  }
  const src = readFileSync(FRAMEWORK_API, 'utf8');
  for (const name of SELF_CONFIG_METHODS.keys()) {
    assert.match(src, new RegExp(`\\n  ${name}\\(`), `框架 api.js 缺 ${name}()`);
  }
});

test('后端：两条路由都在，/self/qq 三道闸齐全', () => {
  assert.match(HOST, /route\('\/self\/methods'/);
  assert.match(HOST, /route\('\/self\/qq'/);
  assert.match(HOST, /SELF_CONFIG_METHODS\.has\(method\)/, '必须按显式白名单放行');
  assert.match(HOST, /Array\.isArray\(body\?\.args\)/, 'args 必须是数组');
  assert.match(HOST, /body && body\.confirm === true/, '非只读要二次确认');
  assert.match(HOST, /roost\.rpc\('qq\.call', \{ method, args, confirm: need \}\)/,
    'confirm 要透传给框架，args 要按位置参数传');
});

test('后端：没照抄 WebUI 的 params 对象契约', () => {
  const from = HOST.indexOf("route('/self/qq'");
  const seg = HOST.slice(from, from + 3000);
  assert.doesNotMatch(seg, /roost\.rpc\('qq\.call', \{ method, params/,
    '协议层 qq.call 只认 args，传 params 参数会全丢');
  assert.match(seg, /confirm: need/, '框架对 danger 方法自己还要查一次 confirm');
});

test('后端：confirm 判定不用可选链写法', () => {
  const from = HOST.indexOf("route('/self/qq'");
  const seg = HOST.slice(from, from + 3000);
  assert.doesNotMatch(seg, /body\?\.confirm !== true/,
    'security-boundaries.test.js 按这个模式计数锁三个群管路由，多一处会误报');
});

test('AI 工具白名单仍不含 qq.call：只给人从面板点', () => {
  assert.doesNotMatch(CAPS, /\{\s*name:\s*'qq\.call'/, '扩展能力白名单不该放开 qq.call');
});

test('前端：页签、分组、别名、渲染分支都接上了', () => {
  assert.match(CLIENT, /\['bot-self', '自身设置'\]/);
  assert.match(CLIENT, /'bot-self': '自身设置/);
  assert.match(CLIENT, /'connect', 'bot-self', 'chats'/);
  assert.match(CLIENT, /function SelfConfigTab\(/);
  assert.match(CLIENT, /tab === 'bot-self' \? h\(SelfConfigTab/);
  /** 2026-11-16：抽成 `call(name, args, confirm)`，常用按钮与高级台共用一条发送路径 */
  assert.match(CLIENT, /post\('\/self\/qq', \{ method: name, args: a, confirm: needConfirm \}\)/);
  assert.match(CLIENT, /const quick = \(name\) =>/, '常用只读接口要有按钮入口');
});

/**
 * N2（第四轮报告）：这一页原来只有「选方法 + 手写 JSON 参数」一条路，
 * 想看一眼自己现在叫什么，得先知道 `getMe` 的 args 是空数组。
 *
 * 约束比功能重要：**快捷按钮只能放只读接口**。写操作（改菜单、删面板）
 * 一律走折叠的高级台——那里有二次确认，也才有地方逐字核对参数。
 */
test('常用按钮只放只读接口，写操作一律走折叠的高级台', () => {
  const from = CLIENT.indexOf('const QUICK = [');
  assert.ok(from > 0, 'QUICK 表要在');
  /** 表尾是「换行 + 6 空格 + ]」，别用第一个 `]`——每行数组自己的右括号先到 */
  const block = CLIENT.slice(from, CLIENT.indexOf('\n      ]', from));
  const names = [...block.matchAll(/\['(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(names, ['getMe', 'getGlobalMenu', 'listPanels'],
    '想加就只加只读方法；写方法进 QUICK 等于绕过二次确认');

  /** 表挑得对还不够：quick() 自己再拦一道，防止以后有人把写方法塞进来 */
  assert.match(CLIENT, /if \(String\(m0\.risk \|\| 'read'\) !== 'read'\)/,
    'quick() 必须自己判 risk');
  assert.match(CLIENT, /'高级：直接调接口（给开发者）'/, '高级台要还在，且标明是给开发者的');
});

test('前端：页面明说「改名字头像去人设 → 资料」，别和自身设置混淆', () => {
  /* 2026-11-16：原来这句写「昵称、头像…这里不提供」，与新增的「人设 → 资料」页
     正面矛盾（那边能改、还能逐条退回）。改成指路，并把开发者后台那套留在原句里 */
  assert.match(CLIENT, /昵称 \/ 头像 \/ 简介 \/ 菜单文案的现状、授权与逐条退回在「人设 → 资料」/);
  assert.match(CLIENT, /回调地址与 IP 白名单要去开发者后台/);
});
