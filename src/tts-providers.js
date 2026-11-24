/**
 * 额外语音 provider（对标 aurabot 的声音来源）。
 * ==============================================
 *
 * 这里只做「文本 → 音频字节」，不碰配置存盘、不碰 QQ 发送、不碰额度。
 * 和 tts.js 里原有的几个 provider 一样：端点、密钥、模型全来自主人配置，
 * 模型只能给文本，不能给地址和凭证。
 *
 * 设计约束（改这个文件前先读）：
 *   · 纯函数、依赖注入 fetchImpl，单测不用真联网；
 *   · 出错抛 Error，调用方 tts.js 包成 TtsError 并做冷却；
 *   · 密钥不进错误消息、不进 URL 日志——上游常把请求原样回显；
 *   · 返回裸音频 + contentType，SILK 转换由框架外接协议负责。
 *
 * 各家的协议细节来自 aurabot beta 工作树（2026-11-24 逐条核对）：
 *   cosyvoice / volcano / breeze / minimax / fish-free / windows / auto。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 本模块管理的 provider（tts.js 用它扩 status/synthesize 的白名单） */
export const EXTRA_PROVIDERS = [
  'auto', 'cosyvoice', 'volcano', 'fish-free', 'breeze', 'minimax', 'windows',
];

const TIMEOUT_MS = 120_000;
const MAX_AUDIO = 10 * 1024 * 1024;

function cfgOf(cfg, key) {
  const v = cfg?.[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function trim(value) {
  return String(value ?? '').trim();
}

/** 根地址校验：只收 http(s)、不带凭证/查询/片段，和 tts.js 的 configuredUrl 同口径 */
function baseUrl(value, label) {
  let u;
  try { u = new URL(trim(value)); } catch { throw new Error(`${label} 地址格式不正确`); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error(`${label} 地址只允许不含凭证、查询参数或片段的 HTTP(S) URL`);
  }
  return u.href.replace(/\/+$/, '');
}

/** 读有上限的响应体：content-length 超了直接取消，不把大文件读进内存 */
async function limitedBody(res, limit = MAX_AUDIO) {
  const n = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(n) && n > limit) {
    await res.body?.cancel?.();
    throw new Error('语音服务返回内容超过大小上限');
  }
  if (!res.body) throw new Error('语音服务返回空响应');
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new Error('语音服务返回内容超过大小上限');
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.cancel?.().catch?.(() => {});
    reader.releaseLock?.();
  }
  const out = Buffer.concat(chunks);
  if (out.length < 100) throw new Error('语音服务返回的音频太短');
  return out;
}

/** 播放用的 MIME：按魔数认，裸 PCM 交给调用方包 WAV */
function audioMime(buf, contentType) {
  const ct = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (ct.startsWith('audio/')) return ct === 'audio/mp3' ? 'audio/mpeg' : ct;
  const head = buf.subarray(0, 4).toString('ascii');
  if (head === 'RIFF') return 'audio/wav';
  if (head === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (head === 'OggS') return 'audio/ogg';
  return '';
}

/** 裸 PCM16（CosyVoice 官方 FastAPI 就是这么返回）→ WAV 头 */
function pcmToWav(pcm, sampleRate) {
  const rate = Math.max(8000, Math.min(48000, Number(sampleRate) || 22050));
  const n = Math.floor(pcm.length / 2);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  pcm.copy(buf, 44, 0, n * 2);
  return buf;
}

function finishAudio(buf, contentType, sampleRate) {
  const mime = audioMime(buf, contentType);
  if (mime) return { audio: buf, contentType: mime };
  if (buf.length >= 2) return { audio: pcmToWav(buf, sampleRate), contentType: 'audio/wav' };
  throw new Error('语音服务返回的音频格式无法识别');
}

/** 火山音色 → 资源 ID（1.0/2.0 混用会 speaker permission denied） */
export function volcanoResourceFor(speaker) {
  return String(speaker || '').includes('uranus') ? 'seed-tts-2.0' : 'seed-tts-1.0';
}

/** 火山返回的是多段首尾相连的 JSON，按大括号配平切开 */
export function splitJsonObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; }
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out;
}

