import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTts, encodeWav, TtsError, speedOf, edgeRateOf } from '../src/tts.js';

const audioResponse = (bytes = 'audio') => new Response(Buffer.from(bytes), {
  status: 200,
  headers: { 'content-type': 'audio/mpeg; charset=binary' },
});

const openAiCfg = (patch = {}) => ({
  tts: {
    enabled: true,
    provider: 'openai',
    baseUrl: 'https://speech.example/v1',
    apiKey: 'secret',
    model: 'tts-test',
    voice: 'alloy',
    timeoutSec: 10,
    maxChars: 300,
    gptSovits: {},
    ...patch,
  },
});

test('TTS 默认关闭：不请求上游、不加载本地引擎', async () => {
  let fetches = 0;
  let loads = 0;
  const tts = createTts({
    cfgOf: () => ({ tts: { enabled: false, provider: 'sherpa' } }),
    fetchImpl: async () => { fetches += 1; return audioResponse(); },
    loadSherpa: () => { loads += 1; return { engine: {}, mod: {} }; },
  });

  assert.deepEqual(await tts.status(), { enabled: false, provider: 'sherpa', configured: false });
  await assert.rejects(tts.synthesize('你好'), (e) => e instanceof TtsError && e.code === 'disabled');
  assert.equal(fetches, 0);
  assert.equal(loads, 0);
});

test('OpenAI-compatible TTS：调用配置地址并请求 MP3 二进制', async () => {
  let request;
  const tts = createTts({
    cfgOf: () => openAiCfg(),
    fetchImpl: async (url, init) => { request = { url: String(url), init }; return audioResponse('mp3-bytes'); },
  });

  const result = await tts.synthesize('你好');
  assert.equal(request.url, 'https://speech.example/v1/audio/speech');
  assert.equal(request.init.headers.authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(request.init.body), {
    model: 'tts-test', input: '你好', voice: 'alloy', response_format: 'mp3',
  });
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(result.audio.toString(), 'mp3-bytes');
});

test('OpenAI-compatible TTS：拒绝模型输入 URL 注入，只使用已配置地址', async () => {
  let target = '';
  const tts = createTts({
    cfgOf: () => openAiCfg(),
    fetchImpl: async (url) => { target = String(url); return audioResponse(); },
  });
  await tts.synthesize('请访问 http://127.0.0.1:1/admin');
  assert.equal(target, 'https://speech.example/v1/audio/speech');
});

test('GPT-SoVITS v1：使用原生字段并透传 WAV 响应', async () => {
  let request;
  const tts = createTts({
    cfgOf: () => ({ tts: {
      enabled: true,
      provider: 'gpt-sovits',
      timeoutSec: 15,
      maxChars: 300,
      apiKey: '',
      gptSovits: {
        baseUrl: 'http://127.0.0.1:9880',
        apiVersion: 'v1',
        endpointPath: '/',
        referWavPath: 'D:/voices/ref.wav',
        promptText: '参考音频文本',
        promptLanguage: '中文',
        textLanguage: '日文',
      },
    } }),
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(Buffer.from('wav-bytes'), { headers: { 'content-type': 'audio/wav' } });
    },
  });

  const result = await tts.synthesize('こんにちは');
  assert.equal(request.url, 'http://127.0.0.1:9880/');
  assert.deepEqual(JSON.parse(request.init.body), {
    refer_wav_path: 'D:/voices/ref.wav',
    prompt_text: '参考音频文本',
    /** 「中文」「日文」要转成 API 认的语言代码，原样发上游会 400 */
    prompt_language: 'zh',
    text: 'こんにちは',
    text_language: 'ja',
  });
  assert.equal(result.contentType, 'audio/wav');
});

test('GPT-SoVITS v2：字段名是 text_lang / prompt_lang，不是 text_language', async () => {
  let body;
  const tts = createTts({
    cfgOf: () => ({ tts: {
      enabled: true, provider: 'gpt-sovits', maxChars: 300,
      gptSovits: {
        baseUrl: 'http://localhost:9880', apiVersion: 'v2', endpointPath: '/tts',
        referWavPath: 'ref.wav', promptText: 'ref', promptLanguage: '中文', textLanguage: '中文',
      },
    } }),
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return audioResponse(); },
  });
  await tts.synthesize('测试');
  /**
   * 2026-11-03 真实事故：v2 也发 `text_language`，上游回 400
   * `text_lang is required`——单测只验了字段映射、没验字段名，所以一直没抓到。
   */
  assert.equal(body.ref_audio_path, 'ref.wav');
  assert.equal(body.text_lang, 'zh');
  assert.equal(body.prompt_lang, 'zh');
  assert.equal(body.text_language, undefined, 'v2 不该再发 text_language');
  assert.equal(body.refer_wav_path, undefined);
});

