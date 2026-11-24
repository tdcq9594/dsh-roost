/**
 * 额外语音 provider 的协议回归。
 *
 * 这些 provider 都是「文本 → 音频字节」的 HTTP 调用，真联网测不了也不该测。
 * 这里用注入的 fetchImpl 钉住每家的**请求形状**（鉴权放哪、参数怎么拼）
 * 和**返回解析**（火山的连段 JSON、MiniMax 的 hex），改坏了会当场红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRA_PROVIDERS,
  extraSpeech,
  extraConfigured,
  volcanoResourceFor,
  splitJsonObjects,
} from '../src/tts-providers.js';

const mp3 = () => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 0x61)]);
const res = (body, init = {}) => new Response(body, {
  status: init.status || 200,
  headers: { 'content-type': init.contentType || 'audio/mpeg', ...(init.headers || {}) },
});

/** 记录请求，返回给定响应 */
function recorder(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return typeof response === 'function' ? response(calls.length, url, init) : response;
  };
  return { calls, fetchImpl };
}

test('provider 清单齐全：七个来源都登记了', () => {
  for (const p of ['auto', 'cosyvoice', 'volcano', 'fish-free', 'breeze', 'minimax', 'windows']) {
    assert.ok(EXTRA_PROVIDERS.includes(p), `${p} 应在清单里`);
  }
});

test('CosyVoice：sft 走 /inference_sft，表单带音色，裸 PCM 按采样率包 WAV', async () => {
  const pcm = Buffer.alloc(400, 0x41); // 200 个 int16 样本
  const { calls, fetchImpl } = recorder(res(pcm, { contentType: 'application/octet-stream' }));
  const cfg = { cosyvoice: { url: 'http://127.0.0.1:50000/', spkId: '中文女', sampleRate: 24000 } };
  const out = await extraSpeech('cosyvoice', '你好', cfg, fetchImpl);
  assert.equal(calls[0].url, 'http://127.0.0.1:50000/inference_sft');
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('tts_text'), '你好');
  assert.equal(form.get('spk_id'), '中文女');
  assert.equal(out.contentType, 'audio/wav');
  assert.equal(out.audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(out.audio.readUInt32LE(24), 24000, 'WAV 头采样率要用配置的');
});

test('CosyVoice：instruct 模式加 instruct_text，路径换 /inference_instruct', async () => {
  const { calls, fetchImpl } = recorder(res(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(200, 0x61)]), { contentType: 'audio/wav' }));
  const cfg = { cosyvoice: { url: 'http://x/', mode: 'instruct', instruct: '轻声地说' } };
  await extraSpeech('cosyvoice', '你好', cfg, fetchImpl);
  assert.ok(calls[0].url.endsWith('/inference_instruct'));
  assert.equal(new URLSearchParams(calls[0].init.body).get('instruct_text'), '轻声地说');
});

test('豆包：鉴权放 header，音色决定 resourceId，语速换算成 speech_rate', async () => {
  const { calls, fetchImpl } = recorder(res(volcanoStream()));
  const cfg = { volcano: { apiKey: 'SECRET_KEY', voiceType: 'zh_female_vv_uranus_bigtts', speedRatio: 1.5 } };
  const out = await extraSpeech('volcano', '你好', cfg, fetchImpl);
  const h = calls[0].init.headers;
  assert.equal(h['X-Api-Key'], 'SECRET_KEY');
  assert.equal(h['X-Api-Resource-Id'], 'seed-tts-2.0');
  assert.ok(h['X-Api-Request-Id'], '每次请求要带随机 request id');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.req_params.audio_params.speech_rate, 50);
  assert.equal(body.req_params.speaker, 'zh_female_vv_uranus_bigtts');
  assert.equal(out.contentType, 'audio/mpeg');
  assert.ok(!JSON.stringify(calls[0]).includes('Authorization'), '密钥不进 Authorization');
});

test('豆包：1.0 音色配 1.0 模型；语速为 1 时不传 speech_rate', async () => {
  assert.equal(volcanoResourceFor('zh_male_xxx'), 'seed-tts-1.0');
  assert.equal(volcanoResourceFor('zh_female_uranus'), 'seed-tts-2.0');
  const { calls, fetchImpl } = recorder(res(volcanoStream()));
  await extraSpeech('volcano', '你好', { volcano: { apiKey: 'k', voiceType: 'zh_male_xxx' } }, fetchImpl);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].init.headers['X-Api-Resource-Id'], 'seed-tts-1.0');
  assert.equal(body.req_params.audio_params.speech_rate, undefined);
});

test('豆包：多段 JSON 分片解析正确（含中文与转义引号）', () => {
  const parts = splitJsonObjects('{"header":{"code":0},"data":"a"}{"header":{"code":20000000},"extra":"中文\\"引号"}');
  assert.equal(parts.length, 2);
  assert.equal(JSON.parse(parts[0]).header.code, 0);
  assert.equal(JSON.parse(parts[1]).extra, '中文"引号');
});

test('豆包：中间段报错误码就挡下来，不拼半截音频', async () => {
  const bad = '{"header":{"code":45000030},"message":"模型未开通"}';
  await assert.rejects(
    extraSpeech('volcano', '你好', { volcano: { apiKey: 'k' } }, recorder(res(bad)).fetchImpl),
    /45000030/,
  );
});

