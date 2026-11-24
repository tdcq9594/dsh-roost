// GPT-SoVITS 一键启动：认目录、读权重版本、猜角色名、找参考音频。
//
// 这些函数都只读文件系统，所以能直接测。真正 spawn 进程那部分不在这里测
// （起个 python 跑两分钟，测试不该干这个），只测「参数不对时会不会乱起」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createGptSovits,
  findRefAudio,
  guessCharacter,
  readCustomSection,
  scanModels,
  decideSwitch,
  buildWeightUrls,
  applyWeights,
  weightReadyConfig,
} from '../src/gpt-sovits.js';

/** 真实 tts_infer.yaml 的形状（含 `\uXXXX` 转义，GPT-SoVITS 就是这么写的） */
const SAMPLE_YAML = `custom:
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
  device: cuda
  is_half: true
  t2s_weights_path: "GPT_weights_v2ProPlus/\\u89D2\\u8272A-e15.ckpt"
  version: v2ProPlus
  vits_weights_path: "SoVITS_weights_v2ProPlus/\\u89D2\\u8272A_e8_s200.pth"
v1:
  device: cpu
  version: v1
`;

function makeInstall({ api = 'api_v2.py', python = true, yaml = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-gpt-'));
  if (api) writeFileSync(join(dir, api), '# fake\n');
  if (python) {
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    writeFileSync(join(dir, 'runtime', 'python.exe'), '');
  }
  if (yaml) {
    mkdirSync(join(dir, 'GPT_SoVITS', 'configs'), { recursive: true });
    writeFileSync(join(dir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'), SAMPLE_YAML);
  }
  return dir;
}

test('读 tts_infer.yaml：只取 custom 段，并解开 \\uXXXX', () => {
  const dir = makeInstall();
  const custom = readCustomSection(join(dir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'));
  assert.equal(custom.device, 'cuda');
  assert.equal(custom.version, 'v2ProPlus');
  // \u89D2\u8272 就是「角色」——GPT-SoVITS 会把中文写成这种转义形式
  assert.equal(custom.t2s_weights_path, 'GPT_weights_v2ProPlus/角色A-e15.ckpt');
  assert.equal(custom.vits_weights_path, 'SoVITS_weights_v2ProPlus/角色A_e8_s200.pth');
});

test('猜角色名：从权重文件名里剥掉 epoch/step 后缀', () => {
  assert.equal(guessCharacter('GPT_weights_v2ProPlus/角色A-e15.ckpt'), '角色A');
  assert.equal(guessCharacter('SoVITS_weights_v2ProPlus/角色A_e8_s200.pth'), '角色A');
  assert.equal(guessCharacter('GPT_weights_v2/角色A-e10.ckpt'), '角色A');
  // 预训练底模不该被当成角色名，否则会去匹配一堆无关 wav
  assert.equal(guessCharacter('GPT_SoVITS/pretrained_models/s2G488k.pth'), '');
  assert.equal(guessCharacter(''), '');
});

test('找参考音频：文件名要含角色名，且跳过 TEMP / runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-gpt-'));
  mkdirSync(join(dir, 'logs', '角色A'), { recursive: true });
  writeFileSync(join(dir, 'logs', '角色A', '角色A_ref_alt1.wav'), Buffer.alloc(4096));
  mkdirSync(join(dir, 'TEMP', 'gradio'), { recursive: true });
  writeFileSync(join(dir, 'TEMP', 'gradio', '角色A_ref_alt1.wav'), Buffer.alloc(4096));
  writeFileSync(join(dir, 'logs', '别人.wav'), Buffer.alloc(4096));

  const hits = findRefAudio(dir, '角色A');
  assert.equal(hits.length, 1, 'TEMP 里的临时副本不能算');
  assert.ok(hits[0].includes(join('logs', '角色A')));
});

test('探测：空目录 / 不存在 / 没有 api 脚本，都说清是哪一种', () => {
  const g = createGptSovits();
  assert.equal(g.probe('').reason, 'empty');
  assert.equal(g.probe('Z:/definitely/not/here').reason, 'not_found');

  const noApi = mkdtempSync(join(tmpdir(), 'roost-gpt-'));
  assert.equal(g.probe(noApi).reason, 'no_api');
});

test('探测：有脚本没 python 时明确报 no_python', () => {
  const dir = makeInstall({ python: false });
  assert.equal(createGptSovits().probe(dir).reason, 'no_python');
});

test('探测：完整目录能认出 v2、接口 /tts、当前角色', () => {
  const dir = makeInstall();
  const p = createGptSovits().probe(dir);
  assert.equal(p.ok, true);
  assert.equal(p.apiVersion, 'v2');
  assert.equal(p.endpointPath, '/tts');
  assert.equal(p.weightVersion, 'v2ProPlus');
  assert.equal(p.character, '角色A');
  assert.ok(p.python.endsWith('python.exe'));
});

test('探测：只有 api.py 时按 v1 处理，接口是 /', () => {
  const dir = makeInstall({ api: 'api.py' });
  const p = createGptSovits().probe(dir);
  assert.equal(p.apiVersion, 'v1');
  assert.equal(p.endpointPath, '/');
});

test('启动：start 后立刻 stop 不会留下管不到的孤儿进程', async () => {
  const dir = makeInstall();
  const g = createGptSovits();
  /**
   * `start()` 是先返回、再在后台 `await pickPort()` 然后 spawn 的。
   * 用户在这几十毫秒里点「停止」时，`state.pid` 还是 0，旧实现会走
   * 「没在跑」分支直接返回，然后后台那条继续 spawn 出一个谁都管不到的进程。
   */
  assert.equal(g.start(dir).ok, true);
  g.stop();
  await new Promise((r) => setTimeout(r, 1200));
  const s = g.status();
  assert.equal(s.pid, 0, '取消之后不该再起进程');
  assert.notEqual(s.phase, 'running');
});

test('启动：目录不合法时直接拒绝，不 spawn 任何东西', () => {
  const g = createGptSovits();
  const r = g.start('Z:/nope');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
  assert.equal(g.status().phase, 'idle');
  assert.equal(g.status().pid, 0);
});

test('扫描角色：GPT 和 SoVITS 按名字配对，同名取最新 epoch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-gpt-'));
  mkdirSync(join(dir, 'GPT_weights_v2ProPlus'), { recursive: true });
  mkdirSync(join(dir, 'SoVITS_weights_v2ProPlus'), { recursive: true });
  // 角色A 有两个 epoch，应该取 e15
  writeFileSync(join(dir, 'GPT_weights_v2ProPlus', '角色A-e10.ckpt'), '');
  writeFileSync(join(dir, 'GPT_weights_v2ProPlus', '角色A-e15.ckpt'), '');
  writeFileSync(join(dir, 'SoVITS_weights_v2ProPlus', '角色A_e8_s200.pth'), '');
  // 另一个角色只有 SoVITS
  writeFileSync(join(dir, 'SoVITS_weights_v2ProPlus', '小町_e4_s120.pth'), '');

  const models = scanModels(dir);
  const zhenbai = models.find((m) => m.name === '角色A');
  assert.ok(zhenbai, '应该扫出角色A');
  assert.equal(zhenbai.gpt, 'GPT_weights_v2ProPlus/角色A-e15.ckpt', '同名取最新 epoch');
  assert.equal(zhenbai.sovits, 'SoVITS_weights_v2ProPlus/角色A_e8_s200.pth');
  assert.equal(zhenbai.version, 'v2ProPlus');

  const komachi = models.find((m) => m.name === '小町');
  assert.ok(komachi, '只有声学模型的角色也要列出来');
  assert.equal(komachi.sovits, 'SoVITS_weights_v2ProPlus/小町_e4_s120.pth');
});

