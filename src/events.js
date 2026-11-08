/**
 * D8 经历层：**她自己做过的事**，短时保留，只给主人私聊当素材。
 *
 * 和 journal 的区别（这是它必须独立成文件的原因）：
 *   - journal 记「谁说过什么」，是长期记忆，会被巩固写成摘要再注入回来；
 *   - 这里记「她做过什么」（主动找过人、发过文件），24 小时就过期，
 *     **旁路 journal**——否则巩固会把「我刚才发了个文件」写进日记，
 *     下一轮又注入回来，变成自己跟自己的回音。
 *
 * 铁律：不存消息正文。一行只有 时间 / 动作类型 / 场合 / 会话，
 * 动作名来自下面的白名单，调用方传进来的自由文本一律丢掉。
 * 这样即使面板把整个文件展示出来，也不会变成第二份聊天记录。
 *
 * 「真 TTL」不是注入时假装看不见：load() 会把过期行**从盘上删掉**。
 * 只是筛掉不落盘，文件会一直留着几个月前的事，清了也还在。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const EVENT_TTL_MS = 24 * 3_600_000;
export const EVENT_MAX = 100;

/** 白名单：动作 → 注入时的人话。新增动作必须先在这里登记 */
export const EVENT_LABELS = Object.freeze({
  proactive: '主动找过你',
  file: '发过文件',
  image: '发过一张图',
  voice: '发过一段语音',
});

/**
 * 注入闸门：**只给主人私聊**。
 * 群里不该让群友看出她做过什么，也不该把别处的事带进群；
 * 开关关着时一个字都不给（默认关等价）。
 */
export function shouldInjectEvents({ enabled, bucket, kind } = {}) {
  return enabled === true && bucket === 'owner' && kind === 'c2c';
}

const hhmm = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function createEvents({
  file,
  max = EVENT_MAX,
  ttlMs = EVENT_TTL_MS,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  let rows = null;

  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(load()), 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      log(`写经历失败（不影响聊天）：${e.message}`);
    }
  }

  function load() {
    if (rows) return rows;
    let all = [];
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) all = raw.filter((r) => r && typeof r === 'object');
    } catch {
      all = [];
    }
    /** 过期行真的删掉，并回写一次；没过期就不动盘（避免每轮写文件） */
    const kept = all.filter((r) => Number(r.at) > 0 && now() - Number(r.at) <= ttlMs);
    rows = kept;
    if (kept.length !== all.length) save();
    return rows;
  }

  /** 缓存建好之后时间还会走，每次读/写前都要按「现在」再筛一遍 */
  function prune() {
    const all = load();
    const t = now();
    const kept = all.filter((r) => Number(r.at) > 0 && t - Number(r.at) <= ttlMs);
    if (kept.length !== all.length) {
      rows = kept;
      save();
    }
    return rows;
  }

  function recent(limit = 20) {
    const all = [...prune()].reverse();
    return limit > 0 ? all.slice(0, limit) : all;
  }

  /** 给主人私聊的注入块；没有有效行就返回空串，不占预算 */
  function text(limit = 6) {
    const today = new Date(now()).toDateString();
    const lines = recent(limit).map((r) => {
      const where = r.scene === 'group' ? '在群里' : '在私聊';
      const n = Number(r.count) > 1 ? `（${Number(r.count)} 次）` : '';
      /** 24h 窗口会跨过零点，只写 HH:MM 会把昨晚说成今天早上 */
      const day = new Date(r.at).toDateString() === today ? '今天' : '昨天';
      return `· ${day} ${hhmm(r.at)} ${where}${EVENT_LABELS[r.kind]}${n}`;
    });
    return lines.length ? `【最近做过的事】\n${lines.join('\n')}` : '';
  }

  return {
    push(row = {}) {
      const kind = String(row.kind ?? '');
      if (!Object.hasOwn(EVENT_LABELS, kind)) return 0;
      const all = prune();
      all.push({
        at: now(),
        kind,
        scene: row.scene === 'group' ? 'group' : 'c2c',
        /** 会话 id 只用于「在哪」，属于允许记的元数据；不是正文 */
        chatId: String(row.chatId ?? '').slice(0, 64),
        count: Math.min(20, Math.max(1, Number(row.count) || 1)),
      });
      if (all.length > max) all.splice(0, all.length - max);
      save();
      return all.length;
    },

    /** 最新在前，且全部未过期。limit<=0 给全部 */
    recent,
    text,

    clear() {
      rows = [];
      save();
    },

    get size() {
      return prune().length;
    },
  };
}
