/**
 * 「让 AI 看一眼」：给图库里的图补描述。
 *
 * 为什么单独一个文件：这一步是**网络 IO + 花钱**，和其余纯本地逻辑混在一起
 * 会让 `gallery.js` 变成一个既做索引又调模型的杂物间。分开之后：
 *   · `gallery.js` 只管「库里有什么、序号是多少」；
 *   · 这里只管「一张图问一次模型，把回答填进标注」。
 *
 * ## 三条成本纪律
 *
 * 1. **只处理增量的**。几百张图全跑一遍就是几百次视觉调用，第二次点「整理」
 *    应该秒完成。所以 `pending()` 只挑 `meaning` 和 `name` 都为空的。
 * 2. **并发 2，不是 20**。抄表情标注扩展的 `MAX_INFLIGHT`：并发太高会把
 *    模型额度打满，用户这一轮聊天直接排队。
 * 3. **一次失败不中止**。某张图太大、模型抽风、文件被占用，都只算这一张失败，
 *    接着跑后面的。整批放弃的话用户得一个个重点。
 *
 * ## 进度为什么在内存
 *
 * 和补标签任务同理（`sticker-manage.js` 文件头第 4 条）：落盘只会留下
 * 「上次那个到底跑完没有」的悬案。重启后重点一次就行。
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

/** 并发上限。vision 是网络 IO，2 个已经能吃满一条带宽 */
export const MAX_INFLIGHT = 2;

/** 单张 base64 上限，和 `ext-llm.js` 的 `MAX_B64` 对齐（那边超了会直接过滤掉） */
const MAX_B64 = 400_000;

/** 问模型的话。写死在这里，不要在调用处拼——prompt 一改就得重测解析 */
export const DESCRIBE_PROMPT = [
  '这是一张表情包或图片。只写画面上确实能看到的东西，不要猜剧情、不要编背景。',
  '严格回一行 JSON，不要代码块、不要解释：',
  '{"name":"10字以内的短名","meaning":"画了什么、什么感觉，一句话",'
    + '"scenes":"什么场合适合发它","avoid":"什么场合别发它","tags":["最多4个关键词"]}',
  '看不出来就留空字符串，不要硬编。',
].join('\n');

/** 扩展名 → mediaType。猜不出来按 jpeg，官方对这个字段最宽容 */
export function mediaTypeOf(file) {
  const ext = extname(String(file ?? '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/jpeg';
}

/**
 * 把模型的回答解析成标注字段。
 *
 * **尽量宽容**：模型经常会包一层 ```json、或者在前后加一句「好的」。
 * 这里先剥代码块，再从第一个 `{` 找到最后一个 `}` ——比「严格 JSON.parse」
 * 少掉一大半假失败，而假失败会白花一次调用。
 *
 * @returns {{name:string, meaning:string, scenes:string, avoid:string, tags:string[]}|null}
 */
export function parseDescribe(text) {
  let s = String(text ?? '').trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let obj;
  try {
    obj = JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const str = (v, max) => [...String(v ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
  const tags = (Array.isArray(obj.tags) ? obj.tags : String(obj.tags ?? '').split(/[,，、\s]+/))
    .map((t) => str(t, 8)).filter(Boolean).slice(0, 4);

  const out = {
    name: str(obj.name, 20),
    meaning: str(obj.meaning, 80),
    scenes: str(obj.scenes, 60),
    avoid: str(obj.avoid, 40),
    tags,
  };
  /** 全空等于没回答，别把它当成「看过但没有信息」写进库 */
  if (!out.name && !out.meaning && !out.tags.length) return null;
  return out;
}

/**
 * 顺序 + 少量并发的任务器。
 *
 * 为什么不用 `createTagJob`：那个的 worker 是同步的（补标签就是写一个文件），
 * 一次 tick 跑 20 张；这里是 `await` 网络请求，必须「上一张回来再发下一张」。
 * 硬套过去会变成「一口气发 20 个请求」，把额度和事件循环一起打满。
 *
 * @param {object} o
 * @param {Array<{seq:number, path:string, file:string}>} o.items
 * @param {(item:object) => Promise<object>} o.worker 返回要写回图库的标注
 * @param {(seq:number, patch:object) => void} o.apply 把标注写进图库
 */
export function createOrganizeJob({ items = [], worker, apply, concurrency = MAX_INFLIGHT, log = () => {} } = {}) {
  const list = Array.isArray(items) ? items.slice() : [];
  const state = {
    id: `gjob-${Date.now().toString(36)}`,
    total: list.length,
    done: 0,
    failed: 0,
    /** 一开始就算「在跑」：面板第一片还没回来时看到「已结束 0%」会立刻 break */
    running: list.length > 0,
    cancelled: false,
    startedAt: Date.now(),
    finishedAt: 0,
    errors: [],
    /** 最近一条进度文案，面板直接显示，不用自己拼 */
    note: '',
  };

  let next = 0;

  const snapshot = () => ({
    ...state,
    errors: state.errors.slice(0, 5),
    percent: state.total ? Math.round((state.done / state.total) * 100) : 100,
  });

  const one = async () => {
    while (!state.cancelled) {
      const i = next;
      next += 1;
      const it = list[i];
      if (!it) return;
      try {
        const patch = await worker(it);
        if (state.cancelled) return;
        if (patch && Object.keys(patch).length) apply(it.seq, patch);
        state.done += 1;
      } catch (e) {
        state.failed += 1;
        if (state.errors.length < 5) {
          state.errors.push({ seq: it.seq, file: it.file, reason: String(e?.message ?? e) });
        }
        log(`图库整理跳过 #${it.seq}：${e?.message ?? e}`);
      }
      state.note = `第 ${state.done + state.failed}/${state.total} 张`;
    }
  };

  /** 启动。返回的 promise 可以 await（测试用），生产里直接不管它 */
  const start = async () => {
    if (!list.length) {
      state.running = false;
      state.finishedAt = Date.now();
      return snapshot();
    }
    const n = Math.max(1, Math.min(Number(concurrency) || MAX_INFLIGHT, 4));
    await Promise.all(Array.from({ length: n }, () => one()));
    state.running = false;
    state.finishedAt = Date.now();
    log(`图库整理结束：${state.done} 张成功，${state.failed} 张跳过`);
    return snapshot();
  };

  return {
    get id() { return state.id; },
    start,
    progress: snapshot,
    cancel() {
      state.cancelled = true;
      state.running = false;
      return snapshot();
    },
  };
}

/**
 * 读一张图，转成 `llmVision` 要的 `{data, mediaType}`。
 *
 * 超限直接抛：`ext-llm.js` 那边会把它过滤掉，最后报「没有可用的图片」——
 * 那句话对用户毫无信息量，不如在这里说清「这张图太大」。
 *
 * `maxB64` 可放宽：走「直接塞进上下文」那条路时图不必缩到视觉模型的
 * 400 KB 以内（附件服务自己会归一化），只有转交视觉模型时才受那个上限约束。
 */
export function imageForVision(path, file = path, { maxB64 = MAX_B64 } = {}) {
  const buf = readFileSync(path);
  const data = buf.toString('base64');
  if (data.length > maxB64) {
    throw new Error(`图太大（base64 ${Math.round(data.length / 1000)}KB，上限 ${Math.round(maxB64 / 1000)}KB）`);
  }
  return { data, mediaType: mediaTypeOf(file) };
}
