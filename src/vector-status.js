/**
 * 3.4 向量/重排状态投影（只读）。
 *
 * 对齐 aurabot `/memory/vector/status` + `/memory/rerank/status`：告诉用户
 * "向量到底生效没、走哪条路"。我方痛点是开关开了但模型没装好会**静默回落
 * 关键词**（config.js 注释明写），面板上看不出来——这个 status 就是补这个。
 *
 * 纯函数：host 传入已取好的状态源，本模块不碰存储、不调模型、不写盘。
 */

/**
 * @param {object} s 状态源（host 现取）
 *   @param {boolean} s.embedEnabled   embedder.enabled() 总闸（本地或远程其一生效）
 *   @param {string}  s.embedModelId   embedder.modelId() 生效模型指纹
 *   @param {boolean} s.localEmbedWanted cfg.memory.embeddingLocal === true（开关）
 *   @param {boolean} s.localEmbedReady localEmbedder.ready()（模型装好没）
 *   @param {boolean} s.remoteConfigured 远程 {model,baseUrl,apiKey} 配齐没
 *   @param {boolean} s.rerankEnabled  cfg.recall.rerank.enabled||useLocal
 *   @param {boolean} s.localRerankReady localReranker.ready()
 */
export function vectorStatus(s = {}) {
  const embed = s.embedEnabled === true;
  const localWanted = s.localEmbedWanted === true;
  const localReady = s.localEmbedReady === true;
  const remote = s.remoteConfigured === true;
  const vectorMode = !embed ? 'off' : localReady && localWanted ? 'local' : 'remote';
  /** 开关开了却没生效，要说清卡在哪，别让用户对着一个勾反复怀疑 */
  const warnings = [];
  if (localWanted && !localReady && !remote) {
    warnings.push('本地向量开关开着，但模型没装好；现在回落纯关键词。去「功能包 → 本地智能」装 e5-small。');
  }
  if (s.rerankEnabled === true && s.localRerankReady !== true) {
    warnings.push('重排想要本地模型，但 hs-rerank-1 没装好；现在回落规则重排。');
  }
  const rerankMode = s.rerankEnabled !== true ? 'off' : (s.localRerankReady === true ? 'local' : 'rule');
  return {
    vector: {
      enabled: embed,
      mode: vectorMode,
      model: String(s.embedModelId || ''),
      localWanted,
      localReady,
      remoteConfigured: remote,
      /** G2：对齐对方 vectorStatus 的索引进度四字段（缺省 0，老调用方不受影响） */
      dims: Math.max(0, Number(s.dims) || 0),
      indexed: Math.max(0, Number(s.indexed) || 0),
      total: Math.max(0, Number(s.total) || 0),
      lastError: String(s.lastError || ''),
    },
    rerank: {
      enabled: s.rerankEnabled === true,
      mode: rerankMode,
    },
    warnings,
    /** 给用户一句话的口径，和面板开关状态对得上 */
    summary: !embed
      ? '向量未启用：现在走纯关键词检索（默认行为）'
      : `向量生效（${vectorMode === 'local' ? '本地' : '远程'}）：${s.embedModelId || '未标模型'}`,
  };
}