test('扫描角色：目录不存在时返回空数组，不抛异常', () => {
  assert.deepEqual(scanModels('Z:/definitely/not/here'), []);
});

test('探测：完整目录里带上可下拉的角色列表', () => {
  const dir = makeInstall();
  mkdirSync(join(dir, 'GPT_weights_v2ProPlus'), { recursive: true });
  writeFileSync(join(dir, 'GPT_weights_v2ProPlus', '角色A-e15.ckpt'), '');
  const p = createGptSovits().probe(dir);
  assert.equal(p.models.length, 1);
  assert.equal(p.models[0].name, '角色A');
});

test('停止：没在跑的时候不报错，也不假装停过', () => {
  const g = createGptSovits();
  const r = g.stop();
  assert.equal(r.ok, true);
  assert.equal(r.stopped, false);
  assert.equal(g.status().phase, 'idle');
});

/* ---------------- 启动慢 / 音色不对（2026-11-04 截图反馈） ---------------- */

test('启动：选的就是配置文件已加载的角色时跳过切权重（否则白等一轮模型加载）', () => {
  /**
   * 权重一多，「启动/探测卡好久」主要是这一下：v2 要发两个
   * `/set_*_weights`，每次都重新加载权重，而加载本身就要 110 秒。
   */
  assert.deepEqual(decideSwitch({ wanted: '角色A', character: '角色A', hasManual: false }), { needed: true, skip: true });
  assert.deepEqual(decideSwitch({ wanted: '', character: '角色A', hasManual: false }), { needed: false, skip: false });
  assert.deepEqual(decideSwitch({ wanted: '角色B', character: '角色A', hasManual: false }), { needed: true, skip: false });
  /** 手填了路径就不能跳——用户明确要换文件，哪怕角色名一样 */
  assert.deepEqual(decideSwitch({ wanted: '角色A', character: '角色A', hasManual: true }), { needed: true, skip: false });
  assert.deepEqual(decideSwitch({ wanted: '', character: '', hasManual: true }), { needed: true, skip: false });
});

