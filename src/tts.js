import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/ogg', 'audio/aac', 'audio/webm', 'audio/opus', 'audio/flac', 'audio/l16',
]);

/**
 * 本地 ONNX 模型清单。
 *
 * 每个模型是一组固定文件，`required` 只列「缺了就跑不起来」的那几个——
 * 一键安装完成后用它判断装没装好，不去猜目录里应该有啥。
 *
 * `dir` 是解压出来的目录名（sherpa 的 tar.bz2 里就是这个顶层目录），
 * 安装器按这个名字解压，`tts.js` 按这个名字找模型，两边必须一致。
 */
export const SHERPA_MODELS = {
  aishell3: {
    dir: 'vits-icefall-zh-aishell3',
    label: 'aishell3（下载 30MB · 占用 204MB · 8kHz · 174 个音色）',
    /** 一键安装从这里下（sherpa 官方 release，tar.bz2） */
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2',
    /**
     * 解压后大约占多少磁盘。30MB 是压缩包，解压完 204MB——
     * 其中 `rule.far`（多音字/数字规则库）一个文件就 173MB。
     * 它让「行长/银行」「2024年」这类读得准，所以留着。
     */
    approxMB: 204,
    required: ['model.onnx', 'tokens.txt', 'lexicon.txt'],
    /** 数字/日期读法规则。有就用，没有也能合成，只是「2024年」会读错 */
    ruleFsts: ['date.fst', 'phone.fst', 'number.fst', 'new_heteronym.fst'],
    /** 多音字规则库（173MB）。让「行长/银行」这类读对，装上就带着 */
    ruleFars: ['rule.far'],
    /** 174 个说话人里挑的一个偏自然的，用户可以在面板里改 */
    defaultSid: 88,
  },
};

export class TtsError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.status = status;
  }
}

function normalizeMime(value) {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
  if (!AUDIO_TYPES.has(mime)) return '';
  if (mime === 'audio/mp3') return 'audio/mpeg';
  if (mime === 'audio/x-wav' || mime === 'audio/wave') return 'audio/wav';
  return mime;
}

function configuredUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new TtsError('invalid_config', `${label} 地址格式不正确`, 400);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TtsError('invalid_config', `${label} 地址只允许不含凭证、查询参数或片段的 HTTP(S) URL`, 400);
  }
  return url;
}

function requestUrl(base, suffix, label) {
  const url = configuredUrl(base, label);
  const prefix = url.pathname.replace(/\/+$/, '');
  url.pathname = `${prefix}/${suffix}`.replace(/\/{2,}/g, '/');
  return url;
}

function gptEndpoint(base, endpointPath) {
  const url = configuredUrl(base, 'GPT-SoVITS');
  const raw = String(endpointPath || '/').trim();

  /**
   * **先解码再校验。**
   *
   * 只查字面 `..` 不够：`/%2e%2e/admin` 里一个点都没有，但它被赋给
   * `url.pathname` 之后，服务端解码就成了 `/../admin`（2026-11-03 审查发现）。
   * 另外 `//evil.com/x` 是协议相对地址，直接赋 pathname 会把 host 换掉。
   */
  let path;
  try {
    path = decodeURIComponent(raw);
  } catch {
    throw new TtsError('invalid_config', 'GPT-SoVITS endpointPath 不是合法的 URL 路径', 400);
  }
  if (
    !path.startsWith('/')
    || path.startsWith('//')
    || path.includes('..')
    || path.includes('?')
    || path.includes('#')
    /**
     * 解完还留着 `%` 说明是**双重编码**（`/%252e%252e/admin`）：
     * 第一次解码得到 `/%2e%2e/admin`，看着人畜无害，但 URL 解析器
     * 会再把 `%2e%2e` 折叠成 `..`，最后请求到 `/admin`（2026-11-04 实测）。
     * 正常路由里不会出现裸 `%`，直接拒。
     */
    || path.includes('%')
  ) {
    throw new TtsError('invalid_config', 'GPT-SoVITS endpointPath 必须是安全的绝对路由路径', 400);
  }
  url.pathname = path;
  return url;
}

