/**
 * 本体自更新（`src/update.js`）的测试。
 *
 * 这里**不会真的装包**——真跑一次 installBundle 会把这台机器的开发符号链接
 * 换成真实目录，源码链路当场断掉。所以 `pluginManager` 是假的，
 * 验的是我们自己的判断逻辑：装法检测、版本比较、失败码翻译、
 * 以及那个「不等 24 小时」的豁免项到底改没改对文件。
 *
 * 跑法：node --test test/update.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createUpdater, patchExclude, installKind, findProfileDir, humanFail, ageText, compareVersion, PKG,
} from '../src/update.js';

const YAML = `# pnpm 的供应链保护配置
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - dsh-roost@0.3.2 || 0.3.3 || 0.5.13
  - some-other-pkg@1.0.0
# 下面还有别的键
strictPeerDependencies: false
`;

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'roost-update-'));
  return { d, done: () => { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {} } };
}

/** 造一个「真实目录」装的 profile */
function profileReal(root) {
  const p = join(root, 'profile');
  mkdirSync(join(p, 'node_modules', PKG), { recursive: true });
  return p;
}

function fakeCtx({ pm } = {}) {
  return { get: (name) => (name === 'pluginManager' ? (pm ?? null) : null) };
}

function fakeFetch(latest, { publishedAgoMs = 0, fail = false } = {}) {
  return async () => {
    if (fail) throw new Error('网络断了');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        'dist-tags': { latest },
        time: { [latest]: new Date(Date.now() - publishedAgoMs).toISOString() },
      }),
    };
  };
}

/* ---------------- 纯函数 ---------------- */

test('版本比较：按数字比，不按字符串比', () => {
  assert.equal(compareVersion('0.10.10', '0.10.9'), 1);
  assert.equal(compareVersion('0.10.7', '0.10.6'), 1);
  assert.equal(compareVersion('v0.10.7', '0.10.7'), 0);
});

/**
 * 失败码翻译。
 *
 * 键名必须是 DSH 的 `error.code` / `refused.problem` 里真实存在的值。
 * 以前这里用的是 `packageResult.code`（不存在的字段）里编出来的码——
 * 测试一直绿，线上一次都没命中过，用户只能看到兜底文案。
 */
test('失败码翻译：用户能自己解决的几种要说清下一步', () => {
  assert.match(humanFail('already-installed'), /重启 DSH/);
  assert.match(humanFail('incompatible-version'), /升级 DSH/);
  assert.match(humanFail('not-removable'), /不能卸载/);
  assert.match(humanFail('weird-code-123'), /weird-code-123/, '没见过的码要原样带出来，方便搜');
  assert.match(humanFail(''), /本地什么都没动/);
  // 真实场景：error.code 往往只是 operation-error，可行动信息在 packageResult.kind
  assert.match(humanFail('operation-error', { kind: 'network', failedAt: 'registry' }), /网络/);
  assert.match(humanFail('', { kind: 'permission' }), /写权限/);
  assert.match(humanFail('', { kind: 'disk-full' }), /磁盘/);
});

test('发布时长：分钟 / 小时 / 天三档', () => {
  assert.equal(ageText(30_000), '刚发布');
  assert.equal(ageText(30 * 60_000), '发布 30 分钟前');
  assert.equal(ageText(5 * 3600_000), '发布 5 小时前');
  assert.equal(ageText(72 * 3600_000), '发布 3 天前');
});

/* ---------------- 豁免项（改 pnpm-workspace.yaml） ---------------- */

