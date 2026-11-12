/**
 * 扩展配置（`plugin.json` 的 `config` 声明 → 面板表单 → 落盘 → 子进程 env）。
 *
 * 盯的是会静默出错的几件：
 *  1. 非必填的 object / array 没填被当成「类型错误」，整份保存失败；
 *  2. `secret` 用在 number 上、或嵌进 object 里 —— 前者是没意义的声明，
 *     后者会让值被静默丢弃（`validateObject` 跳过 secret 键）；
 *  3. 用户清空一个 secret 输入框，被当成「覆盖成空串」而不是「清除」；
 *  4. 面板响应里出现密钥明文；
 *  5. launcher 没把配置传下去（面板存了、扩展读不到）。
 *
 * 跑法：node --test test/ext-config.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_TYPES,
  MAX_FIELDS,
  checkValue,
  createExtConfig,
  envOf,
  fillDefaults,
  normalizeConfigSpec,
  secretEnvName,
  validateValues,
} from '../src/ext-config.js';
import { validateManifest } from '../src/ext-registry.js';
import { createExtPanel } from '../src/ext-panel.js';
import { planLaunch } from '../src/ext-launcher.mjs';

function tmp(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-config-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const SPEC = {
  threshold: { type: 'number', label: '阈值', default: 3, min: 1, max: 10, integer: true },
  region: { type: 'select', label: '分区', options: ['热门', { value: '动画', label: '动画区' }], default: '热门' },
  enabled: { type: 'boolean', label: '启用', default: true },
  apiKey: { type: 'string', label: 'Key', secret: true, required: true },
  tags: { type: 'array', label: '标签', items: { type: 'string' }, maxItems: 3 },
  adv: { type: 'object', label: '高级', properties: { n: { type: 'number', default: 1 } } },
};

test('声明：类型与默认值规范化', () => {
  const r = normalizeConfigSpec(SPEC);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.deepEqual(r.spec.map((f) => f.key), ['threshold', 'region', 'enabled', 'apiKey', 'tags', 'adv']);
  assert.equal(r.spec[1].options[1].label, '动画区');
  assert.equal(r.spec[2].default, true);
  assert.equal(r.spec[4].itemsType, 'string');
  assert.equal(r.spec[5].properties[0].default, 1);
});

test('声明：非法项逐条拒收', () => {
  const bad = normalizeConfigSpec({
    'a b': { type: 'string' },
    n: { type: 'number', secret: true },
    p: { type: 'path' },
    s: { type: 'select', options: [] },
    o: { type: 'object', properties: { k: { type: 'string', secret: true } } },
    arr: { type: 'array', items: { type: 'object' } },
  });
  assert.equal(bad.ok, false);
  const all = bad.errors.join('\n');
  assert.match(all, /字段名只能是字母开头/);
  assert.match(all, /secret 只能用于 string/);
  assert.match(all, /type 必须是/);
  assert.match(all, /select 需要非空 options/);
  assert.match(all, /secret 只能放在顶层/);
  assert.match(all, /array\.items\.type/);
  assert.ok(!CONFIG_TYPES.includes('path'), 'path 不在允许类型里');
});

test('声明：字段数上限', () => {
  const many = {};
  for (let i = 0; i < MAX_FIELDS + 1; i++) many[`f${i}`] = { type: 'string' };
  const r = normalizeConfigSpec(many);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(''), /最多 32 个字段/);
});

test('声明：object 子字段也限量，secret 不许写 default', () => {
  const props = {};
  for (let i = 0; i < MAX_FIELDS + 1; i++) props[`f${i}`] = { type: 'string' };
  const r = normalizeConfigSpec({ o: { type: 'object', properties: props } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(''), /properties 最多 32 个字段/);

  /** 声明会原样回给面板，secret 的 default 等于把密钥明文下发 */
  const d = normalizeConfigSpec({ k: { type: 'string', secret: true, default: 'sk-live' } });
  assert.equal(d.ok, false);
  assert.match(d.errors.join(''), /secret 字段不能写 default/);
});

test('默认值：只补缺，object 递归补兄弟键', () => {
  const spec = normalizeConfigSpec(SPEC).spec;
  assert.deepEqual(fillDefaults(spec, {}), {
    threshold: 3, region: '热门', enabled: true, adv: { n: 1 },
  });
  assert.deepEqual(fillDefaults(spec, { threshold: 5 }), {
    threshold: 5, region: '热门', enabled: true, adv: { n: 1 },
  });
  // 部分填过的 object 也要把漏掉的兄弟键补上
  assert.deepEqual(fillDefaults(spec, { adv: { x: 1 } }), {
    threshold: 3, region: '热门', enabled: true, adv: { n: 1 },
  });
});