function audioResult(bytes, contentType) {
  const audio = Buffer.from(bytes ?? []);
  const mime = normalizeMime(contentType);
  if (!audio.length) throw new TtsError('empty_audio', '语音服务返回了空音频', 502);
  if (!mime) throw new TtsError('unsupported_audio', '语音服务返回了不支持的音频格式', 502);
  return { audio, contentType: mime };
}

/**
 * 一段语音最多收多大。
 *
 * 300 字的中文语音也就几十 KB；设上限是为了防上游返回错东西（比如把整个
 * wav 库、一段视频当音频回过来）。这些字节会在宿主和插件里各留一份，
 * 没有上限时一次坏响应就能把两边内存吃掉。
 */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

async function readResponse(res) {
  if (!res?.ok) {
    if (res?.status === 401 || res?.status === 403) {
      throw new TtsError('upstream_auth', '语音服务鉴权失败', 502);
    }
    if (res?.status === 429) throw new TtsError('upstream_rate_limited', '语音服务当前限流', 503);
    throw new TtsError('upstream_error', `语音服务请求失败（HTTP ${Number(res?.status) || 0}）`, 502);
  }
  const mime = normalizeMime(res.headers?.get?.('content-type'));
  if (!mime) throw new TtsError('unsupported_audio', '语音服务没有返回受支持的音频 Content-Type', 502);
  const declared = Number(res.headers?.get?.('content-length') || 0);
  if (declared > MAX_AUDIO_BYTES) {
    throw new TtsError('audio_too_large', '语音服务返回的音频太大', 502);
  }
  const audio = await audioResult(await res.arrayBuffer(), mime);
  if (audio.audio.length > MAX_AUDIO_BYTES) {
    throw new TtsError('audio_too_large', '语音服务返回的音频太大', 502);
  }
  return audio;
}

function timeoutSignal(seconds) {
  return AbortSignal.timeout(Math.max(1, Math.min(300, Number(seconds) || 30)) * 1000);
}

function publicError(error) {
  if (error instanceof TtsError) return error;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new TtsError('timeout', '语音服务请求超时', 504);
  }
  return new TtsError('upstream_error', '语音服务调用失败', 502);
}

/**
 * Float32 PCM → 16bit WAV。
 *
 * sherpa 只给了 `writeWave(路径, ...)`，那要落一次盘再读回来。语音每次都是
 * 一次性的小文件，为了几十 KB 走两趟磁盘不值当，所以直接编码成 Buffer。
 *
 * 采样率取模型自己的（aishell3 是 8000Hz），不重采样——重采样只会更慢、
 * 更糊，而且 ai-chat 那边转 silk 时还会再处理一次。
 */
