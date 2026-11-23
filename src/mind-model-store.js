/**
 * 心智模型快照存储（阶段 4，B2）
 * ================================
 *
 * 照 `self.json` 的范式：`dataDir()/mind-model.json`，原子写，
 * **不进 journal**（否则快照会被巩固当成聊天素材再喂回去，形成自我强化回音），
 * 独立清空入口（不挂在 memory.clear / purge 上）。
 *
 * 形态照 Hindsight `mental_model_history` 表：一份 current + 有限条 history，
 * 每次 refresh 把旧 current 压进 history（超上限丢最旧），
 * 并记 `watermark`（这次看到的最新事实时间）——下一轮 delta refresh 只取
 * 比它新的事实，等价于 Hindsight 的 `last_memory_seen_at`。
 *
 * 默认值全部不落盘：从没 refresh 过时文件根本不存在，升级前后逐字节一致。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';
import { writeJsonAtomic } from './atomic.js';

/** 历史最多留几份（Hindsight 也有 mental_model_history_max_entries 同款上限） */
export const MAX_HISTORY = 12;
/** 单份 markdown 上限，防模型一次吐爆数据文件 */
export const MAX_MD = 8000;

const slug = (s) => String(s ?? '').replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 40) || 'default';

export function createMindModelStore({ log = () => {}, now = () => Date.now() } = {}) {
  const file = () => join(dataDir(), 'mind-model.json');
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8'));
      const models = {};
      if (raw?.models && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
        for (const [id, m] of Object.entries(raw.models)) {
          if (!m || typeof m !== 'object') continue;
          models[slug(id)] = {
            markdown: String(m.markdown ?? '').slice(0, MAX_MD),
            at: Number(m.at) > 0 ? Number(m.at) : 0,
            watermark: Number(m.watermark) > 0 ? Number(m.watermark) : 0,
            mode: String(m.mode ?? 'full'),
            reason: String(m.reason ?? '').slice(0, 200),
            history: Array.isArray(m.history)
              ? m.history.slice(-MAX_HISTORY).map((h) => ({
                  markdown: String(h?.markdown ?? '').slice(0, MAX_MD),
                  at: Number(h?.at) > 0 ? Number(h?.at) : 0,
                  mode: String(h?.mode ?? 'full'),
                  reason: String(h?.reason ?? ''),
                }))
              : [],
          };
        }
      }
      cache = { models };
    } catch {
      cache = { models: {} };
    }
    return cache;
  }

  function save() {
    try {
      writeJsonAtomic(file(), load());
      return true;
    } catch (e) {
      log(`心智模型快照写不进去：${e?.message ?? e}`);
      return false;
    }
  }

  /** 只读快照（副本，调用方改不到缓存） */
  function get(id = 'default') {
    const m = load().models[slug(id)];
    return m ? { ...m, history: m.history.map((h) => ({ ...h })) } : null;
  }

  function ids() {
    return Object.keys(load().models);
  }

  /**
   * 落一份新快照。旧 current 压进 history（有内容才压，避免空快照堆历史）。
   * @returns {{ok:boolean, archived:boolean}}
   */
  function put(id, { markdown = '', watermark = 0, mode = 'full', reason = '' } = {}) {
    const key = slug(id);
    const md = String(markdown ?? '').slice(0, MAX_MD);
    if (!md) return { ok: false, archived: false };
    const m = load();
    const prev = m.models[key];
    const at = now();
    const archived = Boolean(prev?.markdown && prev.markdown !== md);
    m.models[key] = {
      markdown: md,
      at,
      watermark: Number(watermark) > 0 ? Number(watermark) : at,
      mode: String(mode ?? 'full'),
      /** 存下来：下一轮归档进 history 时才能带上"这一版是怎么来的" */
      reason: String(reason ?? '').slice(0, 200),
      history: archived
        ? [...(prev.history || []), {
            markdown: prev.markdown, at: Number(prev.at) || at,
            mode: String(prev.mode ?? 'full'), reason: String(prev.reason ?? ''),
          }].slice(-MAX_HISTORY)
        : (prev?.history || []),
    };
    return { ok: save(), archived };
  }

  /** 独立清空：只清本模块文件，绝不碰 self.json / memory.json */
  function clear(id = '') {
    const m = load();
    if (id) {
      if (!m.models[slug(id)]) return 0;
      delete m.models[slug(id)];
    } else {
      m.models = {};
    }
    save();
    return 1;
  }

  return { get, ids, put, clear, file: () => file() };
}