test('校验：非必填的 array / object 缺席不算错', () => {
  const spec = normalizeConfigSpec(SPEC).spec;
  const r = validateValues(spec, { threshold: '4', enabled: true }, { secretPresent: new Set(['apiKey']) });
  assert.equal(r.ok, true, (r.errors || []).join('；'));
  assert.deepEqual(r.values, { threshold: 4, enabled: true });
});

test('校验：类型 / 边界 / 必填 / 敏感项必填', () => {
  const spec = normalizeConfigSpec(SPEC).spec;
  const r = validateValues(spec, { threshold: 99, region: 'x', enabled: 'no', tags: ['a', 'b', 'c', 'd'] });
  assert.equal(r.ok, false);
  const all = r.errors.join('\n');
  assert.match(all, /不能大于 10/);
  assert.match(all, /只能是 热门 \/ 动画/);
  assert.match(all, /必须是布尔值/);
  assert.match(all, /最多 3 项/);
  assert.match(all, /Key：必填/);

  assert.equal(validateValues(spec, {}, { secretPresent: new Set(['apiKey']) }).ok, true, '敏感项已设置时必填通过');
  assert.equal(validateValues(spec, { threshold: 1.5 }, { secretPresent: new Set(['apiKey']) }).ok, false, 'integer 拒小数');
  assert.equal(validateValues(spec, { threshold: '1' }, { secretPresent: new Set(['apiKey']) }).ok, true, '数字字符串可转');
});

test('checkValue：未填统一返回 empty，不报类型错', () => {
  for (const v of [undefined, null, '', '   ']) {
    for (const type of ['string', 'number', 'select']) {
      const f = { key: 'k', label: 'k', type, options: [{ value: 'a', label: 'a' }], maxLength: 10 };
      assert.equal(checkValue(f, v).empty, true, `${type} 收到 ${JSON.stringify(v)} 应判 empty`);
    }
  }
});

test('env：非敏感拼 JSON，敏感走独立键，键名由宿主生成', () => {
  const spec = normalizeConfigSpec(SPEC).spec;
  const env = envOf(spec, { threshold: 5 }, { apiKey: 'sk-1' });
  assert.equal(env.ROOST_EXT_CONFIG, JSON.stringify({ threshold: 5, region: '热门', enabled: true, adv: { n: 1 } }));
  assert.equal(env.ROOST_EXT_SECRET_APIKEY, 'sk-1');
  assert.ok(!env.ROOST_EXT_CONFIG.includes('sk-1'), '密钥不能进 ROOST_EXT_CONFIG');
  // 缺值时给空串，而不是少一个键
  assert.equal(envOf(spec, {}, {}).ROOST_EXT_SECRET_APIKEY, '');
  assert.equal(secretEnvName('api_key'), 'ROOST_EXT_SECRET_API_KEY');
});

test('存储：非敏感与敏感分文件，清空用空串', (t) => {
  const dir = tmp(t);
  const cfg = createExtConfig({ dir });
  const spec = normalizeConfigSpec(SPEC).spec;
  fs.mkdirSync(join(dir, 'extensions', 'demo'), { recursive: true });

  const r1 = cfg.save('demo', spec, { threshold: 7 }, { apiKey: 'sk-1' });
  assert.equal(r1.ok, true, r1.message);
  assert.equal(cfg.read('demo').threshold, 7);
  assert.equal(cfg.read('demo').region, '热门', '保存时补齐默认值');
  assert.deepEqual(cfg.secretKeys('demo'), ['apiKey']);
  // 明文只在 secrets/<id>.config.json，且不在扩展目录里
  assert.equal(fs.existsSync(join(dir, 'secrets', 'demo.config.json')), true);
  assert.equal(fs.existsSync(join(dir, 'extensions', 'demo', 'secrets.json')), false);
  assert.ok(!JSON.stringify(cfg.read('demo')).includes('sk-1'));

  // 不带 apiKey 的 patch = 不动
  cfg.save('demo', spec, { threshold: 8 });
  assert.equal(cfg.readSecret('demo').apiKey, 'sk-1');

  // '' = 清除
  cfg.save('demo', spec, { threshold: 8 }, { apiKey: '' });
  assert.deepEqual(cfg.secretKeys('demo'), []);

  cfg.clear('demo');
  assert.equal(fs.existsSync(cfg.fileOf('demo')), false);
  assert.equal(fs.existsSync(cfg.secretFileOf('demo')), false);
});

test('清单校验：坏 config 声明让 manifest 整份被拒', () => {
  const base = {
    id: 'demo', serverName: 'demo', name: '演示', description: 'd',
    transport: 'stdio', command: 'node',
  };
  assert.equal(validateManifest({ ...base, config: SPEC }).ok, true);
  const bad = validateManifest({ ...base, config: { n: { type: 'number', secret: true } } });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(''), /config\.n: secret 只能用于 string/);
});

