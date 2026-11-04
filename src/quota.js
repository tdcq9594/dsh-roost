/**
 * 次数配额：**防刷屏、防烧钱，不是安全边界**。
 *
 * 这条要先说清楚，因为它决定了这里该做多严：
 * 同一个人换个号、换个群就能绕过去。真正拦人的是权限档位和工具开关，
 * 一个群友本来就不该有 `ops_bash`。配额管的是「他没权限，但还能让机器人
 * 一分钟发 40 条表情包」这类**滥用体验**的问题。
 *
 * 所以有两条与安全相反的取舍：
 *   · **计数失败一律放行**（文件坏了、并发写冲突）。宁可多放一次，
 *     也不能因为配额系统自己出毛病把正常对话堵死。
 *   · **不抛异常**。任何情况下都返回一个结果对象，让调用方按「放行」处理。
 *
 * ## 为什么用固定窗口而不是滑动窗口
 *
 * 「每天 3 次」在用户脑子里就是**按天**算的，不是「最近 24 小时」。
 * 滑动窗口要存一串时间戳，还要在每次检查时清理；固定桶只有一个整数，
 * 而且行为和人的预期一致：跨零点就是新的一天。
 * 代价是边界效应（23:59 和 00:01 各用 3 次，等于 2 分钟内 6 次）——
 * 对一个「防刷屏」的机制来说完全可以接受。
 *
 * ## 去重为什么要绑幂等键
 *
 * 发一条语音重试两次，如果按「每调一次 `qq_send` 扣一次」，用户看到 1 条、
 * 配额扣了 2 次，第二天莫名其妙少一条。所以扣减的 key 必须和投递用同一个
 * `requestId`：同一个 key 只认第一次。
 */

import fs from 'node:fs';
import { join } from 'node:path';

/** 窗口名的字面量，写错了当 `day` 处理，但会有 warn */
export const WINDOWS = ['message', 'turn', 'minute', 'hour', 'day'];

/**
 * 建议值。
 *
 * 这些数字是**面板上的提示**，不是默认生效的额度 —— 见下面 `QUOTA_DEFAULTS`
 * 那段说明。想收紧的人照着填，比面对一个空输入框自己猜要好。
 */
export const QUOTA_SUGGEST = {
  voice: 3,
  file: 2,
  sticker: 1,
  tool: 20,
  memory: 30,
};

/**
 * 默认配额。
 *
 * ## 为什么 `max` 全是 `-1`（不限）
 *
 * 这条链路上反复承诺过一件事：**升级后行为不能变**。`capabilities.json`
 * 不存在时权限策略完全走旧逻辑，配额也得守同一条规矩——否则老用户装上新版本，
 * 第一件事就是「群友发第二个文件被拒了」，而他从没配过任何东西。
 *
 * 所以默认是「不算」，用户在面板上填了数字才开始算。`per` / `window` 照样
 * 留着默认值，那是**统计口径**，不填也能用（给某个工具加额度时补的就是它）。
 *
 * 建议数量见 `QUOTA_SUGGEST`，面板的输入框占位符会显示它。
 *
 * ## 各项的口径
 *
 *   · 语音 3 条/人/天 —— 一天聊得再热也就几句语音，多了扰民；
 *   · 发文件 2 个/人/小时 —— 传文件是重动作，一分钟 10 个基本是失控；
 *   · 表情包 1 张/轮 —— 一轮一张就够表达情绪，多了是刷屏；
 *   · 工具调用 20 次/群/小时 —— 非主人档用工具本来就少，这个数是兜底；
 *   · 记忆检索 30 次/人/天 —— 她自己翻日记，太频繁说明在乱翻。
 */
export const QUOTA_DEFAULTS = {
  /**
   * `byBucket` 默认**不写**。
   *
   * 它是「这一档例外」，只有在顶层 `max` 有数字时才有意义。
   * 顶层不限（-1）却给主人写个 10，等于**只限主人一个人**——
   * 方向正好反了。想给主人更松的额度，先给顶层定个数，再单独给主人加一档。
   */
  voice: { window: 'day', max: -1, per: 'person' },
  file: { window: 'hour', max: -1, per: 'person' },
  sticker: { window: 'turn', max: -1, per: 'chat' },
  /**
   * 工具调用**总量**（不分具体工具）。默认不限。
   *
   * 这一项是「总闸」，一旦有数字就会把正常聊天卡住——群里一小时 20 次工具调用，
   * 稍微活跃一点就超了，表现是「刚刚还能用，突然什么都不能干了」。想收紧的人自己填。
   *
   * `-1` 在 `charge()` 里是**提前返回**（不做 load/sweep/save），
   * 所以默认状态下每次工具调用零额外 IO。
   */
  tool: { window: 'hour', max: -1, per: 'chat' },
  memory: { window: 'day', max: -1, per: 'person' },
};

