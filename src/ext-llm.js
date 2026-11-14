import { randomUUID } from 'node:crypto';

import { pickModelFor } from './model-pick.js';

/**
 * 让模型看一眼**外部图片**（扩展抽的视频帧），换一段文字回来。
 *
 * 为什么放在宿主：DSH 的图片要先经附件服务登记（`attachments.admitPromptContent`），
 * 模型适配层只认登记过的附件块。扩展进程里既没有 `llm` 也没有 `attachments`，
 * 自己拼 requests 一定失败——所以这件事只能由宿主代做。
 *
 * 边界（刻意窄）：
 *   · 只收 base64 图片 + 一段提示词，回一段文本；
 *   · 不挂工具、不开会话、不写任何文件；
 *   · 上限 4 张、单张 base64 ≤ 400 KB（宿主 body 上限 1 MB）；
 *   · 当前模型不支持图片就**明确拒绝**，不烧一次注定被忽略的请求。
 *
 * @param {{
 *   getCtx?: () => any,
 *   cfgOf?: () => object,
 *   modelCatalog?: {canSee?: Function} | null,
 *   log?: Function,
 * }} [o]
 */
export function createLlmVision({
  getCtx = () => null, cfgOf = () => ({}), modelCatalog = null, log = () => {},
} = {}) {
  const MAX_IMAGES = 4;
  const MAX_B64 = 400_000;

  return async function vision(body = {}) {
    const prompt = String(body?.prompt ?? '').slice(0, 2000).trim();
    const raw = Array.isArray(body?.images) ? body.images : [];
    const images = raw
      .slice(0, MAX_IMAGES)
      .map((x) => ({ data: String(x?.data ?? ''), mediaType: String(x?.mediaType || 'image/jpeg') }))
      .filter((x) => x.data.length > 100 && x.data.length <= MAX_B64);
    if (!images.length) {
      return { ok: false, message: `没有可用的图片（要么是空的，要么单张超过 ${Math.round(MAX_B64 / 1000)} KB）` };
    }

    const ctx = getCtx?.();
    const llm = ctx?.get?.('llm');
    if (!llm || typeof llm.stream !== 'function') {
      return { ok: false, message: '宿主没有暴露 llm（DSH 版本太旧或模型服务没就绪）' };
    }
    const att = ctx?.get?.('attachments');
    if (!att || typeof att.admitPromptContent !== 'function') {
      return { ok: false, message: '宿主没有附件服务，看不了图' };
    }

    const cfg = cfgOf() ?? {};
    const sel = pickModelFor({
      byChat: cfg?.model?.byChat,
      byKind: cfg?.model?.byKind,
      defaultSel: cfg?.model?.default,
      chatId: '',
      kind: '',
      globalSel: (() => {
        try { return ctx?.get?.('agentDefaultModel')?.currentSelection?.() || null; } catch { return null; }
      })(),
    });
    if (!sel) return { ok: false, message: '还没有可用的模型（去「模型」页选一个）' };

    /** 模型看不了图就直说：让它回一句「我看不到图片」毫无价值 */
    if (modelCatalog && typeof modelCatalog.canSee === 'function') {
      try {
        const can = await modelCatalog.canSee(sel.provider, sel.model);
        if (can === false) {
          return { ok: false, message: `当前模型（${sel.model}）不支持图片输入，换一个能看图的模型` };
        }
      } catch { /* 能力查不到就不拦，交给上游报错 */ }
    }

    let content = [{ type: 'text', text: prompt || '这些是视频截图，只写画面上能看到的东西。' }];
    for (const img of images) {
      content.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: 'video-frame' });
    }
    try {
      content = await att.admitPromptContent(content);
    } catch (e) {
      return { ok: false, message: `图片登记失败：${e?.message ?? e}` };
    }

    const started = Date.now();
    let text = '';
    try {
      const stream = llm.stream({
        provider: sel.provider,
        model: sel.model,
        system: '你只描述画面上确实能看到的东西，不猜剧情、不编造、不发感想。',
        messages: [{
          role: 'user',
          id: randomUUID(),
          content,
          source: { kind: 'plugin', plugin: 'dsh-roost' },
        }],
        maxTokens: Math.max(200, Math.min(1200, Number(body?.maxTokens) || 600)),
        temperature: 0.3,
        /**
         * 后台调用没有会话，得自带一个：opencode 那条路由要求请求头，不带就 400。
         * `extId` **只能由宿主从令牌注入**（见 host.js 的 llm.vision hook），
         * 不许扩展自报——否则能冒用别的扩展的会话 id 造成串扰。
         */
        sessionId: `ext-vision-${String(body?.extId || 'unknown').slice(0, 32)}`,
      });
      for await (const chunk of stream) {
        if (!chunk) continue;
        if (chunk.type === 'text-delta') text += String(chunk.text ?? '');
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          const f = chunk.reason.failure || {};
          return { ok: false, message: `模型报错：${f.message || f.code || '未知'}` };
        }
      }
    } catch (e) {
      return { ok: false, message: `看画面失败：${e?.message ?? e}` };
    }

    const out = text.trim();
    log(`扩展 ${String(body?.extId ?? '?')} 看图：${images.length} 张，${out.length} 字，${Date.now() - started}ms`);
    if (!out) return { ok: false, message: '模型看了但一个字都没写（可能输出预算被思考吃掉）' };
    return { ok: true, text: out, model: sel.model, ms: Date.now() - started };
  };
}