test('豁免：清掉旧的 dsh-roost 条目，只留最新一条，别的包和注释都不动', () => {
  const r = patchExclude(YAML, PKG, '0.10.7');
  assert.equal(r.changed, true);
  assert.match(r.text, /- dsh-roost@0\.10\.7\n/);
  assert.doesNotMatch(r.text, /0\.3\.2/, '旧的 dsh-roost 条目要清掉，不然越攒越长');
  assert.match(r.text, /- some-other-pkg@1\.0\.0/, '别的包的豁免一个不能动');
  assert.match(r.text, /^# pnpm 的供应链保护配置$/m, '注释要原样留着');
  assert.match(r.text, /^strictPeerDependencies: false$/m);
});

test('豁免：文件里没有这个键时整块追加，不碰原有内容', () => {
  const src = 'minimumReleaseAge: 1440\n';
  const r = patchExclude(src, PKG, '0.10.7');
  assert.equal(r.changed, true);
  assert.match(r.text, /^minimumReleaseAge: 1440$/m);
  assert.match(r.text, /minimumReleaseAgeExclude:\n {2}- dsh-roost@0\.10\.7/);
});

test('豁免：已经写好了就不重复改（避免每次点都动一遍文件）', () => {
  const first = patchExclude(YAML, PKG, '0.10.7').text;
  const again = patchExclude(first, PKG, '0.10.7');
  assert.equal(again.changed, false);
});

test('豁免：新版本会替换旧版本，不会两条并存', () => {
  const a = patchExclude(YAML, PKG, '0.10.7').text;
  const b = patchExclude(a, PKG, '0.10.8').text;
  assert.match(b, /- dsh-roost@0\.10\.8/);
  assert.doesNotMatch(b, /0\.10\.7/);
  assert.equal((b.match(/dsh-roost@/g) || []).length, 1);
});

/* ---------------- 装法检测 ---------------- */

test('装法：真实目录 → real；没有 → unknown', () => {
  const { d, done } = tmp();
  try {
    assert.equal(installKind(profileReal(d)), 'real');
    assert.equal(installKind(join(d, 'nowhere')), 'unknown');
  } finally {
    done();
  }
});

test('装法：符号链接 → linked（开发机必须挡住自更新）', () => {
  const { d, done } = tmp();
  try {
    const p = join(d, 'profile');
    const src = join(d, 'src-pkg');
    mkdirSync(join(p, 'node_modules'), { recursive: true });
    mkdirSync(src, { recursive: true });
    try {
      // Windows 上 junction 不需要管理员权限，用它能造出真正的符号链接
      symlinkSync(src, join(p, 'node_modules', PKG), 'junction');
    } catch {
      return; // 环境不允许建链接，跳过这条（不假装通过）
    }
    assert.equal(installKind(p), 'linked');
  } finally {
    done();
  }
});

test('profile 目录：往上找 pnpm-workspace.yaml', () => {
  const { d, done } = tmp();
  try {
    const p = join(d, 'profiles', 'desktop');
    mkdirSync(join(p, 'node_modules', PKG, 'src'), { recursive: true });
    writeFileSync(join(p, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 1440\n', 'utf8');
    assert.equal(findProfileDir(join(p, 'node_modules', PKG, 'src')), p);
  } finally {
    done();
  }
});

/* ---------------- check ---------------- */

test('检查：能读出最新版和发布时长，冷却期内要标出来', async () => {
  const { d, done } = tmp();
  try {
    const u = createUpdater({
      ctx: fakeCtx({ pm: { installBundle: async () => ({ application: 'success' }) } }),
      profileDir: profileReal(d),
      fetchImpl: fakeFetch('99.0.0', { publishedAgoMs: 30 * 60_000 }),
    });
    const r = await u.check();
    assert.equal(r.latest, '99.0.0');
    assert.equal(r.hasUpdate, true);
    assert.equal(r.canSelf, true, '真实目录 + 有 pluginManager 才能自更新');
    assert.equal(r.cooling, true, '发布 30 分钟，在 24 小时冷却期内');
    assert.match(r.coolingLeftText, /还差 24 小时|还差 2[34] 小时/);
  } finally {
    done();
  }
});

test('检查：查不到最新版也返回 200，带 error 说明（断网不该让整块变错误页）', async () => {
  const { d, done } = tmp();
  try {
    const u = createUpdater({
      ctx: fakeCtx({ pm: {} }),
      profileDir: profileReal(d),
      fetchImpl: fakeFetch('', { fail: true }),
    });
    const r = await u.check();
    assert.equal(r.ok, true);
    assert.equal(r.latest, '');
    assert.match(r.error, /网络断了/);
    assert.equal(r.hasUpdate, false);
  } finally {
    done();
  }
});

test('检查：符号链接装法不给更新按钮', async () => {
  const { d, done } = tmp();
  try {
    const u = createUpdater({
      ctx: fakeCtx({ pm: {} }),
      profileDir: join(d, 'nowhere'),
      fetchImpl: fakeFetch('99.0.0'),
    });
    const r = await u.check();
    assert.equal(r.kind, 'unknown');
    assert.equal(r.canSelf, false);
  } finally {
    done();
  }
});

/* ---------------- self ---------------- */

test('自更新：符号链接装法直接拒绝，不能把开发链路搞断', async () => {
  const { d, done } = tmp();
  try {
    const p = join(d, 'profile');
    const src = join(d, 'src-pkg');
    mkdirSync(join(p, 'node_modules'), { recursive: true });
    mkdirSync(src, { recursive: true });
    try {
      symlinkSync(src, join(p, 'node_modules', PKG), 'junction');
    } catch {
      return;
    }
    let called = false;
    const u = createUpdater({
      ctx: fakeCtx({ pm: { installBundle: () => { called = true; } } }),
      profileDir: p,
      fetchImpl: fakeFetch('99.0.0'),
    });
    const r = await u.self();
    assert.equal(r.ok, false);
    assert.equal(r.code, 'linked');
    assert.match(r.message, /符号链接/);
    assert.equal(called, false, '一次 installBundle 都不能调');
  } finally {
    done();
  }
});

test('自更新：DSH 没有 pluginManager 时降级，不硬来', async () => {
  const { d, done } = tmp();
  try {
    const u = createUpdater({ ctx: fakeCtx({ pm: null }), profileDir: profileReal(d), fetchImpl: fakeFetch('99.0.0') });
    const r = await u.self();
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no-manager');
    assert.match(r.message, /手动更新/);
  } finally {
    done();
  }
});

test('自更新：已经是最新版就不装（别让 DSH 报 already-installed）', async () => {
  const { d, done } = tmp();
  try {
    let called = false;
    const u = createUpdater({
      ctx: fakeCtx({ pm: { installBundle: async () => { called = true; } } }),
      profileDir: profileReal(d),
      fetchImpl: fakeFetch('0.0.1'),
    });
    const r = await u.self();
    assert.equal(r.ok, true);
    assert.equal(r.already, true);
    assert.equal(called, false, '已经是最新就不该调 installBundle');
  } finally {
    done();
  }
});

test('自更新：装成功后必须提示重启，并如实报告实际装到的版本', async () => {
  const { d, done } = tmp();
  try {
    const calls = [];
    const u = createUpdater({
      ctx: fakeCtx({
        pm: {
          installBundle: async (spec, opts) => {
            calls.push({ spec, opts });
            return { application: 'success', version: '99.0.0' };
          },
        },
      }),
      profileDir: profileReal(d),
      fetchImpl: fakeFetch('99.0.0'),
    });
    const r = await u.self();
    assert.equal(r.ok, true);
    assert.equal(r.version, '99.0.0');
    assert.equal(r.downgraded, false);
    assert.match(r.message, /重启 DSH/);
    assert.equal(calls[0].spec, 'dsh-roost@99.0.0', '包名写死，不接受任意包');
    assert.equal(calls[0].opts.saveExact, true);
  } finally {
    done();
  }
});

test('自更新：请求 99.0.0 却装到 0.10.6 时要明说是降级，不能假装成功', async () => {
  const { d, done } = tmp();
  try {
    const u = createUpdater({
      ctx: fakeCtx({ pm: { installBundle: async () => ({ application: 'success', version: '0.10.6' }) } }),
      profileDir: profileReal(d),
      fetchImpl: fakeFetch('99.0.0', { publishedAgoMs: 10 * 60_000 }),
    });
    const r = await u.self();
    assert.equal(r.ok, true);
    assert.equal(r.downgraded, true);
    assert.equal(r.version, '0.10.6');
    assert.match(r.message, /降级|不满 24 小时/);
  } finally {
    done();
  }
});

/**
 * 真实失败形态：`application: 'failed'` + `error.code` + `packageResult.kind`。
 *
 * 「更新失败，本地什么都没动」这句兜底以前几乎每次都会出现——
 * 因为代码去读 `packageResult.code`（没有这个字段），拿到的永远是空。
 */
test('自更新：失败要翻译成人话，并且说明本地什么都没动', async () => {
  const { d, done } = tmp();
  try {
    const u = createUpdater({
      ctx: fakeCtx({
        pm: {
          installBundle: async () => ({
            changed: false,
            application: 'failed',
            error: { code: 'operation-error', diagnostic: 'ERR_PNPM_FETCH_404  dsh-roost@99.0.0' },
            packageResult: { exitCode: 1, output: 'ERR_PNPM_FETCH_404', kind: 'network', logPath: '/tmp/x.log' },
            failedAt: 'registry',
            registries: ['https://registry.npmjs.org'],
          }),
        },
      }),
      profileDir: profileReal(d),
      fetchImpl: fakeFetch('99.0.0'),
    });
    const r = await u.self();
    assert.equal(r.ok, false);
    assert.equal(r.code, 'operation-error');
    assert.match(r.message, /网络/, '要把 packageResult.kind 翻成人话，光有 error.code 不够');
    assert.match(r.message, /registry/, 'failedAt 要说明卡在哪一段');
    assert.equal(r.detail.kind, 'network');
    assert.match(r.detail.diagnostic, /ERR_PNPM_FETCH_404/, '诊断原文要留着，别丢');
    assert.equal(r.detail.logPath, '/tmp/x.log');
  } finally {
    done();
  }
});

/**
 * DSH 的 `application` 里**没有 `success`**：成功是 `applied`。
 *
 * 这一条就是"每次更新都提示失败"的回归测试——把 applied 当失败的话会红。
 */
test('自更新：application=applied 算成功，不能报失败', async () => {
  const { d, done } = tmp();
  try {
    const u = createUpdater({
      ctx: fakeCtx({
        pm: { installBundle: async () => ({ changed: true, application: 'applied', bundle: { version: '99.0.0' } }) },
      }),
      profileDir: profileReal(d),
      fetchImpl: fakeFetch('99.0.0'),
    });
    const r = await u.self();
    assert.equal(r.ok, true, 'applied 是成功，不是失败');
    assert.equal(r.version, '99.0.0', '版本在 bundle.version 里');
    assert.equal(r.downgraded, false);
  } finally {
    done();
  }
});

/** `restart-required` 也是成功，只是要重启 */
test('自更新：application=restart-required 算成功，并说明为什么必须重启', async () => {
  const { d, done } = tmp();
  try {
    const u = createUpdater({
      ctx: fakeCtx({
        pm: {
          installBundle: async () => ({
            changed: true,
            application: 'restart-required',
            restartReason: 'no-hmr',
            bundle: { version: '99.0.0' },
          }),
        },
      }),
      profileDir: profileReal(d),
      fetchImpl: fakeFetch('99.0.0'),
    });
    const r = await u.self();
    assert.equal(r.ok, true);
    assert.equal(r.restart, true);
    assert.equal(r.restartReason, 'no-hmr');
    assert.match(r.message, /重启 DSH/);
  } finally {
    done();
  }
});

/**
 * 另一种返回形态：`{ status:'refused', problem }`。
 *
 * 只认 `application` 的话，already-installed 这种"连 pnpm 都没跑"的拒绝
 * 会落到兜底文案，用户看不出"其实已经装过了"。
 */
test('自更新：refused 形态要按 problem 翻译，不当成未知失败', async () => {
  const { d, done } = tmp();
  try {
    const u = createUpdater({
      ctx: fakeCtx({
        pm: {
          installBundle: async () => ({
            status: 'refused',
            problem: 'already-installed',
            reason: 'dsh-roost@99.0.0 is already installed',
          }),
        },
      }),
      profileDir: profileReal(d),
      fetchImpl: fakeFetch('99.0.0'),
    });
    const r = await u.self();
    assert.equal(r.ok, false);
    assert.equal(r.code, 'already-installed');
    assert.match(r.message, /已经装过/);
    assert.match(r.detail.diagnostic, /already installed/);
  } finally {
    done();
  }
});

/**
 * 用户配了镜像就得用镜像。
 *
 * `pluginManager.registries()` 是 `async`，返回值还被 remote 层包成
 * `{ ok, value: { registry, fallbackRegistries } }`。以前这里当同步数组取，
 * 拿到的永远是 Promise → 一律退回官方 registry.npmjs.org（国内必超时）。
 */
test('检查：用 DSH 配的 registry，而不是永远官方源', async () => {
  const { d, done } = tmp();
  try {
    let asked = '';
    const u = createUpdater({
      ctx: fakeCtx({
        pm: {
          installBundle: async () => ({ application: 'applied' }),
          registries: async () => ({
            ok: true,
            value: { registry: 'https://registry.npmmirror.com', fallbackRegistries: [], resolved: null },
          }),
        },
      }),
      profileDir: profileReal(d),
      fetchImpl: async (url) => {
        asked = url;
        return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '99.0.0' }, time: {} }) };
      },
    });
    await u.check();
    assert.match(asked, /registry\.npmmirror\.com/, '必须去问用户配的源');
    assert.doesNotMatch(asked, /registry\.npmjs\.org/);
  } finally {
    done();
  }
});