test('面板：configOf 不返回密钥明文，只给「已设置」', (t) => {
  const dir = tmp(t);
  const spec = normalizeConfigSpec(SPEC).spec;
  const registry = {
    configSpecOf: () => spec,
    isForeign: () => false,
    pathOf: () => dir,
  };
  const panel = createExtPanel({ dir, registry, clientStore: { list: () => [], get: () => null } });
  fs.mkdirSync(join(dir, 'extensions', 'demo'), { recursive: true });
  createExtConfig({ dir }).save('demo', spec, {}, { apiKey: 'sk-secret' });

  const r = panel.configOf('demo');
  assert.equal(r.ok, true);
  assert.equal(r.secretSet.apiKey, true);
  assert.equal(r.canEdit, true);
  const dumped = JSON.stringify(r);
  assert.ok(!dumped.includes('sk-secret'), '面板响应不能出现密钥明文');
});

test('面板：扩展不存在时报 not_found，而不是「没有设置项」', (t) => {
  const dir = tmp(t);
  const spec = normalizeConfigSpec(SPEC).spec;
  const registry = {
    configSpecOf: () => spec,
    isForeign: () => false,
    pathOf: () => join(dir, 'extensions', 'demo'),
    read: () => null,
  };
  const panel = createExtPanel({ dir, registry, clientStore: { list: () => [], get: () => null } });
  const r = panel.configOf('demo');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
});

test('面板：saveConfig 只接受声明过的敏感键，用户手写目录只读', (t) => {
  const dir = tmp(t);
  const spec = normalizeConfigSpec(SPEC).spec;
  const foreign = { value: false };
  const registry = { configSpecOf: () => spec, isForeign: () => foreign.value, pathOf: () => dir };
  const panel = createExtPanel({ dir, registry, clientStore: { list: () => [], get: () => null } });
  fs.mkdirSync(join(dir, 'extensions', 'demo'), { recursive: true });

  const r = panel.saveConfig('demo', { threshold: 2 }, { apiKey: 'k', evilKey: 'x' });
  assert.equal(r.ok, true, r.message);
  const saved = createExtConfig({ dir }).readSecret('demo');
  assert.deepEqual(Object.keys(saved), ['apiKey'], '未声明的敏感键不能被写进去');

  const bad = panel.saveConfig('demo', { threshold: 99 }, {});
  assert.equal(bad.ok, false);
  assert.match(bad.message, /不能大于 10/);

  foreign.value = true;
  assert.equal(panel.saveConfig('demo', { threshold: 2 }).reason, 'foreign_readonly');
  assert.equal(panel.configOf('demo').canEdit, false);
});

test('launcher：把配置与密钥注入子进程 env', (t) => {
  const dir = tmp(t);
  const extDir = join(dir, 'extensions', 'demo');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(join(extDir, 'plugin.json'), JSON.stringify({
    id: 'demo', serverName: 'demo', name: '演示', description: 'd',
    transport: 'stdio', command: process.execPath, args: [],
    config: SPEC,
  }));
  const spec = normalizeConfigSpec(SPEC).spec;
  createExtConfig({ dir }).save('demo', spec, { threshold: 6 }, { apiKey: 'sk-9' });

  const plan = planLaunch({
    env: {
      ROOST_EXT_ID: 'demo',
      ROOST_LAUNCHER_DIR: dir,
      ROOST_API_URL: 'http://127.0.0.1:1',
      PATH: '',
    },
  });
  assert.equal(plan.childEnv.ROOST_EXT_ID, 'demo');
  assert.equal(plan.childEnv.ROOST_EXT_SECRET_APIKEY, 'sk-9');
  const conf = JSON.parse(plan.childEnv.ROOST_EXT_CONFIG);
  assert.equal(conf.threshold, 6);
  assert.equal(conf.region, '热门');
  assert.ok(!plan.childEnv.ROOST_EXT_CONFIG.includes('sk-9'));
  // 原有的三个业务变量不能被配置覆盖
  assert.equal(plan.childEnv.ROOST_API_TOKEN, '');
});

test('launcher：配置声明非法时仍然启动（只是没有设置项）', (t) => {
  const dir = tmp(t);
  const extDir = join(dir, 'extensions', 'demo');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(join(extDir, 'plugin.json'), JSON.stringify({
    id: 'demo', serverName: 'demo', name: '演示', description: 'd',
    transport: 'stdio', command: process.execPath, args: [],
    config: { bad: { type: 'number', secret: true } },
  }));
  const plan = planLaunch({
    env: { ROOST_EXT_ID: 'demo', ROOST_LAUNCHER_DIR: dir, ROOST_API_URL: 'http://127.0.0.1:1' },
  });
  assert.equal(plan.childEnv.ROOST_EXT_CONFIG, undefined, '坏声明不注入任何配置');
  assert.equal(plan.childEnv.ROOST_EXT_ID, 'demo', '扩展照样能起来');
});