test('权重：手填路径优先于扫描配对（自动配对配错时音色会完全不对）', () => {
  const models = [{ name: '角色A', version: 'v2', gpt: 'GPT_weights/角色A-e15.ckpt', sovits: 'SoVITS_weights/角色A_e8_s200.pth' }];
  const r = buildWeightUrls(17860, '角色A', models, {
    gptWeights: 'D://my//真的模型.ckpt',
    sovitsWeights: 'D://my//真的模型.pth',
  });
  assert.equal(r.urls.length, 2);
  assert.ok(r.urls[0].includes(encodeURIComponent('D://my//真的模型.ckpt')), 'GPT 要用手填的');
  assert.ok(r.urls[1].includes(encodeURIComponent('D://my//真的模型.pth')), 'SoVITS 要用手填的');
  assert.ok(!r.urls[0].includes('角色A-e15'), '扫描出来的那条不能被用上');
});

test('权重：只填一个也行，另一个用扫描结果', () => {
  const models = [{ name: '角色A', gpt: 'GPT_weights/角色A-e15.ckpt', sovits: 'SoVITS_weights/角色A_e8_s200.pth' }];
  const r = buildWeightUrls(17860, '角色A', models, { gptWeights: 'D://my//真的模型.ckpt' });
  assert.ok(r.urls[0].includes(encodeURIComponent('D://my//真的模型.ckpt')));
  assert.ok(r.urls[1].includes(encodeURIComponent('SoVITS_weights/角色A_e8_s200.pth')));
});

test('权重：没选角色也没手填路径时报错，别发空请求', () => {
  assert.throws(() => buildWeightUrls(17860, '不存在', [], {}), /没有「不存在」的权重/);
  /** 扫到了角色但两个权重都没配出来，也要挡住，不能发一个空 URL */
  assert.throws(
    () => buildWeightUrls(17860, '角色空', [{ name: '角色空', gpt: '', sovits: '' }], {}),
    /没有可用的权重路径/,
  );
});

test('权重：路径要 URL 编码（盘符、中文、空格不能把 query 拆了）', () => {
  const r = buildWeightUrls(17860, '', [], { gptWeights: 'D://GPT 权重\\角色 A-e15.ckpt' });
  assert.ok(r.urls[0].includes('set_gpt_weights'));
  assert.ok(!r.urls[0].includes(' '), '空格不能裸着进 URL');
  assert.ok(r.urls[0].includes(encodeURIComponent('D://GPT 权重\\角色 A-e15.ckpt')));
});

test('状态：切换失败后要能看出「实际生效的是谁」', () => {
  /** 初始状态带 activeModel / warning，面板才有东西可显示 */
  const g = createGptSovits();
  const s = g.status();
  assert.equal(s.activeModel, '');
  assert.equal(s.warning, '');
  g.dispose();
});

