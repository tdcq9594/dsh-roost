/**
 * DSH 模型清单 + 能力探测 + 测速
 * ==============================
 *
 * 面板的「模型」页不再让人手打 `provider` / `model` 两个字符串——DSH 里到底
 * 装了什么模型只有宿主自己知道，手打的十有八九拼错，然后第一轮就报
 * 「找不到模型」，而报错点离面板很远。
 *
 * 官方接口（和 `model-pick.js` 同一套，已核 `deepseek-ai/deepseek-harness`）：
 *   · `ctx.llm.listProviders()`            → provider 清单（字符串或对象）
 *   · `await ctx.llm.listModels(provider)` → 该 provider 下的模型（`id` / `model` / `name`）
 *   · `await ctx.llm.resolveModelInfo(p, m)` → `{ reasoning:{efforts,defaultEffort?}, inputModalities? }`
 *   · `ctx.llm.stream({provider, model, messages, …})` → 异步块流（测速用）
 *
 * 两条边界，写在这里免得以后改坏：
 *
 *   1. **探测失败 = 未知，不是「不支持」。** `resolveModelInfo` 抛错、或者宿主
 *      根本没暴露它，都返回 `null`；面板据此显示「未知」并且**不禁用**任何档位。
 *      把未知当「不支持」会让用户在一个其实能用的模型上选不了思考强度。
 *   2. **清单一律带缓存（10 分钟）。** 每次 `resolveModelInfo` 都是一次能力查询，
 *      在 provider 多、模型多的机器上串起来要好几秒；面板每次进页都拉一遍会卡。
 *      面板上的「刷新」传 `refresh: true` 强制重来（换模型/改配置后点一下）。
 */

import { randomUUID } from 'node:crypto';

/** 清单与能力的缓存时长。太长会让「新装的模型不出现」，太短就白缓存了 */
const TTL_MS = 10 * 60_000;

/** `listProviders()` 既可能给字符串也可能给 `{id|provider|name}`，统一成 id */
function providerId(p) {
  if (typeof p === 'string') return p.trim();
  if (!p || typeof p !== 'object') return '';
  return String(p.id ?? p.provider ?? p.name ?? '').trim();
}

/** 同理，模型既可能给 `id` 也可能给 `model` */
function modelId(m) {
  if (typeof m === 'string') return m.trim();
  if (!m || typeof m !== 'object') return '';
  return String(m.id ?? m.model ?? '').trim();
}

function modelLabel(m, model) {
  const name = m && typeof m === 'object' ? String(m.name ?? m.label ?? '').trim() : '';
  return name || model;
}

/**
 * @param {object} o
 * @param {() => any} [o.getLlm] 现取 `ctx.get('llm')`：宿主可能比插件晚就绪，不能提前抓死
 * @param {(m:string)=>void} [o.log]
 * @param {() => number} [o.now]
 */