test('GPT-SoVITS：直接填 zh / ja 也认，认不出的原样传', async () => {
  const bodies = [];
  const tts = createTts({
    cfgOf: () => ({ tts: {
      enabled: true, provider: 'gpt-sovits', maxChars: 300,
      gptSovits: {
        baseUrl: 'http://localhost:9880', apiVersion: 'v2', endpointPath: '/tts',
        referWavPath: 'ref.wav', promptText: 'ref', promptLanguage: 'JA', textLanguage: 'en',
      },
    } }),
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return audioResponse(); },
  });
  await tts.synthesize('测试');
  assert.equal(bodies[0].prompt_lang, 'ja', '大写 JA 也要认');
  assert.equal(bodies[0].text_lang, 'en');
});

test('provider 错误不回显密钥或上游响应正文', async () => {
  const tts = createTts({
    cfgOf: () => openAiCfg(),
    fetchImpl: async () => new Response('secret upstream body', { status: 401 }),
  });
  await assert.rejects(tts.synthesize('你好'), (e) => {
    assert.equal(e.code, 'upstream_auth');
    assert.doesNotMatch(e.message, /secret/);
    return true;
  });
});

test('不支持 JSON MIME 的上游响应拒绝当音频透传', async () => {
  const tts = createTts({
    cfgOf: () => openAiCfg(),
    fetchImpl: async () => new Response('{"error":"bad"}', { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(tts.synthesize('你好'), (e) => e.code === 'unsupported_audio');
});

test('本地 sherpa：引擎和模型缺哪一层就说哪一层，不去猜', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-tts-'));
  const cfg = () => ({ tts: { enabled: true, provider: 'sherpa', sherpa: { model: 'aishell3' } } });
  const tts = createTts({ cfgOf: cfg, dataDir: () => dir });

  const noRuntime = await tts.status();
  assert.equal(noRuntime.configured, false);
  assert.equal(noRuntime.reason, 'runtime_missing');
  await assert.rejects(tts.synthesize('你好'), (e) => e.code === 'runtime_missing');

  mkdirSync(join(dir, 'tts-runtime', 'node_modules', 'sherpa-onnx-node'), { recursive: true });
  const noModel = await tts.status();
  assert.equal(noModel.reason, 'model_missing');
  assert.deepEqual(noModel.missing, ['model.onnx', 'tokens.txt', 'lexicon.txt']);
});

test('本地 sherpa：模型齐了才算可用，合成结果转成 16bit WAV', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-tts-'));
  const modelDir = join(dir, 'tts-models', 'vits-icefall-zh-aishell3');
  mkdirSync(join(dir, 'tts-runtime', 'node_modules', 'sherpa-onnx-node'), { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  for (const f of ['model.onnx', 'tokens.txt', 'lexicon.txt']) writeFileSync(join(modelDir, f), 'x');

  let seen = null;
  const tts = createTts({
    cfgOf: () => ({
      tts: {
        enabled: true, provider: 'sherpa', maxChars: 300,
        /** 语速已统一到 tts.speed（四个 provider 共用），不再是 sherpa.speed */
        speed: 1.5,
        sherpa: { model: 'aishell3', sid: 12, numThreads: 3 },
      },
    }),
    dataDir: () => dir,
    loadSherpa: ({ modelDir: got, threads }) => {
      seen = { modelDir: got, threads };
      return {
        engine: {
          generate: ({ text, generationConfig }) => {
            seen.text = text;
            seen.sid = generationConfig.sid;
            seen.speed = generationConfig.speed;
            return { samples: new Float32Array([0, 0.5, -0.5, 1, -1]), sampleRate: 8000 };
          },
        },
        mod: { GenerationConfig: class { constructor(o) { Object.assign(this, o); } } },
      };
    },
  });

  assert.equal((await tts.status()).configured, true);
  const result = await tts.synthesize('你好');
  assert.equal(seen.modelDir, modelDir);
  assert.equal(seen.threads, 3);
  assert.equal(seen.sid, 12);
  assert.equal(seen.speed, 1.5);
  assert.equal(result.contentType, 'audio/wav');
  assert.equal(result.audio.subarray(0, 4).toString(), 'RIFF');
  assert.equal(result.audio.readUInt32LE(24), 8000);
  assert.equal(result.audio.length, 44 + 5 * 2);
  // 0.5 → 16384、-0.5 → -16383（Math.round 对 .5 向 +∞ 取整）、1 → 32767
  assert.equal(result.audio.readInt16LE(44 + 2), 16384);
  assert.equal(result.audio.readInt16LE(44 + 4), -16383);
  assert.equal(result.audio.readInt16LE(44 + 6), 32767);
});

test('encodeWav：越界样本被夹住，不产生爆音', () => {
  const wav = encodeWav(new Float32Array([2, -2, 0]), 16000);
  assert.equal(wav.readInt16LE(44), 32767);
  assert.equal(wav.readInt16LE(46), -32767);
  assert.equal(wav.readInt16LE(48), 0);
});

test('上游挂了之后进入冷却：不再报「可用」，免得每轮都白试一次', async () => {
  const tts = createTts({
    cfgOf: () => openAiCfg(),
    fetchImpl: async () => new Response('boom', { status: 500 }),
  });
  // 还没失败过：配置是齐的
  assert.equal((await tts.status()).configured, true);
  await assert.rejects(tts.synthesize('你好'), (e) => e.code === 'upstream_error');

  /**
   * 2026-11-03 线上：GPT-SoVITS 的 API 没启动，但配置字段填得很齐，
   * `configured` 一直 true → ai-chat 一直教模型写 `<<say>>` → 每轮合成
   * 失败、每轮降级发文字。用户看到的就是「语音永远是文字」。
   */
  const s = await tts.status();
  assert.equal(s.configured, false);
  assert.equal(s.reason, 'upstream_unreachable');
});

test('配置错误不进冷却：改完配置应该立刻能试，不用等一分钟', async () => {
  const tts = createTts({
    cfgOf: () => openAiCfg({ baseUrl: 'http://user:pass@127.0.0.1/v1' }),
    fetchImpl: async () => audioResponse(),
  });
  await assert.rejects(tts.synthesize('你好'), (e) => e.code === 'invalid_config');
  const s = await tts.status();
  assert.equal(s.configured, true, '配置错是调用方的问题，不该把能力标记成不可用');
});

test('provider 状态不会把未完成配置报告为可用', async () => {
  const openai = createTts({ cfgOf: () => openAiCfg({ baseUrl: '', model: '' }) });
  assert.equal((await openai.status()).reason, 'configuration_incomplete');
  const gpt = createTts({ cfgOf: () => ({ tts: { enabled: true, provider: 'gpt-sovits', gptSovits: {} } }) });
  assert.equal((await gpt.status()).configured, false);
});

test('TTS：按配置拒绝空文本和超长文本，不请求上游', async () => {
  let calls = 0;
  const tts = createTts({
    cfgOf: () => openAiCfg({ maxChars: 3 }),
    fetchImpl: async () => { calls += 1; return audioResponse(); },
  });
  await assert.rejects(tts.synthesize('   '), (e) => e.code === 'empty_text');
  await assert.rejects(tts.synthesize('超过上限'), (e) => e.code === 'text_too_long');
  assert.equal(calls, 0);
});

test('配置 URL 中不接受 userinfo、query、非 HTTP 协议或越权 endpointPath', async () => {  const badOpenAi = createTts({
    cfgOf: () => openAiCfg({ baseUrl: 'http://user:pass@127.0.0.1/v1' }),
    fetchImpl: async () => audioResponse(),
  });
  await assert.rejects(badOpenAi.synthesize('x'), (e) => e.code === 'invalid_config');

  const badGpt = createTts({
    cfgOf: () => ({ tts: {
      enabled: true, provider: 'gpt-sovits',
      gptSovits: {
        baseUrl: 'http://127.0.0.1:9880', endpointPath: '/../admin',
        referWavPath: 'x.wav', promptText: 'x', promptLanguage: '中文', textLanguage: '中文',
      },
    } }),
    fetchImpl: async () => audioResponse(),
  });
  await assert.rejects(badGpt.synthesize('x'), (e) => e.code === 'invalid_config');
});

test('GPT-SoVITS：endpointPath 的编码绕过也要拒（%2e%2e / 协议相对）', async () => {
  /**
   * 只查字面 `..` 不够：`/%2e%2e/admin` 里一个点都没有，但服务端解码后
   * 就是 `/../admin`；`//evil.com/x` 是协议相对地址（审查发现）。
   */
  for (const endpointPath of ['/%2e%2e/admin', '//evil.com/x', '/a/%2e%2e/b', '/%ZZ']) {
    const tts = createTts({
      cfgOf: () => ({ tts: {
        enabled: true, provider: 'gpt-sovits', maxChars: 300,
        gptSovits: {
          baseUrl: 'http://127.0.0.1:9880', endpointPath,
          referWavPath: 'r.wav', promptText: 'p', promptLanguage: '中文', textLanguage: '中文',
        },
      } }),
      fetchImpl: async () => audioResponse(),
    });
    await assert.rejects(
      tts.synthesize('x'),
      (e) => e.code === 'invalid_config',
      `${endpointPath} 应该被拒`,
    );
  }
});

/* ---------------- 微软在线朗读（Edge TTS） ---------------- */

const edgeCfg = (patch = {}) => ({
  tts: {
    enabled: true,
    provider: 'edge',
    edge: { voice: 'zh-CN-XiaoxiaoNeural' },
    ...patch,
  },
});

/** 假的 EdgeTTS，照搬 ai-chat/tts.js 里已验证的两个方法，不联网 */
function fakeEdge(sink, { bytes = 'ID3-fake-mp3', fail = false } = {}) {
  return () => ({
    EdgeTTS: class {
      async synthesize(text, voice, options) {
        sink.push({ text, voice, options });
        if (fail) throw new Error('websocket 断线');
      }
      async toBuffer() {
        return Buffer.from(bytes);
      }
    },
  });
}

test('微软朗读：一键配置只要音色，不用地址不用 Key', async () => {
  const calls = [];
  const tts = createTts({
    cfgOf: () => edgeCfg(),
    dataDir: () => join(tmpdir(), 'roost-edge-not-installed'),
    loadEdge: fakeEdge(calls),
  });
  const st = await tts.status();
  assert.equal(st.configured, true, '不用填 baseUrl / apiKey 就该算配置齐全');
  assert.equal(st.voice, 'zh-CN-XiaoxiaoNeural');

  const r = await tts.synthesize('你好呀');
  assert.equal(r.contentType, 'audio/mpeg');
  assert.equal(r.audio.toString(), 'ID3-fake-mp3');
  assert.equal(calls[0].text, '你好呀');
  assert.equal(calls[0].voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(calls[0].options, undefined, '原速时不该传 options，和已验证的调用保持一致');
});

test('微软朗读：依赖没装时报 runtime_missing，不假装能合成', async () => {
  const tts = createTts({
    cfgOf: () => edgeCfg(),
    dataDir: () => mkdtempSync(join(tmpdir(), 'roost-edge-missing-')),
  });
  const st = await tts.status();
  assert.equal(st.configured, false);
  assert.equal(st.reason, 'runtime_missing');
  await assert.rejects(tts.synthesize('你好'), (e) => e instanceof TtsError && e.code === 'runtime_missing');
});

test('微软朗读：音色不在清单里直接拒，不把任意字符串发给上游', async () => {
  const calls = [];
  const tts = createTts({
    cfgOf: () => edgeCfg({ edge: { voice: 'zh-CN-不存在的音色' } }),
    loadEdge: fakeEdge(calls),
  });
  await assert.rejects(tts.synthesize('你好'), (e) => e instanceof TtsError && e.code === 'invalid_config');
  assert.equal(calls.length, 0, '不该真的发请求');
});

test('微软朗读：空音频和上游异常都要说清原因', async () => {
  const empty = createTts({ cfgOf: () => edgeCfg(), loadEdge: fakeEdge([], { bytes: '' }) });
  await assert.rejects(empty.synthesize('你好'), (e) => e instanceof TtsError && e.code === 'empty_audio');

  const broken = createTts({ cfgOf: () => edgeCfg(), loadEdge: fakeEdge([], { fail: true }) });
  await assert.rejects(broken.synthesize('你好'), (e) => e instanceof TtsError && e.code === 'upstream_error');
});

test('微软朗读：音色缺省时回落到晓晓', async () => {
  const calls = [];
  const tts = createTts({
    cfgOf: () => edgeCfg({ edge: {} }),
    loadEdge: fakeEdge(calls),
  });
  await tts.synthesize('你好');
  assert.equal(calls[0].voice, 'zh-CN-XiaoxiaoNeural');
});

test('微软朗读：拿到的不是音频不能硬当 mp3 发出去', async () => {
  const tts = createTts({ cfgOf: () => edgeCfg(), loadEdge: fakeEdge([], { bytes: '<html>502</html>' }) });
  await assert.rejects(tts.synthesize('你好'), (e) => e instanceof TtsError && e.code === 'unsupported_audio');
});

test('微软朗读：wav / ogg 也能按魔数认出来，不是只认 mp3', async () => {
  for (const [head, mime] of [['RIFFxxxxWAVE', 'audio/wav'], ['OggSxxxx', 'audio/ogg'], ['fLaCxxxx', 'audio/flac']]) {
    const tts = createTts({ cfgOf: () => edgeCfg(), loadEdge: fakeEdge([], { bytes: head }) });
    const r = await tts.synthesize('你好');
    assert.equal(r.contentType, mime);
  }
});

test('微软朗读：超大音频要挡在宿主内存之外（其它 provider 有这道关，edge 也得有）', async () => {
  /** 10MB 上限和 `MAX_AUDIO_BYTES` 一致；这里造一个刚好超一点、且看起来像 mp3 的 buffer */
  const huge = Buffer.alloc(10 * 1024 * 1024 + 1);
  huge.write('ID3', 0, 'ascii');
  const tts = createTts({ cfgOf: () => edgeCfg(), loadEdge: fakeEdge([], { bytes: huge }) });
  await assert.rejects(tts.synthesize('你好'), (e) => e instanceof TtsError && e.code === 'audio_too_large');
});

/* ---------------- 语速：四个 provider 共用一份 ---------------- */

test('语速：范围夹在 0.5–2，非法值回原速', () => {
  assert.equal(speedOf({ speed: 1.5 }), 1.5);
  assert.equal(speedOf({ speed: 0.3 }), 0.5, '低于下限夹到 0.5');
  assert.equal(speedOf({ speed: 3 }), 2, '高于上限夹到 2');
  assert.equal(speedOf({ speed: '1.2' }), 1.2, '字符串数字也认');
  /** 下面这些不挡住的话会合成出 0 倍速的静音，而日志只有一条「成功」 */
  for (const bad of [undefined, null, '', 0, -1, NaN, 'abc', {}]) {
    assert.equal(speedOf({ speed: bad }), 1, `speed=${JSON.stringify(bad)} 应该回原速`);
  }
});

test('语速：微软要的是百分比字符串，不是倍率', () => {
  assert.equal(edgeRateOf(1), '', '原速不传，保持两参数调用');
  assert.equal(edgeRateOf(1.2), '+20%');
  assert.equal(edgeRateOf(0.8), '-20%');
  assert.equal(edgeRateOf(2), '+100%');
  assert.equal(edgeRateOf(0.5), '-50%');
  assert.equal(edgeRateOf(NaN), '');
  /** 1.004 四舍五入到 0% 时也要返回空，不能传个 '+0%' 上去 */
  assert.equal(edgeRateOf(1.004), '');
});

test('语速：微软朗读会带上 rate，原速时不带', async () => {
  const fast = [];
  await createTts({ cfgOf: () => edgeCfg({ speed: 1.5 }), loadEdge: fakeEdge(fast) }).synthesize('你好');
  assert.deepEqual(fast[0].options, { rate: '+50%' });

  const normal = [];
  await createTts({ cfgOf: () => edgeCfg({ speed: 1 }), loadEdge: fakeEdge(normal) }).synthesize('你好');
  assert.equal(normal[0].options, undefined);
});

test('语速：OpenAI 兼容只在非原速时带 speed', async () => {
  const bodies = [];
  const cfgOf = (speed) => () => ({
    tts: {
      enabled: true, provider: 'openai', baseUrl: 'https://speech.example/v1',
      apiKey: 'k', model: 'tts-1', voice: 'alloy', speed, timeoutSec: 10, maxChars: 300,
    },
  });
  const mk = (speed) => createTts({
    cfgOf: cfgOf(speed),
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return audioResponse(); },
  });

  await mk(1).synthesize('你好');
  assert.equal('speed' in bodies[0], false, '原速不传，避免被中转服务拒');

  await mk(1.5).synthesize('你好');
  assert.equal(bodies[1].speed, 1.5);
});

test('语速：GPT-SoVITS 只有 v2 支持，v1 不能硬塞字段', async () => {
  const bodies = [];
  const mk = (version, speed) => createTts({
    cfgOf: () => ({
      tts: {
        enabled: true, provider: 'gpt-sovits', speed, timeoutSec: 10, maxChars: 300,
        gptSovits: {
          baseUrl: 'http://127.0.0.1:9880', endpointPath: version === 'v2' ? '/tts' : '/',
          apiVersion: version, referWavPath: '/a.wav', promptText: '参考',
          promptLanguage: '中文', textLanguage: '中文',
        },
      },
    }),
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return audioResponse('wav'); },
  });

  await mk('v2', 1.5).synthesize('你好');
  assert.equal(bodies[0].speed_factor, 1.5, 'v2 用 speed_factor');

  await mk('v1', 1.5).synthesize('你好');
  assert.equal('speed' in bodies[1], false, 'v1 的接口签名里没有语速，不能塞');
  assert.equal('speed_factor' in bodies[1], false);
});

test('预热：卸载之后不该再刷「预热失败」（没装是正常状态，不是故障）', async () => {
  /**
   * 卸载只删 tts-runtime / tts-models，**不动配置**——所以「卸了模型但
   * provider 还指着 sherpa」是正常状态。以前每次启动预热都撞一次
   * `runtime_missing` 并记日志，用户会以为卸载没卸干净。
   */
  const logs = [];
  const dir = mkdtempSync(join(tmpdir(), 'roost-warm-'));
  const tts = createTts({
    cfgOf: () => ({ tts: { enabled: true, provider: 'sherpa', sherpa: {} } }),
    dataDir: () => dir,
    log: (m) => logs.push(m),
  });
  const r = await tts.warmup();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'runtime_missing');
  assert.deepEqual(logs, [], '没装不该记日志');
});

test('预热：装了但加载不起来，仍然要记一条（这才是真故障）', async () => {
  const logs = [];
  const dir = mkdtempSync(join(tmpdir(), 'roost-warm2-'));
  mkdirSync(join(dir, 'tts-runtime', 'node_modules', 'sherpa-onnx-node'), { recursive: true });
  const modelDir = join(dir, 'tts-models', 'vits-icefall-zh-aishell3');
  mkdirSync(modelDir, { recursive: true });
  for (const f of ['model.onnx', 'tokens.txt', 'lexicon.txt']) writeFileSync(join(modelDir, f), 'x');

  const tts = createTts({
    cfgOf: () => ({ tts: { enabled: true, provider: 'sherpa', sherpa: {} } }),
    dataDir: () => dir,
    log: (m) => logs.push(m),
    loadSherpa: () => { throw new Error('ONNX 架构不匹配'); },
  });
  const r = await tts.warmup();
  assert.equal(r.ok, false);
  assert.equal(logs.length, 1, '装坏了要有诊断线索');
  assert.match(logs[0], /预热失败/);
});

test('语速：老配置的 sherpa.speed 不能静默失效', () => {
  /** 直接构造 cfg 的调用方（测试、插件）传老形状时要能认出来 */
  assert.equal(speedOf({ sherpa: { speed: 0.8 } }), 0.8);
  assert.equal(speedOf({ sherpa: { speed: 0.1 } }), 0.5, '老值也要夹范围');
  /** 新字段优先 */
  assert.equal(speedOf({ speed: 1.5, sherpa: { speed: 0.8 } }), 1.5);
});

test('微软朗读：上游挂住时要按 timeoutSec 超时，不能无限等', async () => {
  const hang = () => ({
    EdgeTTS: class {
      async synthesize() {
        // 永不 resolve，模拟 websocket 挂住
        await new Promise(() => {});
      }
      async toBuffer() { return Buffer.alloc(0); }
    },
  });
  const tts = createTts({ cfgOf: () => edgeCfg({ timeoutSec: 1 }), loadEdge: hang });
  const started = Date.now();
  await assert.rejects(tts.synthesize('你好'), (e) => e instanceof TtsError && e.code === 'timeout');
  assert.ok(Date.now() - started < 3000, '应该在 1 秒左右就放弃');
});

test('微软朗读：RIFF 但不是 WAVE 的（WebP / AVI）不能当 wav 交出去', async () => {
  const tts = createTts({ cfgOf: () => edgeCfg(), loadEdge: fakeEdge([], { bytes: 'RIFFxxxxWEBPVP8 ' }) });
  await assert.rejects(tts.synthesize('你好'), (e) => e instanceof TtsError && e.code === 'unsupported_audio');
});
