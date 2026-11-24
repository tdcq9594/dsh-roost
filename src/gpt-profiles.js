/**
 * GPT-SoVITS 音色方案
 * ===================
 *
 * 从扩展市场「语音回复」的「音色方案」搬来的能力，但按我方配置结构落地：
 *
 *   · 扩展把 14 个音色字段捆成一套方案；我方多一个 `batch_size`，也一起存，
 *     否则「保存方案 → 应用」之后 v2 推理参数会悄悄回默认值。
 *   · 语速在扩展里属于方案；我方是全局 `tts.speed`（四家 provider 共用），
 *     所以方案里也带一份 `speed`，应用时一起写回，不新造第二套语速配置。
 *   · **不存密钥**：`apiKey` 留在全局配置，方案只装音色参数，
 *     免得 `GET /v1/config` 或方案列表把凭证带给扩展。
 *
 * 纯函数，所有状态都在 cfg 里，路由层只负责 patchConfig。
 */

export const GPT_PROFILE_LIMIT = 50;

const LANG_ALIAS = {
  中文: 'zh', 汉语: 'zh', 普通话: 'zh', 日文: 'ja', 日语: 'ja',
  英文: 'en', 英语: 'en', 自动: 'auto', 粤语: 'yue', 韩语: 'ko',
};
const LANGS = new Set(['zh', 'ja', 'en', 'auto', 'yue', 'ko']);
const SPLITS = new Set(['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5']);

const str = (value, max = 2048) => String(value ?? '').trim().slice(0, max);
const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const int = (value, min, max, fallback) => Math.round(clamp(value, min, max, fallback));
/** 老配置里的中文词统一折算成 API 码，方案列表里不再混两种表示 */
const lang = (value, fallback) => {
  const raw = str(value, 16);
  return LANG_ALIAS[raw] || (LANGS.has(raw) ? raw : fallback);
};
const split = (value) => (SPLITS.has(str(value, 8)) ? str(value, 8) : 'cut5');

/** 方案的默认值。新方案直接用这组分；老配置缺字段时也按这里补。 */
export function defaultProfileValues() {
  return {
    speed: 1,
    baseUrl: '',
    model: '',
    gptWeights: '',
    sovitsWeights: '',
    referWavPath: '',
    promptText: '',
    promptLanguage: 'zh',
    textLanguage: 'zh',
    textSplitMethod: 'cut5',
    fragmentInterval: 0.3,
    topK: 15,
    topP: 1,
    temperature: 1,
    batchSize: 1,
    freeze: false,
  };
}

/** 从当前配置里抽出一份「音色快照」，用于保存方案 / 判断草稿是否脏。 */
export function profileValuesFrom(cfg) {
  const tts = cfg?.tts && typeof cfg.tts === 'object' ? cfg.tts : {};
  const g = tts.gptSovits && typeof tts.gptSovits === 'object' ? tts.gptSovits : {};
  const d = defaultProfileValues();
  return {
    speed: clamp(tts.speed, 0.5, 2, d.speed),
    baseUrl: str(g.baseUrl, 2048),
    model: str(g.model, 200),
    gptWeights: str(g.gptWeights, 2048),
    sovitsWeights: str(g.sovitsWeights, 2048),
    referWavPath: str(g.referWavPath, 2048),
    promptText: str(g.promptText, 2000),
    promptLanguage: lang(g.promptLanguage, d.promptLanguage),
    textLanguage: lang(g.textLanguage, d.textLanguage),
    textSplitMethod: split(g.textSplitMethod),
    fragmentInterval: clamp(g.fragmentInterval, 0.01, 1, d.fragmentInterval),
    topK: int(g.topK, 1, 100, d.topK),
    topP: clamp(g.topP, 0, 1, d.topP),
    temperature: clamp(g.temperature, 0.01, 2, d.temperature),
    batchSize: int(g.batchSize, 1, 8, d.batchSize),
    freeze: g.freeze === true,
  };
}

