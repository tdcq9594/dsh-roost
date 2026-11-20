/**
 * 她自己改资料：配置归一化 + 变更历史
 * ==================================
 *
 * 面板「人设 → 资料」页读写的就是这里的两个东西：
 *
 *   1. `config.selfExpression` —— 四个出口（菜单 / 简介 / 昵称 / 头像）的开关与冷却
 *   2. `<数据目录>/profile-history.json` —— 每次改动的 before/after，用来回滚
 *
 * ## 为什么不在这里调 QQ 接口
 *
 * 改资料的实现要分两条完全不同的链路（`dev.bot.*` 走开发者后台，`qq.call` 走机器人
 * 自身 token），错误分类也不一样。把它塞进这个模块会让「配置归一化」这种纯逻辑
 * 跟网络搅在一起，变成只能在真机上测。所以这里**只做数据**，执行在工具那一层。
 *
 * ## 为什么历史要单独一个文件
 *
 * 不放 `config.json`：每次改资料都会让整份配置落盘，还会被 `pruneTo` 的
 * 「数组/空对象」规则影响；而历史是**可变长、会被清空**的数据，不该参与配置合并。
 * 也不放 `audit.log`：审计只记「谁在什么时候做了什么」，不记内容；历史必须记内容
 * （否则回滚不了）。两者的隐私口径不同，混在一起会互相拖累。
 *
 * ## 隐私口径（别自欺欺人）
 *
 * 历史里存的是**正文**（简介可能带个人信息）。所以：文件权限 0600、只在数据目录、
 * 面板可一键清空、随备份走（备份是全目录打包）。审计那边仍然不记内容。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic.js';

/** 四个出口。顺序 = 面板上的展示顺序，也是「由轻到重」的顺序 */
export const SELF_KINDS = Object.freeze(['menu', 'sign', 'name', 'avatar']);

/**
 * 支持「主人确认」的三个出口。
 *
 * 菜单不在里面：它一秒能改回来、只影响私聊里那一行字，为它加一道私聊确认
 * 只是让「换个说法」变得比说话还麻烦。
 */
export const CONFIRM_KINDS = Object.freeze(['sign', 'name', 'avatar']);

/**
 * 「没人看着的轮次（主动搭话 / 夜间巩固）允不允许改」的默认值。
 *
 * 简介不涉及对外身份，默认允许；昵称与头像是所有人看到的那张脸，
 * 默认必须有人在场。三项都能在面板「人设 → 资料」里单独改，
 * 这里只是**新装/升级后的初始值**，不替用户做长期决定。
 */
export const UNATTENDED_DEFAULTS = Object.freeze({ sign: true, name: false, avatar: false });

/**
 * 头像「本机图片路径」能不能超出数据目录。
 *
 * **默认允许**，因为这是老用户已有的用法（把桌面/相册里的一张图当头像），
 * 升级不该悄悄把人家的能力收掉。代价是 `qq_avatar` 的 `path` 分支成了
 * 模型可触发的一条读盘通道：提示词注入成功一次，就能把本机任意 png/jpg
 * 传成公开头像。所以给一个开关，想收紧的人自己在面板关掉——关掉之后
 * 只认数据目录里的文件（软链接按 `realpath` 判，绕不过去）。
 */
export const AVATAR_ANY_PATH_DEFAULT = true;

/** 面板文案用；解析时不用 */
export const KIND_LABELS = Object.freeze({
  menu: '菜单',
  sign: '简介',
  name: '昵称',
  avatar: '头像',
});

/**
 * 冷却上限：一周。
 *
 * 不是「建议值」，是防手滑——面板输入框能填 999999999，夹到一周既够用，
 * 又不会让一个十进制错误变成「永远改不了」。0 = 不限，单独处理。
 */
export const MAX_COOLDOWN_MIN = 7 * 24 * 60;

/** 历史保留条数。够回滚到「上上个版本」，又不至于变成一本相册 */
export const MAX_HISTORY = 20;

/** 冷却归一：非数字 / 负数 / NaN 一律当 0（不限），不做「默认 30 分钟」这种暗默认 */
export function normalizeCooldown(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), MAX_COOLDOWN_MIN);
}

/**
 * 把配置里的这一段整理成**结构完整**的形状。
 *
 * 为什么要归一化而不是直接用：`saveConfig` 会用 `DEFAULTS` 合并，但用户手改
 * `config.json`、或从老版本升上来时，可能缺键、可能把 `cooldownMin` 写成字符串。
 * 面板与工具都直接读这份结构，缺一个键就是 `undefined` 满天飞。
 *
 * @param {object} raw 配置里的 `selfExpression`（可能为 undefined）
 * @returns {{menu:object, sign:object, name:object, avatar:object, awareness:object, proactive:object}}
 */
