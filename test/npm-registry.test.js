/**
 * npm 源解析（插件侧）。
 *
 * 这个插件有两条下载路径，行为完全不同：
 *   · `npm install` 会自己读 `.npmrc` / `npm_config_registry`，用户配过就好；
 *   · **tgz 直链不经过 npm**，环境变量对它无效——语音引擎那 50 多 MB
 *     硬写 registry.npmjs.org，国内下不动就真的没辙。
 *
 * 所以这里钉住：解析优先级正确、官方源不额外传参、直链候选里有镜像兜底。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OFFICIAL,
  NPM_MIRROR,
  downloadRegistries,
  normRegistry,
  registryArgs,
  resetRegistryCache,
  resolveRegistry,
  tgzUrl,
} from '../src/npm-registry.js';

/** 改环境变量跑一段，跑完还原 */
async function withEnv(patch, fn) {
  const old = {};
  for (const [k, v] of Object.entries(patch)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAN_ENV = { npm_config_registry: undefined, NPM_CONFIG_REGISTRY: undefined };

test('normRegistry：补协议、去尾斜杠，只认 http(s)', () => {
  assert.equal(normRegistry('registry.npmmirror.com'), NPM_MIRROR);
  assert.equal(normRegistry('https://registry.npmjs.org///'), OFFICIAL);
  assert.equal(normRegistry('ftp://x'), '');
  assert.equal(normRegistry(''), '');
  assert.equal(normRegistry(null), '');
});

test('默认（什么都没配）：官方源，且不给 npm 加参数', async () => {
  await withEnv(CLEAN_ENV, () => {
    resetRegistryCache();
    /** 有 .npmrc 的机器上这条会走 npmrc，属于合理行为——只在干净环境断言 */
    const r = resolveRegistry();
    if (r.source === 'default') {
      assert.equal(r.url, OFFICIAL);
      assert.deepEqual(registryArgs(), []);
    }
  });
});

test('override 压过一切：面板里配的源说了算', async () => {
  await withEnv({ npm_config_registry: 'https://env.example.com' }, () => {
    const r = resolveRegistry({ override: 'https://panel.example.com/' });
    assert.equal(r.url, 'https://panel.example.com');
    assert.equal(r.source, 'explicit');
    assert.deepEqual(registryArgs({ override: 'https://panel.example.com' }), [
      '--registry=https://panel.example.com',
    ]);
  });
});

test('环境变量次之：用户 npm config set 过的源要生效', async () => {
  await withEnv({ npm_config_registry: NPM_MIRROR }, () => {
    const r = resolveRegistry();
    assert.equal(r.url, NPM_MIRROR);
    assert.equal(r.source, 'env');
    assert.deepEqual(registryArgs(), [`--registry=${NPM_MIRROR}`]);
  });
});

test('.npmrc 里的 registry= 也认', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-rc-'));
  const oldCwd = process.cwd();
  try {
    writeFileSync(join(dir, '.npmrc'), '# 注释\nregistry=https://rc.example.com/\n', 'utf8');
    process.chdir(dir);
    resetRegistryCache();
    await withEnv(CLEAN_ENV, () => {
      const r = resolveRegistry();
      assert.equal(r.url, 'https://rc.example.com');
      assert.equal(r.source, 'npmrc');
    });
  } finally {
    process.chdir(oldCwd);
    resetRegistryCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('直链候选：官方 + 镜像，去重且顺序稳定', async () => {
  await withEnv(CLEAN_ENV, () => {
    resetRegistryCache();
    const list = downloadRegistries({ override: OFFICIAL });
    assert.deepEqual(list, [OFFICIAL, NPM_MIRROR]);
  });
});

test('直链候选：用户配的源排第一，官方与镜像仍兜底', () => {
  assert.deepEqual(
    downloadRegistries({ override: 'https://npm.internal.corp' }),
    ['https://npm.internal.corp', OFFICIAL, NPM_MIRROR],
  );
});

test('tgzUrl：scoped 包文件名不带 scope，换源只换前缀', () => {
  assert.equal(
    tgzUrl('@andresaya/edge-tts', '1.9.1'),
    `${OFFICIAL}/@andresaya/edge-tts/-/edge-tts-1.9.1.tgz`,
  );
  assert.equal(tgzUrl('ws', '8.18.3', NPM_MIRROR), `${NPM_MIRROR}/ws/-/ws-8.18.3.tgz`);
  assert.equal(tgzUrl('ws', '8.18.3', 'ftp://x'), `${OFFICIAL}/ws/-/ws-8.18.3.tgz`);
});
