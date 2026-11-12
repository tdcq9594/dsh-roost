/**
 * 首次接入向导：老用户升级必须重走、完成必须真自测、跳过不算完成。
 *
 * 这三个性质直接决定「升级后是不是哑巴」，不能只靠前端表现来判断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSetupWizard } from '../src/setup-wizard.js';
import { WIZARD_VERSION, DEFAULTS, migrateChannel } from '../src/config.js';

function rig({ cfg = {}, testResult = { ok: true, ms: 3 } } = {}) {
  let cur = structuredClone({ ...DEFAULTS, ...cfg, setup: { ...DEFAULTS.setup, ...(cfg.setup || {}) } });
  const writes = [];
  const calls = { test: 0 };
  const pairing = {
    test: async () => {
      calls.test += 1;
      if (testResult instanceof Error) throw testResult;
      return testResult;
    },
  };
  const w = createSetupWizard({
    cfgOf: () => cur,
    setCfg: (patch) => {
      writes.push(patch);
      cur = { ...cur, ...patch, setup: { ...cur.setup, ...(patch.setup || {}) } };
      return cur;
    },
    pairing,
    log: () => {},
  });
  return { w, writes, calls, cfgOf: () => cur };
}

test('新装和老配置升级都要求走向导（不像 aurabot 那样放行老用户）', () => {
  const fresh = rig();
  assert.equal(fresh.w.state().needed, true);
  assert.equal(fresh.w.state().completed, false);
  assert.equal(fresh.w.state().upgraded, false);

  const old = rig({ cfg: { __raw: { channel: { current: 'qq' }, server: { port: 17321 }, persona: {}, memory: {} } } });
  assert.equal(old.w.state().needed, true, '老配置 channel.current=qq 删掉实现后不能算已完成');
  assert.equal(old.w.state().upgraded, true, '要能识别成升级，向导才好换文案');
});

test('isUpgrade 恒为布尔：配置损坏 / 无 setup 段 / 已配直连的新用户都不误判', () => {
  // 配置读不出来：不能让 upgraded 字段整个消失
  const broken = rig({ cfg: { __raw: null } });
  assert.equal(typeof broken.w.state().upgraded, 'boolean');
  assert.equal(broken.w.state().upgraded, false);

  // 老配置没有 setup 段但有其它内容：应识别成升级
  const old = rig({ cfg: { __raw: { channel: { current: 'qq' }, server: {}, persona: {}, memory: {} } } });
  assert.equal(old.w.state().upgraded, true);

  // 全新装好、已点过一键直连、但还没走完向导：不能因为有 url 就说成升级
  const freshPaired = rig({
    cfg: {
      __raw: { setup: { wizardVersion: 0 }, roostHost: { url: 'http://127.0.0.1:6801' }, server: {}, persona: {} },
      roostHost: { url: 'http://127.0.0.1:6801' },
    },
  });
  assert.equal(freshPaired.w.state().upgraded, false);

  // 已经走过一版向导的老配置，本版只是版本号落后：仍是升级
  const bumped = rig({ cfg: { __raw: { setup: { wizardVersion: 0 }, channel: { current: 'roost' } } } });
  assert.equal(bumped.w.state().upgraded, false, '走过向导就不算「从旧版第一次升级」，但 needed 仍为 true');
  assert.equal(bumped.w.state().needed, true);
});

test('完成向导：后端真跑一次直连自测，通过后写版本号', async () => {
  const r = rig();
  const out = await r.w.done();
  assert.equal(r.calls.test, 1, '必须真自测，不能信前端');
  assert.equal(out.ok, true);
  assert.equal(out.completed, true);
  assert.equal(out.needed, false);
  assert.equal(r.cfgOf().setup.wizardVersion, WIZARD_VERSION);
  assert.ok(r.writes.length > 0, '要真的落盘');
});

test('自测没过就不给完成，也不写版本号', async () => {
  const r = rig({ testResult: new Error('连不上 http://127.0.0.1:6801') });
  const out = await r.w.done();
  assert.equal(out.ok, false);
  assert.equal(out.step, 'selftest');
  assert.match(out.message, /直连自测没通过/);
  assert.equal(r.cfgOf().setup.wizardVersion, 0);
  assert.equal(r.w.state().needed, true);
  assert.equal(r.writes.length, 0, '失败时不该改配置');
});

test('自测返回 ok:false 同样不放行', async () => {
  const r = rig({ testResult: { ok: false, message: 'token 不对' } });
  assert.equal((await r.w.done()).ok, false);
  assert.equal(r.cfgOf().setup.wizardVersion, 0);
});

test('前端谎报完成也不行：done 没有 force 后门', async () => {
  const r = rig({ testResult: new Error('没连上') });
  const out = await r.w.done({ force: true });
  // force 只走 skip，绝不写 completed
  assert.equal(r.cfgOf().setup.wizardVersion, 0);
  assert.equal(out.completed, false);
});

test('暂时跳过：本版不再盖全屏，但不算完成，重新打开能回来', () => {
  const r = rig();
  const skipped = r.w.skip();
  assert.equal(skipped.needed, false, '老版 Roost 用户不能被锁死在向导里');
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.completed, false, '跳过不能冒充完成');
  assert.equal(r.cfgOf().setup.wizardVersion, 0);

  const back = r.w.reopen();
  assert.equal(back.needed, true, '概览页点「重新检查接入」要能回来');
});

test('已经完成过就不再重复自测，也不重复写盘', async () => {
  const r = rig();
  await r.w.done();
  const writes = r.writes.length;
  const calls = r.calls.test;
  const again = await r.w.done();
  assert.equal(again.completed, true);
  assert.equal(r.calls.test, calls, '不该再打一次 RPC');
  assert.equal(r.writes.length, writes, '不该再写一次盘');
});

test('配置迁移：老配置的 qq 归一成 roost，别的值不动', () => {
  const saved = { channel: { current: 'qq' }, setup: { wizardVersion: 0 } };
  migrateChannel(saved);
  assert.equal(saved.channel.current, 'roost');

  const modern = { channel: { current: 'roost' } };
  migrateChannel(modern);
  assert.equal(modern.channel.current, 'roost');

  const empty = {};
  migrateChannel(empty);
  assert.deepEqual(empty, {}, '没有 channel 段的新配置不该被凭空造一个');
});

test('默认值：向导还没走、通道是 roost', () => {
  assert.equal(DEFAULTS.setup.wizardVersion, 0);
  assert.equal(DEFAULTS.setup.wizardSkippedVersion, 0);
  assert.equal(DEFAULTS.channel.current, 'roost');
});
