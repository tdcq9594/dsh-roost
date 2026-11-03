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