/** HTTP 错误说清是哪一家，但不回显 URL（可能带密钥）和响应体 */
function httpError(res, label) {
  const code = res.status;
  const hint = code === 401 || code === 403 ? '（检查 API Key）'
    : code === 402 ? '（账户余额不足）'
      : code === 429 ? '（请求太频繁，稍后再试）' : '';
  return new Error(`${label} HTTP ${code}${hint}`);
}

async function fetchWith(fetchImpl, url, init, signal) {
  return fetchImpl(url, { ...init, redirect: 'error', signal });
}

/** 本地 CosyVoice 官方 FastAPI：/inference_sft 或 /inference_instruct */
async function cosyvoiceSpeech(text, cfg, fetchImpl, signal) {
  const c = cfgOf(cfg, 'cosyvoice');
  const base = baseUrl(c.url || 'http://127.0.0.1:50000', 'CosyVoice');
  const instructPath = c.mode === 'instruct' && trim(c.instruct);
  const form = new URLSearchParams({
    tts_text: text,
    spk_id: trim(c.spkId) || '中文女',
  });
  if (instructPath) form.set('instruct_text', trim(c.instruct));
  const res = await fetchWith(fetchImpl, `${base}/${instructPath ? 'inference_instruct' : 'inference_sft'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  }, signal);
  if (!res.ok) throw httpError(res, 'CosyVoice');
  return finishAudio(await limitedBody(res), res.headers?.get?.('content-type'), c.sampleRate || 22050);
}

/** 火山引擎：鉴权在 header，返回多段 JSON 内 base64 mp3 */
async function volcanoSpeech(text, cfg, fetchImpl, signal) {
  const c = cfgOf(cfg, 'volcano');
  const key = trim(c.apiKey);
  if (!key) throw new Error('豆包语音需要 API Key');
  const speaker = trim(c.voiceType) || 'zh_female_vv_uranus_bigtts';
  const resourceId = trim(c.resourceId) || volcanoResourceFor(speaker);
  const speed = Number(c.speedRatio) || 1;
  const audioParams = { format: 'mp3', sample_rate: 24000 };
  if (Math.abs(speed - 1) > 0.001) audioParams.speech_rate = Math.round((speed - 1) * 100);
  const res = await fetchWith(fetchImpl, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Api-Key': key,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: 'roost' },
      req_params: { text, speaker, audio_params: audioParams },
    }),
  }, signal);
  if (!res.ok) throw httpError(res, '豆包语音');
  const raw = await res.text();
  const chunks = [];
  for (const part of splitJsonObjects(raw)) {
    let json;
    try { json = JSON.parse(part); } catch { continue; }
    const code = Number(json?.header?.code);
    if (code !== 0 && code !== 20000000) throw new Error(`豆包语音返回错误码 ${code}`);
    if (json?.data) chunks.push(Buffer.from(json.data, 'base64'));
  }
  // 最后一段是 code=20000000 的结束包，不带 data
  const buf = Buffer.concat(chunks);
  if (buf.length < 100) throw new Error('豆包语音没返回音频');
  return { audio: buf, contentType: 'audio/mpeg' };
}

/** Fish Audio S2.1 Pro Free：模型名在 header，音色 ID 是 32 位 hex */
async function fishSpeech(text, cfg, fetchImpl, signal) {
  const key = trim(cfg?.fishApiKey);
  if (!key) throw new Error('Fish Audio 需要 API Key');
  const referenceId = trim(cfg?.fishReferenceId);
  if (referenceId && !/^[a-f\d]{32}$/i.test(referenceId)) throw new Error('Fish 音色 ID 应为 32 位十六进制字符');
  const res = await fetchWith(fetchImpl, 'https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      model: 's2.1-pro-free',
    },
    body: JSON.stringify({ text, format: 'mp3', ...(referenceId ? { reference_id: referenceId } : {}) }),
  }, signal);
  if (!res.ok) throw httpError(res, 'Fish Audio');
  const buf = await limitedBody(res);
  if (buf.subarray(0, 3).toString('ascii') !== 'ID3' && !(buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
    throw new Error('Fish Audio 没返回 MP3 音频');
  }
  return { audio: buf, contentType: 'audio/mpeg' };
}

/** Breeze：cloud 走 xi-api-key，local 走 multipart 无鉴权 */
async function breezeSpeech(text, cfg, fetchImpl, signal) {
  const c = cfgOf(cfg, 'breeze');
  const base = baseUrl(c.url || (c.mode === 'local' ? 'http://127.0.0.1:7860' : 'https://api.breeze.blue'), 'Breeze');
  if (c.mode === 'local') {
    const form = new FormData();
    form.set('text', text);
    if (trim(c.instructions)) form.set('instruction', trim(c.instructions));
    const scale = Number(c.guidanceScale);
    if (Number.isFinite(scale) && scale > 0) form.set('cfg_scale', String(scale));
    const res = await fetchWith(fetchImpl, `${base}/v1/audio/speech`, { method: 'POST', body: form }, signal);
    if (!res.ok) {
      throw new Error(res.status === 409 ? 'Breeze 上一句还在合成，稍后再试' : `Breeze HTTP ${res.status}`);
    }
    return finishAudio(await limitedBody(res), res.headers?.get?.('content-type'), c.sampleRate || 24000);
  }
  const key = trim(c.key);
  if (!key) throw new Error('Breeze 云端需要 API Key');
  const voiceId = trim(c.voiceId);
  if (!voiceId) throw new Error('Breeze 云端需要音色 ID');
  const format = trim(c.outputFormat) || 'mp3_24000_128';
  const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}`
    + `?output_format=${encodeURIComponent(format)}&delivery=sync`;
  const body = { text, model_id: trim(c.model) || 'breeze-tts-2' };
  if (trim(c.languageCode)) body.language_code = trim(c.languageCode);
  const res = await fetchWith(fetchImpl, url, {
    method: 'POST',
    headers: { 'xi-api-key': key, accept: 'application/json, audio/*', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, signal);
  if (!res.ok) throw httpError(res, 'Breeze');
  const rate = Number((format.match(/mp3_(\d+)/) || [])[1]) || 24000;
  return finishAudio(await limitedBody(res), res.headers?.get?.('content-type'), rate);
}

/** MiniMax：返回 JSON.data.audio 是 hex 编码的 mp3 */
async function minimaxSpeech(text, cfg, fetchImpl, signal) {
  const c = cfgOf(cfg, 'minimax');
  const key = trim(c.apiKey);
  if (!key) throw new Error('MiniMax 需要 API Key');
  const base = baseUrl(c.baseUrl || 'https://api.minimax.cn', 'MiniMax');
  const voiceSetting = {
    voice_id: trim(c.voiceId) || 'Chinese (Mandarin)_Soft_Girl',
    speed: Number(c.speed) || 1,
    vol: 1,
    pitch: Number.isFinite(Number(c.pitch)) ? Number(c.pitch) : 0,
  };
  const emotion = trim(c.emotion) || 'auto';
  if (emotion !== 'auto') voiceSetting.emotion = emotion;
  const res = await fetchWith(fetchImpl, `${base}/v1/t2a_v2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: trim(c.model) || 'speech-2.8-turbo',
      text,
      stream: false,
      voice_setting: voiceSetting,
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      output_format: 'hex',
      language_boost: 'Chinese',
    }),
  }, signal);
  if (!res.ok) throw httpError(res, 'MiniMax');
  const json = await res.json();
  const status = Number(json?.base_resp?.status_code);
  if (status) throw new Error(`MiniMax 返回错误码 ${status}`);
  const hex = String(json?.data?.audio || '');
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 800) throw new Error('MiniMax 没返回有效的 mp3 音频');
  return { audio: Buffer.from(hex, 'hex'), contentType: 'audio/mpeg' };
}

/**
 * Windows 自带：PowerShell 调 .NET System.Speech，写 WAV 临时文件。
 * 这是 aurabot 的做法（不是 pyttsx3），无 Python 依赖，仅 Windows 可用。
 */
export async function windowsSpeech(text, { tmpDir, runImpl } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows 语音只支持 Windows');
  const dir = tmpDir || join(process.env.TEMP || process.env.TMPDIR || '.', 'roost-tts');
  mkdirSync(dirname(dir), { recursive: true });
  const file = join(dir, `${randomUUID()}.wav`);
  const script =
    'Add-Type -AssemblyName System.Speech;'
    + '$t=[Console]::In.ReadToEnd();'
    + '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;'
    + "$zh=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -eq 'zh-CN'}|Select-Object -First 1;"
    + 'if($zh){$s.SelectVoice($zh.VoiceInfo.Name)};'
    + `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}');$s.Speak($t);$s.Dispose()`;
  const run = runImpl || ((cmd, args, input) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, err }));
    child.stdin.end(input);
  }));
  const r = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `[Console]::InputEncoding=[Text.Encoding]::UTF8;${script}`,
  ], text);
  if (!existsSync(file) || readFileSync(file).length < 1000) {
    throw new Error(`Windows 语音失败：${String(r?.err || '').slice(-200)}`);
  }
  const audio = readFileSync(file);
  try { unlinkSync(file); } catch { /* 临时文件删不掉不影响发音 */ }
  return { audio, contentType: 'audio/wav' };
}