export function normalizeSelfExpression(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const kind of SELF_KINDS) {
    const one = src[kind] && typeof src[kind] === 'object' ? src[kind] : {};
    out[kind] = {
      /** 只有明确 `false` 才算关；缺键按开（默认能用） */
      enabled: one.enabled !== false,
      cooldownMin: normalizeCooldown(one.cooldownMin),
      /**
       * 是否需要「私聊主人确认」。**默认关**：开着等于给每次改动加一轮来回，
       * 那是用户明确要的才开，不是我们替他决定。
       * 菜单没有这个字段（见 `CONFIRM_KINDS`）。
       */
      ...(CONFIRM_KINDS.includes(kind) ? {
        confirm: one.confirm === true,
        /**
         * 没人看着的轮次（主动搭话 / 夜间巩固）允不允许改。
         * 缺键时取 `UNATTENDED_DEFAULTS`：简介允许、昵称头像不允许。
         */
        unattended: 'unattended' in one ? one.unattended === true : UNATTENDED_DEFAULTS[kind] === true,
      } : {}),
      /**
       * 只有头像有这一项：`path` 分支能不能读数据目录之外的文件。
       * 缺键按「允许」（见 `AVATAR_ANY_PATH_DEFAULT`），明确 `false` 才收窄。
       */
      ...(kind === 'avatar' ? {
        anyPath: 'anyPath' in one ? one.anyPath !== false : AVATAR_ANY_PATH_DEFAULT,
      } : {}),
    };
  }
  const aw = src.awareness && typeof src.awareness === 'object' ? src.awareness : {};
  out.awareness = {
    mood: aw.mood !== false,
    silence: aw.silence !== false,
  };
  const pro = src.proactive && typeof src.proactive === 'object' ? src.proactive : {};
  /**
   * `fields` 只留合法出口。
   *
   * 这里**故意允许 name**：工具实现会自己的拒绝（改昵称要有人在场），
   * 在这一层过滤掉会让人以为「开了却没生效」，而配置回显又看不出原因。
   * 面板上会明确写「昵称只有在主人说话那一轮才改得成」。
   */
  const fields = Array.isArray(pro.fields)
    ? [...new Set(pro.fields.map((x) => String(x ?? '').trim()).filter((x) => SELF_KINDS.includes(x)))]
    : ['menu'];
  out.proactive = {
    enabled: pro.enabled === true,
    fields,
  };
  return out;
}

/**
 * 把面板提交的 patch 合进当前配置。
 *
 * 白名单式：只认 `SELF_KINDS` 的 `enabled`/`cooldownMin`、`awareness` 两个布尔、
 * `proactive.enabled`/`fields`。其它键**静默丢弃**（和 `audit()` 同一套态度：
 * 未知字段进来不报错，也不落盘，免得把配置写成垃圾场）。
 *
 * @param {object} cur 当前（已归一化的）配置
 * @param {object} patch 来自面板的局部提交
 * @returns {object} 新的完整结构
 */
export function patchSelfExpression(cur, patch) {
  const base = normalizeSelfExpression(cur);
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = normalizeSelfExpression(base);

  for (const kind of SELF_KINDS) {
    const one = p[kind];
    if (!one || typeof one !== 'object') continue;
    if ('enabled' in one) next[kind].enabled = one.enabled !== false;
    if ('cooldownMin' in one) next[kind].cooldownMin = normalizeCooldown(one.cooldownMin);
    if ('confirm' in one && CONFIRM_KINDS.includes(kind)) next[kind].confirm = one.confirm === true;
    if ('unattended' in one && CONFIRM_KINDS.includes(kind)) next[kind].unattended = one.unattended === true;
    if ('anyPath' in one && kind === 'avatar') next[kind].anyPath = one.anyPath !== false;
  }

  if (p.awareness && typeof p.awareness === 'object') {
    if ('mood' in p.awareness) next.awareness.mood = p.awareness.mood !== false;
    if ('silence' in p.awareness) next.awareness.silence = p.awareness.silence !== false;
  }

  if (p.proactive && typeof p.proactive === 'object') {
    if ('enabled' in p.proactive) next.proactive.enabled = p.proactive.enabled === true;
    if ('fields' in p.proactive && Array.isArray(p.proactive.fields)) {
      const list = p.proactive.fields
        .map((x) => String(x ?? '').trim())
        .filter((x) => SELF_KINDS.includes(x));
      next.proactive.fields = [...new Set(list)];
    }
  }

  return next;
}