/** 老形状（直接返回数组）也要认，别因为 DSH 换过结构就退回官方 */
test('检查：registries() 直接给数组时也能取到第一个', async () => {
  const { d, done } = tmp();
  try {
    let asked = '';
    const u = createUpdater({
      ctx: fakeCtx({ pm: { installBundle: async () => ({}), registries: async () => ['https://mirror.example.com'] } }),
      profileDir: profileReal(d),
      fetchImpl: async (url) => {
        asked = url;
        return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '99.0.0' }, time: {} }) };
      },
    });
    await u.check();
    assert.match(asked, /mirror\.example\.com/);
  } finally {
    done();
  }
});

/**
 * 查不到最新版不该把人堵死。
 *
 * `check()` 只是个前置；装的时候 pnpm 自己解析 `latest` 标签。
 * 以前这里直接 return「查不到最新版」，于是 registry 一超时用户连试都试不了。
 */
test('自更新：查不到最新版时，仍按 latest 标签尝试安装', async () => {
  const { d, done } = tmp();
  try {
    let spec = '';
    const u = createUpdater({
      ctx: fakeCtx({
        pm: {
          installBundle: async (s) => {
            spec = s;
            return { changed: true, application: 'applied', bundle: { version: '1.2.3' } };
          },
        },
      }),
      profileDir: profileReal(d),
      // 拉 packument 直接失败：模拟 registry 超时
      fetchImpl: async () => { throw new Error('The operation was aborted due to timeout'); },
    });
    const info = await u.check();
    assert.equal(info.unknownLatest, true);
    assert.equal(info.hasUpdate, false, '拿不到 latest 时不知道有没有新版');

    const r = await u.self();
    assert.equal(r.ok, true, '查不到版本号不等于不能装');
    assert.equal(spec, 'dsh-roost@latest', '交给 pnpm 解析 latest');
    assert.equal(r.version, '1.2.3');
    assert.match(r.message, /重启 DSH/);
  } finally {
    done();
  }
});