export function encodeWav(samples, sampleRate) {
  const rate = Number(sampleRate) || 16000;
  const n = samples?.length || 0;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    const v = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/**
 * TTS provider registry. All endpoints, credentials and model paths come from owner config;
 * the model can only provide the text to synthesize.
 *
 * provider：
 *   · openai      —— OpenAI 兼容 /audio/speech，云端，要 key
 *   · gpt-sovits  —— 本地 GPT-SoVITS 原生 API，自己起服务
 *   · sherpa      —— 本地 ONNX 推理（sherpa-onnx-node），完全离线，面板可一键装
 */
export function createTts({
  cfgOf = () => ({}),
  fetchImpl = (...args) => fetch(...args),
  loadSherpa,
  dataDir = () => '',
  log = () => {},
} = {}) {
  /** 引擎实例很贵（加载 30MB 模型），按「运行时 + 模型目录 + 线程数」缓存 */
  let engineCache = null;

  /**
   * 上游刚刚失败过吗。
   *
   * 为什么要记：`status()` 只能看**配置填没填**，看不出服务在不在。
   * 用户配了 GPT-SoVITS 但没启动 API（或者地址填成了 WebUI 端口）时，
   * `configured` 一直是 true → ai-chat 的 `ttsOn` 一直是 true → 每轮都
   * 教模型写 `<<say>>`、每轮都合成失败、每轮都降级发文字。
   * 表现就是「语音一直是文字」，而且日志里每轮一条 502。
   *
   * 所以失败一次就冷却一分钟：这期间 `/capabilities` 报不可用，ai-chat
   * 就不会再给模型这个能力。服务修好后自动恢复，不用重启。
   */
  const FAIL_COOLDOWN_MS = 60_000;
  let lastFail = { at: 0, provider: '', code: '' };

  function cooling(provider) {
    return Boolean(lastFail.at)
      && lastFail.provider === provider
      && Date.now() - lastFail.at < FAIL_COOLDOWN_MS;
  }

  function config() {
    const cfg = cfgOf()?.tts ?? {};
    return cfg && typeof cfg === 'object' ? cfg : {};
  }

  function runtimeDir() {
    return join(dataDir(), 'tts-runtime');
  }

  function modelDirOf(sherpa) {
    const custom = String(sherpa?.modelDir || '').trim();
    if (custom) return custom;
    const key = String(sherpa?.model || 'aishell3');
    const spec = SHERPA_MODELS[key] || SHERPA_MODELS.aishell3;
    return join(dataDir(), 'tts-models', spec.dir);
  }

  /** 本地引擎装没装、模型全不全——面板和 /capabilities 都靠这个判断 */
  function sherpaState(sherpa) {
    const key = String(sherpa?.model || 'aishell3');
    if (!SHERPA_MODELS[key]) {
      return { configured: false, reason: 'unsupported_model' };
    }
    const runtime = runtimeDir();
    if (!existsSync(join(runtime, 'node_modules', 'sherpa-onnx-node'))) {
      return { configured: false, reason: 'runtime_missing' };
    }
    const dir = modelDirOf(sherpa);
    const missing = SHERPA_MODELS[key].required.filter((f) => !existsSync(join(dir, f)));
    if (missing.length) return { configured: false, reason: 'model_missing', missing, modelDir: dir };
    return { configured: true, modelDir: dir };
  }

  async function status() {
    const cfg = config();
    const enabled = cfg.enabled === true;
    const provider = String(cfg.provider || 'openai');
    if (!enabled) return { enabled: false, provider, configured: false };
    if (!['openai', 'gpt-sovits', 'sherpa'].includes(provider)) {
      return { enabled: true, provider, configured: false, reason: 'unsupported_provider' };
    }
    if (provider === 'openai') {
      const configured = Boolean(String(cfg.baseUrl || '').trim() && String(cfg.model || '').trim());
      if (!configured) return { enabled: true, provider, configured, reason: 'configuration_incomplete' };
      if (cooling(provider)) return { enabled: true, provider, configured: false, reason: 'upstream_unreachable' };
      return { enabled: true, provider, configured };
    }
    if (provider === 'gpt-sovits') {
      const gpt = cfg.gptSovits && typeof cfg.gptSovits === 'object' ? cfg.gptSovits : {};
      const configured = Boolean(gpt.baseUrl && gpt.referWavPath && gpt.promptText && gpt.promptLanguage && gpt.textLanguage);
      if (!configured) return { enabled: true, provider, configured, reason: 'configuration_incomplete' };
      if (cooling(provider)) return { enabled: true, provider, configured: false, reason: 'upstream_unreachable' };
      return { enabled: true, provider, configured };
    }
    return { enabled: true, provider, ...sherpaState(cfg.sherpa) };
  }

  async function synthesize(text) {
    const cfg = config();
    if (cfg.enabled !== true) throw new TtsError('disabled', '语音合成未启用', 409);

    const input = String(text ?? '').trim();
    if (!input) throw new TtsError('empty_text', '缺少待合成文本', 400);
    const maxChars = Math.max(1, Math.min(5000, Number(cfg.maxChars) || 300));
    if (input.length > maxChars) throw new TtsError('text_too_long', `语音文本超过 ${maxChars} 字`, 413);

    const provider = String(cfg.provider || 'openai');
    try {
      let result;
      if (provider === 'openai') result = await openAiSpeech(input, cfg);
      else if (provider === 'gpt-sovits') result = await gptSovitsSpeech(input, cfg);
      else if (provider === 'sherpa') result = await sherpaSpeech(input, cfg);
      else throw new TtsError('unsupported_provider', '未支持这个语音 provider', 400);
      /** 成功一次就把冷却清掉，服务恢复了不用等满一分钟 */
      lastFail = { at: 0, provider: '', code: '' };
      return result;
    } catch (error) {
      const safe = publicError(error);
      /**
       * 只有「服务那边出问题」才进冷却。配置错、文本超长这类是调用方
       * 自己的问题，冷却了反而会把错误藏起来——用户改了配置还得等一分钟。
       */
      if (!['invalid_config', 'unsupported_provider', 'text_too_long', 'empty_text'].includes(safe.code)) {
        lastFail = { at: Date.now(), provider, code: safe.code };
      }
      log(`TTS ${provider} 失败：${safe.code}`);
      throw safe;
    }
  }

  async function openAiSpeech(text, cfg) {
    const base = String(cfg.baseUrl || '').trim();
    const model = String(cfg.model || '').trim();
    if (!base || !model) throw new TtsError('invalid_config', 'OpenAI-compatible TTS 需要配置 baseUrl 和 model', 400);
    const url = requestUrl(base, 'audio/speech', 'OpenAI-compatible TTS');
    const headers = { 'content-type': 'application/json', accept: 'audio/mpeg' };
    if (cfg.apiKey) headers.authorization = `Bearer ${String(cfg.apiKey)}`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: text,
        ...(cfg.voice ? { voice: String(cfg.voice) } : {}),
        response_format: 'mp3',
      }),
      signal: timeoutSignal(cfg.timeoutSec),
    });
    return readResponse(res);
  }