/**
 * 这一轮还能不能写（冷却）。
 *
 * 纯函数：给「上次写入时间」和「冷却分钟」，返回能不能写、还要等多久。
 * 不做「同轮二次写」的检查——那条在工具层硬拦（每轮一次，防死循环），
 * 跟这里是两回事，混在一起就调不动了。
 *
 * @param {number} lastAt 上次写入的毫秒时间戳；0 = 从没写过
 * @param {number} cooldownMin 0 = 不限
 * @param {number} now 当前时间
 * @returns {{ok:boolean, waitMs:number}}
 */
export function cooldownCheck(lastAt, cooldownMin, now = Date.now()) {
  const mins = normalizeCooldown(cooldownMin);
  if (!mins) return { ok: true, waitMs: 0 };
  const last = Number(lastAt) || 0;
  if (!last) return { ok: true, waitMs: 0 };
  const waitMs = last + mins * 60_000 - now;
  return waitMs > 0 ? { ok: false, waitMs } : { ok: true, waitMs: 0 };
}

/** 「还要等 37 分钟」→ 给模型/面板看的人话。不足一分钟按一分钟说，别报 0.4 分钟 */
export function waitText(waitMs) {
  const mins = Math.max(1, Math.ceil((Number(waitMs) || 0) / 60_000));
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.ceil(mins / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.ceil(hours / 24)} 天`;
}

/** 历史文件的路径。抽出来是为了测试能指到临时目录 */
export const historyFileOf = (dir) => join(dir, 'profile-history.json');

/**
 * 变更历史：读 / 追加 / 清空。
 *
 * 只存**可重放的最小对象**（见方案的 §6.1）：
 *   · sign   → 字符串
 *   · name   → `{ name, selfName, personaId }`
 *   · avatar → `{ url, avatarId? }`（平台只回 URL，写回要 avatarId，两者不通）
 *   · menu   → `{ index, name, type, send_message }`（整份菜单回滚会冲掉别人的改动）
 *
 * 写文件用 temp + rename：不是防并发（并发在工具层用锁），是防「写到一半断电」
 * 把整份历史变成空文件——那才是真正回不去的情况。
 */
export function createHistory({ dataDir, now = () => Date.now(), log = () => {} } = {}) {
  const file = () => historyFileOf(dataDir());

  function read() {
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8'));
      const rows = Array.isArray(raw?.entries) ? raw.entries : [];
      return rows.filter((r) => r && typeof r === 'object').slice(-MAX_HISTORY);
    } catch {
      /** 文件不存在 / 坏掉都当空。坏文件不该让整个面板打不开 */
      return [];
    }
  }

  function writeAll(rows) {
    writeJsonAtomic(file(), { version: 1, entries: rows.slice(-MAX_HISTORY) }, { mode: 0o600 });
  }

  /**
   * 追加一条。
   *
   * `ok:false` 的记录**也要留**：失败尝试同样是「她在动」的证据，
   * 而且能回答「为什么没改成功」——只留成功记录会让面板看起来一片太平。
   */
  function push(entry = {}) {
    const kind = SELF_KINDS.includes(entry.kind) ? entry.kind : '';
    if (!kind) return null;
    const rows = read();
    /**
     * `at` 是回滚时的定位键（`{kind, at}`），**同一毫秒两条同类型记录**会让
     * 「点第 2 条」指到第 1 条上去。面板连点两下、或一次批量改动都可能撞上，
     * 所以这里撞了就往后挪 1ms —— 时间戳差 1ms 对任何展示都无感。
     */
    let at = Number(entry.at) || now();
    const last = rows[rows.length - 1];
    if (last && last.kind === kind && Number(last.at) === at) at += 1;
    const row = {
      at,
      kind,
      via: entry.via === 'proactive' ? 'proactive' : 'manual',
      by: String(entry.by || ''),
      ok: entry.ok !== false,
      before: entry.before ?? null,
      after: entry.after ?? null,
      note: entry.note == null ? '' : String(entry.note).slice(0, 200),
    };
    rows.push(row);
    try {
      writeAll(rows);
    } catch (e) {
      /** 历史写不进去不该让操作失败——但一定要留痕，否则「回滚不了」查不出原因 */
      log(`写变更历史失败：${e?.message ?? e}`);
    }
    return row;
  }

  /** 某一类最近一条成功的记录（回滚用） */
  function lastOf(kind) {
    const rows = read();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].kind === kind && rows[i].ok !== false) return rows[i];
    }
    return null;
  }

  /** 最近一次写入时间（冷却用，四类共用一个时间轴时传 kind = null） */
  function lastAt(kind = null) {
    const rows = read();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].ok === false) continue;
      if (!kind || rows[i].kind === kind) return Number(rows[i].at) || 0;
    }
    return 0;
  }

  function clear() {
    try {
      writeAll([]);
      return true;
    } catch (e) {
      log(`清空变更历史失败：${e?.message ?? e}`);
      return false;
    }
  }

  return { read, push, lastOf, lastAt, clear, file };
}