test('Fish Audio：模型名在 header、音色 ID 校验 32 位、密钥只在 Authorization', async () => {
  const { calls, fetchImpl } = recorder(res(mp3()));
  const cfg = { fishApiKey: 'fish-secret', fishReferenceId: 'a'.repeat(32) };
  const out = await extraSpeech('fish-free', '你好', cfg, fetchImpl);
  assert.equal(calls[0].url, 'https://api.fish.audio/v1/tts');
  assert.equal(calls[0].init.headers.model, 's2.1-pro-free');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fish-secret');
  assert.equal(JSON.parse(calls[0].init.body).reference_id, 'a'.repeat(32));
  assert.equal(out.contentType, 'audio/mpeg');
  await assert.rejects(
    extraSpeech('fish-free', '你好', { fishApiKey: 'k', fishReferenceId: 'bad' }, fetchImpl),
    /32 位/,
  );
});

test('Breeze cloud：xi-api-key 鉴权，音色 id 编码进路径，语气参数不发', async () => {
  const { calls, fetchImpl } = recorder(res(mp3()));
  const cfg = { breeze: { mode: 'cloud', key: 'brz_key', voiceId: '音色 A', instructions: '轻声' } };
  await extraSpeech('breeze', '你好', cfg, fetchImpl);
  assert.ok(calls[0].url.startsWith('https://api.breeze.blue/v1/text-to-speech/%E9%9F%B3%E8%89%B2%20A'));
  assert.ok(calls[0].url.includes('output_format=mp3_24000_128'));
  assert.equal(calls[0].init.headers['xi-api-key'], 'brz_key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.instructions, undefined, 'cloud 发了 instructions 音色会漂');
  assert.equal(body.voice_settings, undefined);
});

test('Breeze local：multipart 无鉴权，带 instruction 和 cfg_scale，409 给明确提示', async () => {
  const { calls, fetchImpl } = recorder(res(mp3(), { status: 409 }));
  const cfg = { breeze: { mode: 'local', url: 'http://127.0.0.1:7860', instructions: '轻声', guidanceScale: 2 } };
  await assert.rejects(extraSpeech('breeze', '你好', cfg, fetchImpl), /还在合成/);
  assert.equal(calls[0].url, 'http://127.0.0.1:7860/v1/audio/speech');
  assert.equal(calls[0].init.headers?.['xi-api-key'], undefined);
  const form = calls[0].init.body;
  assert.equal(form.get('instruction'), '轻声');
  assert.equal(form.get('cfg_scale'), '2');
});

test('MiniMax：hex mp3 解码，emotion=auto 不传，错误码挡下', async () => {
  const hex = 'FFFB' + '11'.repeat(500);
  const { calls, fetchImpl } = recorder(res(JSON.stringify({ data: { audio: hex }, base_resp: { status_code: 0 } }), { contentType: 'application/json' }));
  const out = await extraSpeech('minimax', '你好', { minimax: { apiKey: 'sk-secret' } }, fetchImpl);
  assert.equal(calls[0].url, 'https://api.minimax.cn/v1/t2a_v2');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-secret');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.voice_setting.emotion, undefined);
  assert.equal(body.audio_setting.sample_rate, 32000);
  assert.equal(out.audio.subarray(0, 2).toString('hex'), 'fffb');
  const bad = JSON.stringify({ base_resp: { status_code: 1004 } });
  await assert.rejects(
    extraSpeech('minimax', '你好', { minimax: { apiKey: 'k' } }, recorder(res(bad, { contentType: 'application/json' })).fetchImpl),
    /1004/,
  );
});

test('auto：edge 成功就用 edge，失败（非 Windows）原样抛错', async () => {
  const edgeSpeech = async () => ({ audio: mp3(), contentType: 'audio/mpeg' });
  const out = await extraSpeech('auto', '你好', {}, null, { edgeSpeech });
  assert.equal(out.contentType, 'audio/mpeg');
  const broken = async () => { throw new Error('edge 挂了'); };
  if (process.platform !== 'win32') {
    await assert.rejects(extraSpeech('auto', '你好', {}, null, { edgeSpeech: broken }), /edge 挂了/);
  }
});

test('配置完整性：各家缺凭证时报未完成，auto 永远可用', () => {
  assert.equal(extraConfigured('auto', {}), true);
  assert.equal(extraConfigured('fish-free', {}), false);
  assert.equal(extraConfigured('fish-free', { fishApiKey: 'k' }), true);
  assert.equal(extraConfigured('volcano', { volcano: { apiKey: 'k' } }), true);
  assert.equal(extraConfigured('minimax', { minimax: { apiKey: 'k' } }), true);
  assert.equal(extraConfigured('breeze', { breeze: { mode: 'cloud', key: 'k' } }), false, 'cloud 还缺音色 id');
  assert.equal(extraConfigured('breeze', { breeze: { mode: 'cloud', key: 'k', voiceId: 'v' } }), true);
  assert.equal(extraConfigured('breeze', { breeze: { mode: 'local', url: 'http://x' } }), true);
});

/** 火山真实返回：code=0 带 base64 数据，最后 code=20000000 是结束包 */
function volcanoStream() {
  const data = mp3().toString('base64');
  return JSON.stringify({ header: { code: 0 }, data })
    + JSON.stringify({ header: { code: 20000000 } });
}