/**
 * 语种写成人话（「中文」「日文」）转成 GPT-SoVITS 要的语言代码。
 *
 * 面板上让人填「中文」比填 `zh` 好懂，但 API 只认代码。不转的话
 * 上游会返回 400 `text_lang is required`——而用户看着自己明明填了语种，
 * 完全不知道错在哪（2026-11-03 实测）。
 *
 * 认不出来的原样传：宁可让上游明确报错，也不要悄悄换成别的语言——
 * 那会合成出一段「字都对、调子全错」的音频，更难发现。
 */
const LANG_CODES = {
  中文: 'zh', 汉语: 'zh', 普通话: 'zh', zh: 'zh',
  英文: 'en', 英语: 'en', en: 'en',
  日文: 'ja', 日语: 'ja', ja: 'ja',
  粤语: 'yue', yue: 'yue',
  韩文: 'ko', 韩语: 'ko', ko: 'ko',
  自动: 'auto', auto: 'auto',
};

function langCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return LANG_CODES[raw] || LANG_CODES[raw.toLowerCase()] || raw;
}

  async function gptSovitsSpeech(text, cfg) {
    const gpt = cfg.gptSovits && typeof cfg.gptSovits === 'object' ? cfg.gptSovits : {};
    if (!gpt.baseUrl || !gpt.referWavPath || !gpt.promptText || !gpt.promptLanguage || !gpt.textLanguage) {
      throw new TtsError('invalid_config', 'GPT-SoVITS 需要配置 baseUrl、参考音频、参考文本和语种', 400);
    }
    const version = String(gpt.apiVersion || 'v1').toLowerCase();
    if (!['v1', 'v2'].includes(version)) throw new TtsError('invalid_config', 'GPT-SoVITS apiVersion 只支持 v1 或 v2', 400);
    const url = gptEndpoint(gpt.baseUrl, gpt.endpointPath || '/');
    const headers = { 'content-type': 'application/json', accept: 'audio/*' };
    const key = String(gpt.apiKey || cfg.apiKey || '');
    if (key) headers.authorization = `Bearer ${key}`;
    /**
     * v1 和 v2 的字段名**不一样**，这不是命名风格问题：
     *   · v1（api.py）：`refer_wav_path` + `prompt_language` / `text_language`
     *   · v2（api_v2.py）：`ref_audio_path` + `prompt_lang` / `text_lang`
     *
     * 之前 v2 也发了 `text_language`，上游直接 400 `text_lang is required`——
     * 而且是在真实服务上才暴露的（单测只验了字段映射，没验字段名对不对）。
     */
    const body = version === 'v2'
      ? {
          ref_audio_path: String(gpt.referWavPath),
          prompt_text: String(gpt.promptText),
          prompt_lang: langCode(gpt.promptLanguage),
          text,
          text_lang: langCode(gpt.textLanguage),
        }
      : {
          refer_wav_path: String(gpt.referWavPath),
          prompt_text: String(gpt.promptText),
          prompt_language: langCode(gpt.promptLanguage),
          text,
          text_language: langCode(gpt.textLanguage),
        };
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: timeoutSignal(cfg.timeoutSec),
    });
    return readResponse(res);
  }

  /**
   * 加载本地引擎。
   *
   * 用 `createRequire` 从 `tts-runtime` 里解析，而不是从插件自己的
   * `node_modules`——那个目录归 DSH 的插件管理器管，更新插件时会被覆盖，
   * 用户装的 23MB 原生模块会莫名其妙消失。放在数据目录里，卸载就是删目录。
   */
  function sherpaEngine(sherpa) {
    const state = sherpaState(sherpa);
    if (!state.configured) {
      const why = state.reason === 'model_missing'
        ? '本地语音模型没装全：在设置页点「一键安装」'
        : '本地语音引擎没装：在设置页点「一键安装」';
      throw new TtsError(state.reason || 'runtime_missing', why, 503);
    }

    const key = String(sherpa?.model || 'aishell3');
    const spec = SHERPA_MODELS[key];
    const threads = Math.max(1, Math.min(8, Number(sherpa?.numThreads) || 2));
    const cacheKey = `${runtimeDir()}|${state.modelDir}|${threads}`;
    if (engineCache?.key === cacheKey) return engineCache;

    if (typeof loadSherpa === 'function') {
      const fake = loadSherpa({ modelDir: state.modelDir, spec, threads });
      engineCache = { key: cacheKey, ...fake };
      return engineCache;
    }

    const req = createRequire(join(runtimeDir(), 'noop.cjs'));
    let mod;
    try {
      mod = req('sherpa-onnx-node');
    } catch {
      throw new TtsError('runtime_missing', '本地语音引擎加载失败：在设置页重新点一次「一键安装」', 503);
    }

    const ruleFsts = (spec.ruleFsts || [])
      .map((f) => join(state.modelDir, f))
      .filter((f) => existsSync(f));
    const ruleFars = (spec.ruleFars || [])
      .map((f) => join(state.modelDir, f))
      .filter((f) => existsSync(f));

    const engine = (() => {
      try {
        return new mod.OfflineTts({
          model: {
            vits: {
              model: join(state.modelDir, 'model.onnx'),
              tokens: join(state.modelDir, 'tokens.txt'),
              lexicon: join(state.modelDir, 'lexicon.txt'),
            },
            numThreads: threads,
            provider: 'cpu',
          },
          maxNumSentences: 1,
          ...(ruleFsts.length ? { ruleFsts: ruleFsts.join(',') } : {}),
          ...(ruleFars.length ? { ruleFars: ruleFars.join(',') } : {}),
        });
      } catch (e) {
        /**
         * 加载失败要**说清是加载**，不能让它掉进 `publicError` 的兜底里
         * 变成一个 `upstream_error`——那四个字既不像本地模型的问题，
         * 也指不出下一步该干嘛（2026-11-03 用户就是这么被卡住的）。
         *
         * 常见原因：模型文件不完整（安装到一半）、ONNX 与当前架构不匹配、
         * rule.far 损坏。原始 message 原样带上，日志里能直接看到。
         */
        throw new TtsError('sherpa_load_failed', `本地语音引擎加载失败：${e?.message || e}`, 503);
      }
    })();

    engineCache = { key: cacheKey, engine, mod };
    log(`本地语音引擎已加载：${key}，${threads} 线程`);
    return engineCache;
  }

  async function sherpaSpeech(text, cfg) {
    const sherpa = cfg.sherpa && typeof cfg.sherpa === 'object' ? cfg.sherpa : {};
    const { engine, mod } = sherpaEngine(sherpa);
    const key = String(sherpa.model || 'aishell3');
    const spec = SHERPA_MODELS[key] || SHERPA_MODELS.aishell3;

    const sid = Number.isInteger(Number(sherpa.sid)) ? Number(sherpa.sid) : spec.defaultSid;
    const speed = Math.max(0.5, Math.min(2, Number(sherpa.speed) || 1));
    const GenerationConfig = mod.GenerationConfig;

    try {
      const audio = engine.generate({
        text,
        sid,
        speed,
        /**
         * **关掉 external buffer。**
         *
         * sherpa 的 `TtsRequest` 里这个参数默认是 `true`，意思是「音频样本
         * 用原生侧分配的 external typed array 返回」。这在普通脚本里没事，
         * 但在 DSH 那种长驻、加载了一堆原生模块的进程里，Node 会拒绝后续
         * 对这块内存的操作并抛 `External buffers are not allowed`——
         * 表现就是「同样的代码脚本里好好的，装进插件就每句都失败」。
         *
         * 关掉之后走普通 JS 分配的数组，代价是复制一次几十 KB 的内存。
         */
        enableExternalBuffer: false,
        generationConfig: new GenerationConfig({ sid, speed, silenceScale: 0.2 }),
      });
      if (!audio?.samples?.length) throw new TtsError('empty_audio', '本地语音模型没有输出音频', 502);

      /**
       * 再复制一遍到普通 Float32Array。
       *
       * `enableExternalBuffer: false` 理论上已经给了普通数组，但这是原生模块
       * 的内部行为、不是我们能保证的契约——多复制一次几十 KB，换的是
       * 不再依赖那块内存的归属。
       */
      const raw = audio.samples;
      const samples = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) samples[i] = raw[i];

      return { audio: encodeWav(samples, audio.sampleRate), contentType: 'audio/wav' };
    } catch (e) {
      /**
       * 合成阶段炸了就把引擎缓存丢掉。
       *
       * 缓存里那个实例可能已经处于坏状态（C++ 侧崩过一次之后行为不确定），
       * 继续用它只会让后面每一句都失败。下次重新 `new` 一个，代价是 2-3 秒加载。
       */
      engineCache = null;
      if (e instanceof TtsError) throw e;
      /** 带上出错位置：这类原生层的报错光看 message 完全不知道发生在哪 */
      const where = String(e?.stack || '')
        .split('\n')
        .slice(1, 3)
        .map((s) => s.trim().replace(/^at\s+/, ''))
        .join(' ← ');
      throw new TtsError('sherpa_failed', `本地语音合成失败：${e?.message || e}${where ? `（${where}）` : ''}`, 502);
    }
  }

  /**
   * 预热本地引擎。
   *
   * 加载 30MB ONNX 模型要 5 秒左右（实测），而加载完以后合成 6 秒语音只要
   * 130ms。也就是说第一次说话的人要多等 5 秒，后面都快——这个差异大到
   * 会被当成「语音坏了」。
   *
   * 所以启用 sherpa 后由宿主在后台先加载一次，用户第一次听到的就是快的。
   * 失败不抛：预热失败说明没装好，等真正合成时会给出准确的原因。
   */
  async function warmup() {
    const cfg = config();
    if (cfg.enabled !== true) return { ok: false, reason: 'disabled' };
    if (String(cfg.provider || 'openai') !== 'sherpa') return { ok: false, reason: 'not_sherpa' };
    try {
      sherpaEngine(cfg.sherpa && typeof cfg.sherpa === 'object' ? cfg.sherpa : {});
      return { ok: true };
    } catch (e) {
      log(`本地语音预热失败：${e?.code || e?.message || e}`);
      return { ok: false, reason: e?.code || 'error' };
    }
  }

  return { status, synthesize, warmup };
}