test('权重：只填一个路径时标出「另一半仍是自动配对」', () => {
  const models = [{ name: '角色A', gpt: 'GPT_weights/a.ckpt', sovits: 'SoVITS_weights/a.pth' }];
  assert.equal(buildWeightUrls(1, '角色A', models, { gptWeights: 'D:/x.ckpt' }).partial, true);
  assert.equal(buildWeightUrls(1, '角色A', models, { sovitsWeights: 'D:/y.pth' }).partial, true);
  assert.equal(
    buildWeightUrls(1, '角色A', models, { gptWeights: 'D:/x.ckpt', sovitsWeights: 'D:/y.pth' }).partial,
    false,
    '两个都填了就不是 partial',
  );
  assert.equal(buildWeightUrls(1, '角色A', models, {}).partial, false, '都不填走自动配对，不算 partial');
});

// ── 运行时换角色：合成前 / 面板下拉共用 ────────────────────────────────

const MODELS = [{ name: '角色A', gpt: 'GPT_weights/角色A-e15.ckpt', sovits: 'SoVITS_weights/角色A_e8_s200.pth' }];

test('运行时切权重：baseUrl 优先，两个接口都发，JSON success 才算成功', async () => {
  const urls = [];
  const r = await applyWeights({
    baseUrl: 'https://relay.example/gpt/', model: '角色A', models: MODELS,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ message: 'success' }), { status: 200 });
    },
  });
  assert.equal(r.name, '角色A');
  assert.equal(r.version, '');
  assert.equal(urls.length, 2, 'GPT + SoVITS 两个权重都要切');
  assert.ok(urls[0].startsWith('https://relay.example/gpt/set_gpt_weights?'), '用配置的 baseUrl，不拼死 127.0.0.1');
  assert.ok(urls[1].startsWith('https://relay.example/gpt/set_sovits_weights?'));
  assert.ok(urls[0].includes(encodeURIComponent('GPT_weights/角色A-e15.ckpt')));
});

test('运行时切权重：HTTP 200 但 JSON 明确失败时要挡下来', async () => {
  await assert.rejects(
    applyWeights({
      baseUrl: 'http://127.0.0.1:9880', model: '角色A', models: MODELS,
      fetchImpl: async () => new Response(JSON.stringify({ message: '权重文件不存在' }), { status: 200 }),
    }),
    /权重文件不存在/,
    '不能只看 HTTP 200——扩展实测过「200 但没换成」的情况',
  );
});

test('运行时切权重：fork 只回文本时放行，非 2xx 仍要挡', async () => {
  await applyWeights({
    baseUrl: 'http://127.0.0.1:9880', model: '角色A', models: MODELS,
    fetchImpl: async () => new Response('ok', { status: 200 }),
  });
  await assert.rejects(
    applyWeights({
      baseUrl: 'http://127.0.0.1:9880', model: '角色A', models: MODELS,
      fetchImpl: async () => new Response('bad', { status: 500 }),
    }),
    /HTTP 500/,
  );
});

test('运行时切权重：没选角色也没填路径时明确报错，不发请求', async () => {
  let fetches = 0;
  await assert.rejects(
    applyWeights({
      baseUrl: 'http://127.0.0.1:9880', model: '', models: MODELS,
      fetchImpl: async () => { fetches += 1; return new Response('ok'); },
    }),
    /没有「」的权重/,
  );
  assert.equal(fetches, 0);
});

test('运行时切权重：没配 baseUrl 直接拒，不拿空地址发请求', async () => {
  await assert.rejects(applyWeights({ model: '角色A', models: MODELS }), /服务地址/);
});

// ── 启动失败不该锁死音色 ─────────────────────────────────────────────

test('权重切成功：就绪指纹带完整配置，合成时跳过重复加载', () => {
  const r = weightReadyConfig({
    weightsApplied: true,
    cfg: { model: '角色A', baseUrl: 'http://old' },
    baseUrl: 'http://new',
  });
  assert.equal(r.model, '角色A');
  assert.equal(r.baseUrl, 'http://new', 'baseUrl 以就绪回调的端口为准');
});

test('权重切失败：返回 null，调用方清空指纹让下一句合成重试', () => {
  assert.equal(weightReadyConfig({ weightsApplied: false, cfg: { model: '角色A' }, baseUrl: 'http://x' }), null);
  assert.equal(weightReadyConfig({ weightsApplied: false }), null);
});