/**
 * 「装完没重启」时，磁盘版本已经是最新，`hasUpdate` 必须变 false。
 *
 * 以前比的是运行中的 `own`（模块加载时的常量），装完永远是"还有新版"，
 * 按钮一直挂着，用户再点一次必然撞 already-installed。
 */
test('检查：装好但没重启时，不再提示有新版，而是提示重启', async () => {
  const { d, done } = tmp();
  try {
    const p = profileReal(d);
    writeFileSync(join(p, 'node_modules', PKG, 'package.json'), JSON.stringify({ name: PKG, version: '99.0.0' }), 'utf8');
    const u = createUpdater({
      ctx: fakeCtx({ pm: { installBundle: async () => ({ application: 'applied' }) } }),
      profileDir: p,
      fetchImpl: fakeFetch('99.0.0'),
    });
    const info = await u.check();
    assert.equal(info.installed, '99.0.0', '要报出磁盘上装着的版本');
    assert.equal(info.hasUpdate, false, '磁盘已是最新，就不该再提示有新版');
    assert.equal(info.pendingRestart, true, '磁盘比运行中新，属于"待重启"');

    const r = await u.self();
    assert.equal(r.already, true);
    assert.match(r.message, /重启 DSH/);
  } finally {
    done();
  }
});

test('自更新：installBundle 抛异常也不崩，返回结构化失败', async () => {
  const { d, done } = tmp();
  try {
    const u = createUpdater({
      ctx: fakeCtx({ pm: { installBundle: async () => { throw new Error('pnpm 挂了'); } } }),
      profileDir: profileReal(d),
      fetchImpl: fakeFetch('99.0.0'),
    });
    const r = await u.self();
    assert.equal(r.ok, false);
    assert.equal(r.code, 'throw');
    assert.match(r.message, /pnpm 挂了/);
  } finally {
    done();
  }
});

