/**
 * 5.3 语音试听：草稿、不落盘、不占配额、同一条 SILK 校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTts } from '../src/tts.js';
import { runPreview, PREVIEW_TEXT_LIMIT } from '../src/tts-preview.js';

const WAV_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
]);

/** 一个不含任何磁盘 IO 的假 TTS 上游 */
function fakeSynth({ audio = WAV_BYTES, contentType = 'audio/wav' } = {}) {
  const calls = [];
  return {
    calls,
    fn: async (text, opts) => {
      calls.push({ text, opts });
      return { audio, contentType };
    },
  };
}

test('试听用整份草稿合成，并强制只对本次打开开关', async () => {
  const draft = { enabled: false, provider: 'edge', edge: { voice: 'zh-CN-YunxiNeural' }, maxChars: 300 };
  const s = fakeSynth();
  const r = await runPreview({ text: '你好', draft, synth: s.fn });
  assert.equal(r.ok, true);
  assert.equal(r.usedDraft, true);
  assert.equal(r.provider, 'edge');
  assert.equal(s.calls[0].opts.draft.enabled, true, '没启用语音的人也能先听听');
  assert.equal(s.calls[0].opts.draft.edge.voice, 'zh-CN-YunxiNeural');
  assert.equal(draft.enabled, false, '草稿本身一个字段都不许被改');
  assert.equal(r.audio, Buffer.from(WAV_BYTES).toString('base64'));
  assert.equal(r.contentType, 'audio/wav');
  assert.equal(r.bytes, WAV_BYTES.length);
});

test('同一份字节送进 SILK 校验：通过 / 需转码 / 旧框架，都不影响播放', async () => {
  const s = fakeSynth();
  const ok = await runPreview({
    text: '你好', draft: {}, synth: s.fn,
    convert: async () => ({ ok: true, size: 1234, via: 'wav', ms: 900 }),
  });
  assert.equal(ok.silk.ok, true);
  assert.equal(ok.silk.size, 1234);
  assert.equal(ok.silk.via, 'wav');

  const need = await runPreview({
    text: '你好', draft: {}, synth: s.fn,
    convert: async () => ({ ok: false, reason: 'needs_transcode', message: '发送前要 ffmpeg 重采样' }),
  });
  assert.equal(need.ok, true, '校验没过也照样能听');
  assert.equal(need.silk.ok, false);
  assert.match(need.silk.message, /ffmpeg/);

  const old = await runPreview({
    text: '你好', draft: {}, synth: s.fn,
    convert: async () => { throw new Error('no such method: media.convert'); },
  });
  assert.equal(old.ok, true);
  assert.equal(old.silk.reason, 'unsupported');

  const none = await runPreview({ text: '你好', draft: {}, synth: s.fn });
  assert.equal(none.silk.reason, 'unchecked');
});

test('空文本 / 超长 / 空音频 / 合成失败：状态码与原因都传回面板', async () => {
  await assert.rejects(
    () => runPreview({ text: '   ', synth: fakeSynth().fn }),
    (e) => e.status === 400 && e.code === 'empty_text',
  );
  await assert.rejects(
    () => runPreview({ text: 'x'.repeat(PREVIEW_TEXT_LIMIT + 1), synth: fakeSynth().fn }),
    (e) => e.status === 413 && e.code === 'text_too_long',
  );
  await assert.rejects(
    () => runPreview({ text: '你好', synth: fakeSynth({ audio: [] }).fn }),
    (e) => e.status === 502 && e.code === 'invalid_audio_response',
  );
  await assert.rejects(
    () => runPreview({
      text: '你好',
      synth: async () => { const e = new Error('上游 502'); e.status = 502; e.code = 'upstream_error'; throw e; },
    }),
    (e) => e.status === 502 && e.code === 'upstream_error' && /上游/.test(e.message),
  );
});

test('真实 synthesize：草稿覆盖 provider 参数，且不碰已保存配置、不写盘', async () => {
  const dataDir = join(tmpdir(), '__roost-tts-preview-should-not-exist__');
  const saved = {
    enabled: true, provider: 'openai',
    baseUrl: 'https://saved.example.com/v1', model: 'model-saved', voice: 'voice-saved',
  };
  const cfg = { tts: saved };
  const calls = [];
  const tts = createTts({
    cfgOf: () => cfg,
    dataDir: () => dataDir,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'audio/mpeg' : '0') },
        arrayBuffer: async () => Uint8Array.from([0x49, 0x44, 0x33, 1, 2, 3]).buffer,
      };
    },
  });

  /** 草稿：换了地址、音色、语速，但 enabled 故意是 false（试听要强制开） */
  const draft = { ...saved, baseUrl: 'https://draft.example.com/v1', voice: 'voice-draft', speed: 1.5, enabled: false };
  const r = await runPreview({ text: '试听一下', draft, synth: (t, o) => tts.synthesize(t, o) });
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /draft\.example\.com/);
  assert.equal(calls[0].body.voice, 'voice-draft');
  assert.equal(calls[0].body.speed, 1.5);

  /** 已保存配置一个字节没动，再合成一次还是走旧地址 */
  assert.equal(cfg.tts.baseUrl, 'https://saved.example.com/v1');
  assert.equal(cfg.tts.voice, 'voice-saved');
  assert.equal(cfg.tts.enabled, true);
  await tts.synthesize('第二次');
  assert.match(calls[1].url, /saved\.example\.com/);
  assert.equal(calls[1].body.voice, 'voice-saved');

  /** 不落盘：给一个压根不存在的数据目录，试听完它也不该出现 */
  assert.equal(existsSync(dataDir), false);
});

test('接线：面板路由 / 前端按钮 / 不碰 quota / 走同一个 synthesize', () => {
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.ok(host.includes("route('/tts/preview'"), '面板要有试听路由');
  assert.ok(host.includes('tts.synthesize(t, o)'), '必须复用同一个合成入口');
  assert.ok(host.includes("roost.rpc('media.convert'"), 'SILK 校验接跨仓方法');
  const block = host.slice(host.indexOf("route('/tts/preview'"), host.indexOf("route('/tts/install'"));
  assert.equal(block.includes('quota.charge'), false, '试听不占配额');
  assert.equal(block.includes('writeFile'), false, '试听不写盘');
  assert.equal(block.includes('saveCfg'), false);

  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.ok(client.includes("post('/tts/preview'"), '前端要调试听');
  assert.ok(client.includes('试验') === false, '别把「试听」写成错别字');
  assert.ok(client.includes("}, pvBusy ? '合成中…' : '试听')"), '试听按钮要在');
  assert.ok(client.includes('draft: draft || {}'), '未保存草稿要一起送过去');
});
