/**
 * 向量：**可选增强**，配了才用，没配就安静地什么都不做。
 *
 * 为什么是"可选"而不是"默认开"：
 *   向量要额外一个 OpenAI 兼容的 `/embeddings` 端点，而 dsh-roost 这边
 *   拿不到 DSH 的模型凭证（那是 DSH 自己的），用户必须单独填。
 *   所以默认关着，`memory.embedding` 没填就 `enabled() === false`，
 *   日记检索回落纯关键词——**不报错、不退化、不提示**。
 *
 * 实现参考 `qq-bot-roost-plugins/plugins/ai-native/provider.js` 的
 * `embeddingConf()` / `embedVectors()`（同一套坑：分批、乱序、空向量），
 * 按"一份实现"的原则在这里重写一份小的，不跨仓 import。
 */

/** 去掉尾斜杠，用户填 `http://x/v1/` 也能对 */
const trimSlash = (s) => String(s ?? '').trim().replace(/\/+$/, '');

/**
 * @param {object} o
 * @param {() => object|null} o.cfgOf  返回 `{ model, baseUrl, apiKey, batch, minScore }`；空=不启用
 * @param {(m:string)=>void} [o.log]
 */
export function createEmbedder({ cfgOf, log = () => {}, localOf = null } = {}) {
  /** 本地 embedder 每轮现取（配置开关变了下一轮就生效），没注入就是 null */
  const localNow = () => (typeof localOf === 'function' ? localOf() : null);
  /** 配置读完缓存住：每轮都解析一遍没意义，改配置会重建实例 */
  let conf = undefined;

  function read() {
    if (conf !== undefined) return conf;
    let e = null;
    try {
      e = cfgOf?.() ?? null;
    } catch {
      e = null;
    }
    if (typeof e === 'string') {
      try {
        e = JSON.parse(e);
      } catch {
        e = null;
      }
    }
    if (!e || typeof e !== 'object') {
      conf = null;
      return conf;
    }
    const model = String(e.model || '').trim();
    const baseUrl = trimSlash(e.baseUrl);
    if (!model || !baseUrl) {
      conf = null;
      return conf;
    }
    conf = {
      model,
      baseUrl,
      apiKey: String(e.apiKey || '').trim(),
      /**
       * 有的服务商单次上限很小（10 条），默认 16 并允许调。
       * 一次要太多会被 400 拒掉，整批白费。
       */
      batch: Math.min(64, Math.max(1, Number(e.batch) || 16)),
      // 余弦门槛。太低会把"意思相近但内容无关"的也拉进来
      minScore: Number(e.minScore) > 0 ? Number(e.minScore) : 0.4,
    };
    return conf;
  }

  async function call(texts, signal) {
    const c = read();
    if (!c) return null;
    const inputs = (texts || []).map((t) => String(t ?? '').slice(0, 4000));
    if (!inputs.length) return [];

    const out = [];
    for (let i = 0; i < inputs.length; i += c.batch) {
      const slice = inputs.slice(i, i + c.batch);
      const res = await fetch(`${c.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: c.model, input: slice }),
        signal: signal ?? AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`向量接口 ${res.status}：${body.slice(0, 200)}`);
      }
      const data = await res.json().catch(() => null);
      const arr = Array.isArray(data?.data) ? data.data.slice() : [];
      if (arr.length !== slice.length) {
        throw new Error(`向量接口返回条数不对（要 ${slice.length}，给了 ${arr.length}）`);
      }
      // 有的服务商不保证顺序，按 index 排回来
      arr.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const d of arr) {
        const v = d?.embedding;
        if (!Array.isArray(v) || !v.length) throw new Error('向量接口返回了空向量');
        out.push(Float32Array.from(v));
      }
    }
    return out;
  }

  /**
   * 本地模型优先：配置了 `memory.embeddingLocal` 且模型装好了，就用本地
   * （不需外部 API / 凭证）；否则走原来的 OpenAI 兼容 `/embeddings`。
   * 本地没装好时 `enabled()` 为 false，检索自动回落纯关键词——和以前一样安静。
   */
  return {
    enabled: () => (localNow()?.enabled?.() ? true : Boolean(read())),

    minScore: () => (localNow()?.enabled?.() ? localNow().minScore() : (read()?.minScore ?? 0.4)),

    async many(texts, opts = {}) {
      const local = localNow();
      if (local?.enabled?.()) {
        const r = await local.many(texts, opts);
        if (r) return r;
        /** 本地算不出来 ≠ 回退 HTTP：HTTP 多半也没配，回落关键词即可 */
        return null;
      }
      if (!read()) return null;
      return call(texts, opts.signal);
    },

    async one(text, opts = {}) {
      const local = localNow();
      if (local?.enabled?.()) {
        try {
          const r = await local.one(text, opts);
          return r ?? null;
        } catch (e) {
          log(`本地向量算不出来：${e.message}`);
          return null;
        }
      }
      if (!read()) return null;
      try {
        const r = await call([text], opts.signal);
        return r?.[0] ?? null;
      } catch (e) {
        log(`向量算不出来：${e.message}`);
        return null;
      }
    },
  };
}