export function createModelCatalog({ getLlm = () => null, log = () => {}, now = Date.now } = {}) {
  /** `{ list, at }`；`list` 是给面板的形状，不是宿主原始对象 */
  let snapshot = null;
  /** `provider::model` → { at, value } */
  const caps = new Map();

  /**
   * 一个模型的能力。`reasoning: null` = 没有推理元数据（本地 Ollama 之类），
   * 面板要把「思考强度」置灰；`vision: null` = 宿主没声明（≠ 看不了）。
   */
  async function capabilitiesOf(llm, provider, model) {
    const key = `${provider}::${model}`;
    const hit = caps.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.value;

    let value = { reasoning: null, vision: null };
    try {
      if (llm && typeof llm.resolveModelInfo === 'function') {
        const info = await llm.resolveModelInfo(provider, model);
        const efforts = (info?.reasoning?.efforts ?? [])
          .map((e) => String((e && typeof e === 'object' ? e.id : e) ?? '').trim())
          .filter(Boolean);
        const dflt = String(info?.reasoning?.defaultEffort ?? '').trim();
        value = {
          /** 空档位 = adapter 没公布，按「没有思考强度」展示（不下传也不报错） */
          reasoning: efforts.length
            ? { efforts: [...new Set(efforts)], ...(dflt ? { default: dflt } : {}) }
            : null,
          /** 缺省 = 未知。只有明确是数组时才回答「支持 / 不支持」 */
          vision: Array.isArray(info?.inputModalities) ? info.inputModalities.includes('image') : null,
        };
      }
    } catch (e) {
      /** 查不到就当未知：面板不禁用档位，实际传参时 `pickReasoningEffort` 还会再校验一次 */
      log(`查模型能力失败（按未知处理）${provider}/${model}：${e?.message ?? e}`);
    }
    caps.set(key, { at: now(), value });
    return value;
  }

  /**
   * 列 DSH 里能用的模型。
   *
   * 单个 provider 查失败只跳过它，不影响别的（一个 provider 没登录不该让整页空白）。
   * 一个都列不出来时**抛错**，让面板显示原因，而不是拿一张空表假装「没有模型」。
   */
  async function list({ refresh = false } = {}) {
    if (refresh) {
      snapshot = null;
      caps.clear();
    }
    if (snapshot && now() - snapshot.at < TTL_MS) return { ...snapshot, cached: true };

    const llm = getLlm();
    if (!llm || typeof llm.listProviders !== 'function') {
      throw new Error('宿主没有暴露模型清单（ctx.llm 不可用），只能手填 provider / model');
    }

    const out = [];
    let failed = 0;
    const providers = llm.listProviders() || [];
    for (const p of providers) {
      const provider = providerId(p);
      if (!provider) continue;
      let models = [];
      try {
        models = (await llm.listModels(provider)) || [];
      } catch (e) {
        failed += 1;
        log(`列 ${provider} 的模型失败：${e?.message ?? e}`);
        continue;
      }
      for (const m of models) {
        const model = modelId(m);
        if (!model) continue;
        const capsOfModel = await capabilitiesOf(llm, provider, model);
        out.push({ provider, model, name: modelLabel(m, model), ...capsOfModel });
      }
    }

    if (!out.length) {
      throw new Error(failed
        ? `问了 ${failed} 个 provider 都没列出来（可能要重新登录），只能手填`
        : 'DSH 没有列出任何模型（还没登录 / 没配 provider）');
    }
    snapshot = { list: out, at: now() };
    return { ...snapshot, cached: false };
  }

  return {
    list,
    /** 给「视觉能力=自动」用：这个模型能不能看图。null = 不知道 */
    async canSee(provider, model) {
      const p = String(provider || '').trim();
      const m = String(model || '').trim();
      if (!p || !m) return null;
      const cap = await capabilitiesOf(getLlm(), p, m);
      return cap.vision;
    },
    invalidate() {
      snapshot = null;
      caps.clear();
    },
  };
}

/**
 * 测速：真问一次模型，看它回一句话要多久。
 *
 * 和面板上写的「会花一点点额度」对得上——这里就是一次正常请求，没有作弊。
 * 不带思考强度：测的是「聊天这条路的延迟」，而 QQ 聊天的模型档位由
 * `pickReasoningEffort` 单独管；在这里再套一层只会测出别的模型的耗时。
 *
 * @param {() => any} getLlm
 * @param {{provider?:string, model?:string}} sel
 * @returns {Promise<{ms:number, text:string}>}
 */
export async function pingModel(getLlm, { provider, model } = {}) {
  const llm = getLlm();
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有暴露 llm.stream，测不了速');
  const p = String(provider || '').trim();
  const m = String(model || '').trim();
  if (!p || !m) throw new Error('要 provider 和 model');

  const started = Date.now();
  let out = '';
  const stream = llm.stream({
    provider: p,
    model: m,
    system: '只回复两个字：在呢',
    messages: [{
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: '在吗' }],
      source: { kind: 'plugin', plugin: 'dsh-roost' },
    }],
    maxTokens: 200,
    temperature: 0,
  });

  for await (const chunk of stream) {
    if (!chunk) continue;
    if (chunk.type === 'text-delta') out += String(chunk.text ?? '');
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const f = chunk.reason.failure || {};
      const error = new Error(`模型报错：${f.message || f.code || '未知'}`);
      if (f.code) error.code = f.code;
      throw error;
    }
  }
  return { ms: Date.now() - started, text: out.trim().slice(0, 40) };
}