/**
 * 总入口。auto 在这里做回退：先 edge（由 tts.js 传入 edgeSpeech），失败给 windows。
 * @param {string} provider
 * @param {object} cfg 完整 tts 配置
 * @param {function} fetchImpl
 * @param {object} deps { edgeSpeech, dataDir, runImpl }
 */
export async function extraSpeech(provider, text, cfg, fetchImpl, deps = {}) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  switch (provider) {
    case 'cosyvoice': return cosyvoiceSpeech(text, cfg, fetchImpl, signal);
    case 'volcano': return volcanoSpeech(text, cfg, fetchImpl, signal);
    case 'fish-free': return fishSpeech(text, cfg, fetchImpl, signal);
    case 'breeze': return breezeSpeech(text, cfg, fetchImpl, signal);
    case 'minimax': return minimaxSpeech(text, cfg, fetchImpl, signal);
    case 'windows': return windowsSpeech(text, { tmpDir: deps.dataDir?.(), runImpl: deps.runImpl });
    case 'auto': {
      if (typeof deps.edgeSpeech !== 'function') throw new Error('自动语音缺少微软朗读实现');
      try {
        return await deps.edgeSpeech(text, cfg);
      } catch (e) {
        if (process.platform !== 'win32') throw e;
        return windowsSpeech(text, { tmpDir: deps.dataDir?.(), runImpl: deps.runImpl });
      }
    }
    default: throw new Error(`未支持的语音 provider：${provider}`);
  }
}

/** 给 status() 用：这个 provider 的配置填完整了没有 */
export function extraConfigured(provider, cfg) {
  switch (provider) {
    case 'fish-free': return Boolean(trim(cfg?.fishApiKey));
    case 'volcano': return Boolean(trim(cfgOf(cfg, 'volcano').apiKey));
    case 'minimax': return Boolean(trim(cfgOf(cfg, 'minimax').apiKey));
    case 'breeze': {
      const c = cfgOf(cfg, 'breeze');
      return c.mode === 'local' ? Boolean(trim(c.url)) : Boolean(trim(c.key) && trim(c.voiceId));
    }
    case 'cosyvoice': return Boolean(trim(cfgOf(cfg, 'cosyvoice').url || 'http://127.0.0.1:50000'));
    case 'windows': return process.platform === 'win32';
    case 'auto': return true;
    default: return false;
  }
}