test('「不等 24 小时」：先写豁免再装，写之前备份', async () => {
  const { d, done } = tmp();
  try {
    const p = profileReal(d);
    const yaml = join(p, 'pnpm-workspace.yaml');
    writeFileSync(yaml, YAML, 'utf8');

    const u = createUpdater({
      ctx: fakeCtx({ pm: { installBundle: async () => ({ application: 'success', version: '99.0.0' }) } }),
      profileDir: p,
      fetchImpl: fakeFetch('99.0.0', { publishedAgoMs: 60 * 60_000 }), // 发布 1 小时，在冷却期
    });
    const r = await u.self({ fresh: true });
    assert.equal(r.ok, true);
    assert.ok(r.exemption?.changed, '应该写了豁免项');
    assert.ok(existsSync(yaml + '.roost-bak'), '改之前要备份');
    assert.equal(readFileSync(yaml + '.roost-bak', 'utf8'), YAML, '备份必须是原样内容');
    const after = readFileSync(yaml, 'utf8');
    assert.match(after, /- dsh-roost@99\.0\.0/);
    assert.match(after, /- some-other-pkg@1\.0\.0/, '别的包不能被顺手删掉');
  } finally {
    done();
  }
});

test('「不等 24 小时」：不在冷却期就不该动那个文件', async () => {
  const { d, done } = tmp();
  try {
    const p = profileReal(d);
    const yaml = join(p, 'pnpm-workspace.yaml');
    writeFileSync(yaml, YAML, 'utf8');
    const u = createUpdater({
      ctx: fakeCtx({ pm: { installBundle: async () => ({ application: 'success', version: '99.0.0' }) } }),
      profileDir: p,
      fetchImpl: fakeFetch('99.0.0', { publishedAgoMs: 72 * 3600_000 }), // 三天前，早过冷却期
    });
    const r = await u.self({ fresh: true });
    assert.equal(r.exemption, null);
    assert.equal(readFileSync(yaml, 'utf8'), YAML, '没在冷却期就别碰 DSH 的配置文件');
  } finally {
    done();
  }
});