/** 外部传进来的方案值统一洗一遍：边界和 RANGE_FIELDS / speedOf 对齐。 */
export function normalizeProfileValues(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const d = defaultProfileValues();
  return {
    speed: clamp(src.speed, 0.5, 2, d.speed),
    baseUrl: str(src.baseUrl, 2048),
    model: str(src.model, 200),
    gptWeights: str(src.gptWeights, 2048),
    sovitsWeights: str(src.sovitsWeights, 2048),
    referWavPath: str(src.referWavPath, 2048),
    promptText: str(src.promptText, 2000),
    promptLanguage: lang(src.promptLanguage, d.promptLanguage),
    textLanguage: lang(src.textLanguage, d.textLanguage),
    textSplitMethod: split(src.textSplitMethod),
    fragmentInterval: clamp(src.fragmentInterval, 0.01, 1, d.fragmentInterval),
    topK: int(src.topK, 1, 100, d.topK),
    topP: clamp(src.topP, 0, 1, d.topP),
    temperature: clamp(src.temperature, 0.01, 2, d.temperature),
    batchSize: int(src.batchSize, 1, 8, d.batchSize),
    freeze: src.freeze === true,
  };
}

/** 方案列表只信「数组 + 对象 + id/name」，最多 50 套，多余的静默丢掉。 */
export function normalizeProfiles(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    if (out.length >= GPT_PROFILE_LIMIT) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = str(item.id, 64);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: str(item.name, 40) || '未命名方案',
      values: normalizeProfileValues(item.values),
    });
  }
  return out;
}

/** 应用方案 = 一次 patch 同时写语速 + 全套 GPT 字段，不留半套旧值。 */
export function profilePatch(values) {
  const v = normalizeProfileValues(values);
  return {
    tts: {
      speed: v.speed,
      gptSovits: {
        baseUrl: v.baseUrl,
        model: v.model,
        gptWeights: v.gptWeights,
        sovitsWeights: v.sovitsWeights,
        referWavPath: v.referWavPath,
        promptText: v.promptText,
        promptLanguage: v.promptLanguage,
        textLanguage: v.textLanguage,
        textSplitMethod: v.textSplitMethod,
        fragmentInterval: v.fragmentInterval,
        topK: v.topK,
        topP: v.topP,
        temperature: v.temperature,
        batchSize: v.batchSize,
        freeze: v.freeze,
      },
    },
  };
}

function newId(now) {
  return `voice-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 增改 / 应用 / 删除。保存只动方案列表，**不应用**；应用才写当前配置——
 * 这和扩展面板「保存方案 → 应用方案」两步走是同一个语义，
 * 免得改个名字就把正在用的音色换掉。
 */
export function applyProfileOp(cfg, body = {}, deps = {}) {
  const g = cfg?.tts?.gptSovits || {};
  const items = normalizeProfiles(g.profiles);
  const op = String(body?.op || 'save');
  const id = str(body?.id, 64);
  const now = typeof deps.now === 'function' ? deps.now : Date.now;

  if (op === 'new') {
    return { ok: true, message: '已新建空白方案', values: defaultProfileValues(), patch: null };
  }

  if (op === 'save') {
    const name = str(body?.name, 40);
    if (!name) return { ok: false, status: 400, message: '给方案起个名字' };
    const values = normalizeProfileValues(body?.values);
    if (!values.referWavPath || !values.promptText) {
      return { ok: false, status: 400, message: '方案缺少必填项：参考音频路径和参考文本' };
    }
    const targetId = id || newId(now);
    const next = items.some((p) => p.id === targetId)
      ? items.map((p) => (p.id === targetId ? { ...p, name, values } : p))
      : [...items, { id: targetId, name, values }];
    if (next.length > GPT_PROFILE_LIMIT) {
      return { ok: false, status: 409, message: `最多保存 ${GPT_PROFILE_LIMIT} 套方案` };
    }
    return {
      ok: true, id: targetId, name, message: id === targetId ? '方案已更新，点「应用方案」才会启用' : '方案已保存，点「应用方案」才会启用',
      patch: { tts: { gptSovits: { profiles: next } } },
    };
  }

  if (op === 'apply') {
    const found = items.find((p) => p.id === id);
    if (!found) return { ok: false, status: 404, message: '找不到这套方案，先保存它' };
    const patch = profilePatch(found.values);
    patch.tts.gptSovits.activeProfileId = found.id;
    patch.tts.gptSovits.profiles = items;
    return { ok: true, message: `已应用「${found.name}」`, patch };
  }

  if (op === 'remove') {
    const found = items.find((p) => p.id === id);
    if (!found) return { ok: false, status: 404, message: '找不到这套方案' };
    const next = items.filter((p) => p.id !== id);
    return {
      ok: true, message: `已删除「${found.name}」，当前音色保留`,
      patch: { tts: { gptSovits: { profiles: next, activeProfileId: g.activeProfileId === id ? '' : (g.activeProfileId || '') } } },
    };
  }

  return { ok: false, status: 400, message: `不认识的操作：${op}` };
}
