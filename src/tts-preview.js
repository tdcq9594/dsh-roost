/**
 * 5.3 语音试听
 * ============
 *
 * 抽成纯函数（依赖由调用方注入），是为了把三条验收都能直接测：
 *   ① 与 QQ 语音条同一条合成链路 —— 走的是 `tts.synthesize`，不是另写一套；
 *   ② 不落盘 —— 音频只以 Buffer 在内存里过一遍，最后转成 base64 回浏览器；
 *   ③ 不占 quota —— 这里不碰配额、账本、投递，也没有 quick op 的计费入口。
 *
 * 另外两件容易做错的事也在这里收口：
 *   · 「改了没保存也能试」：草稿由面板整份传进来，只覆盖这一次合成；
 *   · 「还没启用也想先听听」：强制 `enabled: true`，但**不写配置**，
 *     否则没开语音的人永远点不动试听按钮。
 */
import { Buffer } from 'node:buffer';

/** 试听文本的硬上限：防止有人把整篇文章贴进来打上游 */
export const PREVIEW_TEXT_LIMIT = 500;

function previewError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/**
 * @param {object} o
 * @param {string} o.text 待合成文本
 * @param {object|null} o.draft 面板当前草稿（整份 tts 段）；null = 用已保存配置
 * @param {(text:string, opts:object)=>Promise<{audio:Buffer|Uint8Array, contentType:string}>} o.synth
 * @param {(p:{dataBase64:string})=>Promise<object>} [o.convert] 框架侧 SILK 校验
 */
export async function runPreview({ text = '', draft = null, synth, convert = null } = {}) {
  const input = String(text ?? '').trim();
  if (!input) throw previewError(400, 'empty_text', '写一句要试听的话');
  if (input.length > PREVIEW_TEXT_LIMIT) {
    throw previewError(413, 'text_too_long', `试听最多 ${PREVIEW_TEXT_LIMIT} 字`);
  }
  if (typeof synth !== 'function') throw previewError(503, 'tts_unavailable', '语音服务未就绪');

  const base = draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
  /** 只作用于本次合成，绝不回写 cfg；草稿的 enabled=false 不该让试听变成灰按钮 */
  const previewCfg = { ...base, enabled: true };

  let result;
  try {
    result = await synth(input, { draft: previewCfg });
  } catch (e) {
    /** 保留 TtsError 的 status/code，面板才能说清是「没配好」还是「上游挂了」 */
    const status = Number(e?.status) || 502;
    const code = String(e?.code || 'tts_failed').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'tts_failed';
    throw previewError(status, code, String(e?.message || '语音合成失败'));
  }
  const audio = Buffer.from(result?.audio ?? []);
  const contentType = String(result?.contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!audio.length || !contentType.startsWith('audio/')) {
    throw previewError(502, 'invalid_audio_response', '语音服务返回内容无效');
  }

  /**
   * 同一份 SILK 转换的校验：把这份字节交给框架 `media.convert`，它和
   * `media.send` 共用 `encodeChecked`，但到编码为止，不上传也不发送。
   *
   * 旧框架没这个方法、格式需要 ffmpeg 重采样、或没装 silk-wasm 时，
   * 一律降级成「未校验」而不是让试听失败——听得见比验得过重要。
   */
  let silk = { ok: false, reason: 'unchecked', message: '框架没接入 SILK 校验' };
  if (typeof convert === 'function') {
    try {
      const r = await convert({ dataBase64: audio.toString('base64') });
      if (r && typeof r === 'object') {
        silk = {
          ok: r.ok === true,
          reason: String(r.reason || (r.ok === true ? 'ok' : 'failed')),
          ...(r.message ? { message: String(r.message) } : {}),
          ...(Number(r.size) > 0 ? { size: Number(r.size) } : {}),
          ...(r.via ? { via: String(r.via) } : {}),
          ...(Number(r.ms) > 0 ? { ms: Number(r.ms) } : {}),
        };
      } else {
        silk = { ok: false, reason: 'bad_response', message: '框架返回的校验结果不对' };
      }
    } catch (e) {
      silk = { ok: false, reason: 'unsupported', message: String(e?.message || e) };
    }
  }

  return {
    ok: true,
    audio: audio.toString('base64'),
    contentType,
    bytes: audio.length,
    usedDraft: Boolean(draft),
    provider: String(base.provider || ''),
    silk,
  };
}