/**
 * 哪些项**真的接上了**。
 *
 * 这个字段存在的唯一理由是不骗人：额度表里有五项，但只有接了调用点的才会
 * 真的扣、真的拦。不标出来，用户看到「语音条 每人每天 3 次」会以为配了就生效，
 * 而实际上那个数字躺在墙上什么也没做。
 *
 * 接了新调用点就把这里改成 true，面板会自己变。
 */
export const QUOTA_WIRED = {
  /** `<<say:>>` 的合成在 ai-chat 侧发起，那边不传 openid，按人算不了 → 待接 */
  voice: false,
  /** host.js 的 fileOf：扣在占位之前、失败回退 */
  file: true,
  /** host.js 的 pickOf：按「每群每轮」计 */
  sticker: true,
  /** tools.guard 里的总闸 */
  tool: true,
  /** memory_search 在 tools.js 里，拿不到 chatId → 待接 */
  memory: false,
};

export const QUOTA_LABELS = {
  voice: '语音条',
  file: '发文件',
  sticker: '表情包',
  tool: '工具调用',
  memory: '翻记忆',
};

/** 本地时间对齐的桶标签。用本地时区，「每天」才符合用户理解 */
function windowTag(window, now) {
  const d = new Date(now);
  const p2 = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  if (window === 'day') return `d:${day}`;
  if (window === 'hour') return `h:${day}T${p2(d.getHours())}`;
  if (window === 'minute') return `m:${day}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return '';
}

/**
 * @param {object} o
 * @param {string} o.dir 数据目录（文件落在 `quota.json`）
 * @param {Function} [o.log]
 * @param {Function} [o.now]
 * @param {object} [o.defaults] 覆盖默认配额（来自 config，面板会写）
 */
export function createQuota({ dir, log = () => {}, now = () => Date.now(), defaults = {} } = {}) {
  const file = join(dir, 'quota.json');

  /** `{ [bucketKey]: count }` */
  let counts = {};
  /** `{ [dedupeKey]: ts }` —— 幂等键去重，只留最近的 */
  let seen = {};
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      counts = obj?.counts && typeof obj.counts === 'object' ? obj.counts : {};
      seen = obj?.seen && typeof obj.seen === 'object' ? obj.seen : {};
    } catch {
      /** 文件不存在 / 坏了都从空开始。坏了不报错——配额丢了最多多放几次 */
      counts = {};
      seen = {};
    }
  }

  function save() {
    try {
      const tmp = `${file}.tmp`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ counts, seen }, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      /**
       * 写不动就算了。**不能因为配额写不进去而让对话失败**——
       * 下一次检查会读到旧值，最多多放几次。
       */
      log.warn?.(`quota.json 写不动（本次放行）：${e?.message || e}`);
    }
  }

  /**
   * 清理过期桶。
   *
   * 不清的话这个文件会一直长：每个群每小时一个键，一天就是几十上百条，
   * 半年后是几万条——读它都会变慢。只留当天的桶和最近的去重键。
   */
  function sweep(ts) {
    const day = windowTag('day', ts);
    for (const k of Object.keys(counts)) {
      // 桶键里带 `d:YYYY-MM-DD` / `h:...` / `m:...`；不是今天的就丢
      /** `x:` 是「按轮 / 按条」的桶，也带日期（见 charge 里的 tag），这里要一起认 */
      const m = k.match(/[|:]([dhmx]):(\d{4}-\d{2}-\d{2})/);
      if (m && `d:${m[2]}` !== day) delete counts[k];
    }
    const cutoff = ts - 2 * 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(seen)) {
      if (!(Number(v) >= cutoff)) delete seen[k];
    }
  }

  /**
   * 合并后的配额表：默认 ← 覆盖。
   *
   * `defaults` 允许是函数：面板改完额度要**立刻**生效。传值就是创建时那份快照，
   * 用户改完发现没反应，还以为要重启。
   */
  function table() {
    const src = typeof defaults === 'function' ? defaults() : defaults;
    const out = {};
    for (const [k, v] of Object.entries(QUOTA_DEFAULTS)) out[k] = { ...v };
    for (const [k, v] of Object.entries(src || {})) {
      if (!v || typeof v !== 'object') continue;
      /**
       * 用户自己加的工具配额（`web_search: { max: 20 }`）没有 base，
       * 这时要补一套默认的「每人 · 每天」——否则 `per` / `window` 是 undefined，
       * 桶键里出现字符串 `undefined`，同一个工具的额度会记到同一个桶上，
       * 表现是「全群共用一份额度」，和「每人 20 次」完全不是一回事。
       */
      const base = out[k] || { window: 'day', per: 'person' };
      out[k] = { ...base, ...v };
    }
    return out;
  }

  function specOf(feature) {
    return table()[feature] || null;
  }

  /**
   * 扣一次。**调用方必须在真正发出去之前调**，拿到 `ok:false` 就别发。
   *
   * @param {object} o
   * @param {string} o.feature `voice` / `file` / `sticker` / `tool` / `memory`
   * @param {string} [o.per] 覆盖「算谁的」：person / chat / global
   * @param {string} [o.id] 对应 per 的标识（openid / chatId / 空）
   * @param {string} [o.key] 幂等键。同一个 key 只扣一次（重试复用同一个）
   * @param {string} [o.turnKey] `window: 'turn'` 时必填
   * @returns {{ok:boolean, used?:number, max?:number, reason?:string, message?:string}}
   */
  function charge({ feature, per, id = '', key = '', turnKey = '', bucket = '' } = {}) {
    const spec = specOf(feature);
    /**
     * 没登记的功能 = 不限。**不是 deny**：新加一个功能却忘了登记配额，
     * 结果它一次都用不了，这种失败方式比「多放几次」严重得多。
     */
    if (!spec) return { ok: true, message: '没有配额度' };

    /**
     * 主人单独一套额度。
     *
     * 「一小时 2 个文件」是防**群友**指挥机器人刷屏的，扣到主人头上就是
     * 「我自己的电脑，发第三个文件它说超了」——那种体验很糟。但完全放开
     * 又挡不住模型失控循环发。所以给他一个明显更松的数，而不是无限。
     */
    const max = Number(spec.byBucket?.[bucket] ?? spec.max);
    if (!Number.isFinite(max) || max < 0) return { ok: true };
    if (max === 0) return { ok: false, used: 0, max: 0, reason: 'quota', message: '这个功能被设成 0 次了' };

    try {
      load();
      const ts = now();

      const w = spec.window;
      /**
       * `message` / `turn` 没有自然的时间桶，但**必须带上日期**——
       * 否则 `sweep` 认不出它是哪天的，这些桶会永远留在文件里，
       * 一天几十条，半年后读一次 `quota.json` 都要几百毫秒。
       */
      const tag = w === 'message' || w === 'turn'
        ? `x:${windowTag('day', ts).slice(2)}:${turnKey || key || ''}`
        : windowTag(w, ts);
      const bucketKey = `${feature}|${per || spec.per}|${id}|${tag}`;
      // 去重：同一个幂等键不重复扣（放在算完 bucketKey 之后，两处键不可能写岔）
      /**
       * 去重键要带 feature 前缀。
       *
       * 不带的话，`reset('voice')` 就没法只清语音的去重记录——
       * 清了会把发文件的也一起放行（重试重复扣），不清则重置之后
       * 同一个 key 仍然被当成「已经扣过」。
       */
      const dkey = key ? `${feature}:${key}` : '';
      if (dkey && Object.hasOwn(seen, dkey)) {
        return { ok: true, used: Number(counts[bucketKey] ?? 0), max, deduped: true };
      }

      const used = Number(counts[bucketKey] ?? 0);

      if (used >= max) {
        return {
          ok: false,
          used,
          max,
          reason: 'quota',
          message: `${QUOTA_LABELS[feature] || feature}这次用完了（${used}/${max}）`,
        };
      }

      counts[bucketKey] = used + 1;
      if (dkey) seen[dkey] = ts;
      sweep(ts);
      save();
      /**
       * 带一个 `undo`：扣完之后这一步**还可能失败**（发文件时 postReply 抛错）。
       * 失败要退回去，否则「一轮一个文件」的名额会被一次失败白白吃掉，
       * 用户看到的是「它说发，结果没发，还不肯再发一次」。
       */
      return {
        ok: true,
        used: used + 1,
        max,
        undo: () => {
          try {
            const cur = Number(counts[bucketKey] ?? 0);
            if (cur > 1) counts[bucketKey] = cur - 1;
            else delete counts[bucketKey];
            if (dkey) delete seen[dkey];
            save();
          } catch (e) {
            log.warn?.(`配额回退失败（不影响这一次）：${e?.message || e}`);
          }
        },
      };
    } catch (e) {
      /**
       * **任何异常都放行。** 配额是体验问题，不是安全问题；
       * 让它把正常对话堵死是绝对不能接受的失败方式。
       */
      log.warn?.(`配额检查出错（本次放行）：${e?.message || e}`);
      return { ok: true, message: '配额检查出错，本次放行' };
    }
  }

  /** 面板用：现在各功能用了多少 */
  function usage() {
    try {
      load();
      const ts = now();
      const rows = [];
      for (const [feature, spec] of Object.entries(table())) {
        const w = spec.window;
        /**
         * **只统计当前窗口**的桶。
         *
         * `sweep()` 只在 `charge()` 里跑，所以一整天没人调用时昨天的桶还躺在
         * `counts` 里。不过滤的话面板显示的「目前最多用到 N」是昨天的数字——
         * 用户会以为今天已经被用了那么多次，或者反过来说「明明没超怎么拦我」。
         */
        const tag = w === 'message' || w === 'turn'
          ? `x:${windowTag('day', ts).slice(2)}`
          : windowTag(w, ts);
        let peak = 0;
        let keys = 0;
        const re = new RegExp(`^${feature}\\|`);
        for (const [k, v] of Object.entries(counts)) {
          if (!re.test(k)) continue;
          // 桶键形如 `feature|per|id|tag`，`|` 保证不会和 id 里的字符误撞
          if (tag && !k.includes(`|${tag}`)) continue;
          keys += 1;
          if (v > peak) peak = v;
        }
        const maxNum = Number.isFinite(Number(spec.max)) ? Number(spec.max) : -1;
        rows.push({
          feature,
          label: QUOTA_LABELS[feature] || feature,
          window: w,
          per: spec.per,
          /**
           * 认不出就按「不限」处理，别把 `NaN` 送到界面上。
           * 手写 config 时写了个 `{ max: "每天三次" }` 就会走到这里。
           */
          max: maxNum,
          /** 输入框占位符用：告诉他「想收紧的话，合理的数是几」 */
          suggest: QUOTA_SUGGEST[feature] ?? null,
          /**
           * 按档位覆盖的额度。**必须给出去**：面板上写「发文件 2 个/小时」，
           * 而主人实际有 10 个——他会以为配额没生效，或者以为自己被骗了。
           */
          byBucket: spec.byBucket || {},
          /** 当前窗口里用得最多的那个桶——不是总和，总和没有意义（每个人各算各的） */
          peak,
          buckets: keys,
          /** 没接调用点的项：面板要如实标「暂未生效」 */
          wired: QUOTA_WIRED[feature] !== false,
        });
      }
      return { ok: true, at: ts, rows };
    } catch (e) {
      log.warn?.(`配额用量读不出来：${e?.message || e}`);
      return { ok: false, rows: [], message: String(e?.message || e) };
    }
  }

  /** 清空计数（面板上的「重置」）。去重键一起清，否则重置后重试还认老 key */
  function reset(feature = '') {
    load();
    if (!feature) {
      counts = {};
      seen = {};
    } else {
      for (const k of Object.keys(counts)) if (k.startsWith(`${feature}|`)) delete counts[k];
      for (const k of Object.keys(seen)) if (k.startsWith(`${feature}:`)) delete seen[k];
    }
    save();
    return { ok: true };
  }

  return { charge, usage, reset, table };
}
