/**
 * `qq_menu`：让 AI 改自己在私聊里那排入口上的一行字
 * ================================================
 *
 * 这是「她自己表达」里最便宜的一个出口：`PUT /v2/menu` 官方写的是 5 QPM、
 * 只对 C2C 生效、**暂不需要单独提审**；改错了下一分钟就能改回去。
 * 而昵称/头像要开发者登录态、还没有撤销——所以心情这种事应该走这里。
 *
 * ## 为什么必须「读 → 改 → 写」
 *
 * `PUT /v2/menu` 是**覆盖式**：传上去的就是完整菜单，不传等于清空。
 * 模型只提交一格，主人的「帮助 / 关于」会被整份冲掉。所以每次写之前必须先 GET，
 * 把别的项原样带回去。
 *
 * （「覆盖式」目前只有官方文档与 `bot/src/api.js:1526` 的注释作依据，
 *  §11.2 列为待实测。这里按最坏情况防御：就算它不是覆盖式，读改写也不会更糟。）
 *
 * ## 为什么「她那一格」要单独存身份
 *
 * 用「名字以 `·` 开头」认格会误命中——用户自己也可能起一个「·帮助」。
 * 所以另存 `menu-slot.json` 记 `{index, name, type}`，匹配顺序是
 * **记录 → `·` 前缀 → 追加**，认不出就拒。
 *
 * 为什么「认不出就拒」而不是「找不到就追加」：追加是静默漂移——用户把那一格
 * 改个名，我们就再加一格，几次之后菜单占满 10 项、永久返回「菜单满了」，
 * 而模型没有腾格的能力，等于把她这条表达通道彻底弄哑。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadDefineTool, shapeTool } from './tools.js';
import { cooldownCheck, waitText } from './self-expression.js';

/** 菜单最多 10 项（官方限制；框架 `setGlobalMenu` 也会校验） */
export const MAX_MENU_ITEMS = 10;

/** 她那行字的长度上限：官方文档对「指令名」写的是 8 中文 / 16 英文，菜单项未明说，按 12 保守 */
export const MAX_MENU_TEXT = 12;

/** 她那一格的标记前缀。只在「没有记录」时用来认，不是唯一判据 */
export const SLOT_MARK = '·';

/** 重建时只带这些键：GET 回来的项可能带 `PUT` 不认的字段，原样回吐有风险 */
const ITEM_KEYS = ['name', 'type', 'send_message', 'link', 'sub_menu_items', 'switch'];

/** 官方 type 枚举 */
const ITEM_TYPES = new Set(['switch', 'send_message', 'link', 'menu']);

/**
 * 从 `getGlobalMenu` 的回包里抠出 items。
 *
 * 官方没给示例，两种形状都可能：`{items}` 或 `{menu:{items}}`。都认。
 * 认不出就返回 `null`（区分「空菜单」和「结构没看懂」——后者不该被当成空菜单去覆盖）。
 */
export function extractMenuItems(resp) {
  if (!resp || typeof resp !== 'object') return null;
  const direct = Array.isArray(resp.items) ? resp.items : null;
  if (direct) return direct;
  const nested = resp.menu && typeof resp.menu === 'object' && Array.isArray(resp.menu.items)
    ? resp.menu.items
    : null;
  if (nested) return nested;
  /** 有些实现会包一层 data */
  const data = resp.data && typeof resp.data === 'object' ? resp.data : null;
  if (data) return extractMenuItems(data);
  return null;
}

/**
 * 挑出「她那一格」。
 *
 * @param {object[]} items 现有菜单
 * @param {{index:number,name:string}|null} saved 上次记下的身份
 * @returns {{index:number, mode:'saved'|'marker'|'append'} | {error:string}}
 */
export function pickMenuSlot(items, saved) {
  const list = Array.isArray(items) ? items : [];
  /** 「以前记过」和「记录还对得上」是两件事：前者决定能不能追加，后者决定能不能直接改 */
  const hasSaved = Boolean(
    saved
    && Number.isInteger(saved.index)
    && saved.index >= 0
    && String(saved.name ?? ''),
  );
  const savedOk = hasSaved
    && saved.index < list.length
    && String(list[saved.index]?.name ?? '') === String(saved.name);

  if (savedOk) return { index: saved.index, mode: 'saved' };

  const marked = list
    .map((it, i) => ({ it, i }))
    .filter((x) => String(x.it?.name ?? '').startsWith(SLOT_MARK));

  if (marked.length === 1) return { index: marked[0].i, mode: 'marker' };

  if (marked.length > 1) {
    /**
     * 多个都带标记：**不猜**。猜错就是把别人那一格改掉，
     * 而这种错误只有在有人点菜单时才会发现。
     */
    return {
      error: `菜单里有 ${marked.length} 项都以「${SLOT_MARK}」开头，分不清哪一格是她的。`
        + '让主人把其它几项改名，或者删掉多余的。',
    };
  }

  /**
   * **以前记过、现在对不上** → 必须拒。
   *
   * 这是最容易写错的一处：如果这里退回「追加」，用户把那一格改个名之后，
   * 我们就再补一格；几次之后菜单占满 10 项、永久返回「满了」，
   * 而模型没有腾格的能力 —— 她的表达通道就这么被自己堵死了。
   * 只有「从来没记过」（`hasSaved` 为假）才算首次，才允许追加。
   */
  if (hasSaved) {
    return {
      error: `上次那一格（第 ${saved.index + 1} 项「${saved.name}」）不在了，可能被改名或删掉。`
        + '别猜着再加一格，让主人看一眼菜单里现在有哪几项。',
    };
  }

  if (list.length >= MAX_MENU_ITEMS) {
    return { error: `菜单已经满 ${MAX_MENU_ITEMS} 项了，得先让主人腾一格。` };
  }

  /** 首次：追加一格。只在这里追加，之后一律靠记录认 */
  return { index: list.length, mode: 'append' };
}

/**
 * 校验她要写的那行字。
 * @returns {{ok:true,text:string} | {ok:false,message:string}}
 */
export function validateMenuText(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, message: '要写的字是空的。' };
  /** 按码点算：中文一个字算 1，emoji 会被算成 2，宁可严格一点 */
  const len = [...text].length;
  if (len > MAX_MENU_TEXT) {
    return { ok: false, message: `太长（${len} 字），菜单那行最多 ${MAX_MENU_TEXT} 个字。` };
  }
  if (/^[·\s]+$/.test(text)) return { ok: false, message: '只有符号，换句有内容的。' };
  return { ok: true, text };
}

/** 按白名单重建一项（丢掉 GET 回来的未知字段） */
function rebuildItem(it) {
  const out = {};
  for (const k of ITEM_KEYS) {
    if (it && it[k] !== undefined) out[k] = it[k];
  }
  const type = String(out.type ?? '');
  if (!ITEM_TYPES.has(type)) out.type = 'send_message';
  return out;
}

/**
 * 把新的一格合进整份菜单。
 *
 * 两条硬约束：
 *   · **只改 `send_message` 类型的项**。改一个 `link` 或 `menu` 的 name 会把它的语义
 *     弄坏（点进去还是那个链接 / 子菜单，只是标签变了），那不是表达，是搞破坏。
 *   · 名字和载荷一起写：`say` 没给时就沿用原来的 `send_message`，
 *     否则会出现「标签换了、点进去发的还是旧那句话」。
 *
 * @returns {{ok:true, items:object[], slot:object} | {ok:false, message:string}}
 */
export function applyMenuSlot(items, index, { text, say } = {}) {
  const list = Array.isArray(items) ? items : [];
  const isAppend = index >= list.length;
  const next = list.map(rebuildItem);

  if (isAppend) {
    const item = { name: text, type: 'send_message', send_message: String(say ?? '在的') };
    next.push(item);
    return { ok: true, items: next, slot: { index, name: item.name, type: item.type } };
  }

  const cur = next[index];
  if (!cur) return { ok: false, message: '那一格不在了（菜单刚被改过？）' };
  if (cur.type !== 'send_message') {
    return {
      ok: false,
      message: `那一格是 ${cur.type} 类型，改名字会把它的用途弄坏。`
        + '让她换一格 `send_message` 的，或者让主人先建一格。',
    };
  }

  cur.name = text;
  if (say !== undefined && String(say).trim()) cur.send_message = String(say).trim();
  return { ok: true, items: next, slot: { index, name: cur.name, type: cur.type } };
}

/** 菜单项名字清单（给模型看「现在有哪几格」） */
export const namesOf = (items) => (Array.isArray(items) ? items : [])
  .map((it, i) => `${i}:${String(it?.name ?? '')}`)
  .join('，');

/**
 * slot 身份的落盘。
 *
 * 单独一个文件而不是塞进 `config.json`：它是运行态（菜单被人改过就失效），
 * 不该跟用户配置混在一起，也不该被 `pruneTo` 的白名单规则管。
 */
export function createSlotStore({ dataDir, log = () => {} } = {}) {
  const file = () => join(dataDir(), 'menu-slot.json');

  function read() {
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      const index = Number(raw.index);
      const name = String(raw.name ?? '');
      if (!Number.isInteger(index) || index < 0 || !name) return null;
      return { index, name, type: String(raw.type ?? '') };
    } catch {
      return null;
    }
  }

  function write(slot) {
    try {
      const dir = dataDir();
      mkdirSync(dir, { recursive: true });
      const tmp = `${file()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...slot, at: Date.now() }, null, 2), { mode: 0o600 });
      renameSync(tmp, file());
    } catch (e) {
      /** 记不住身份不该让改菜单失败——下次会退回「· 前缀」判据 */
      log(`[menu] 写 menu-slot 失败：${e?.message ?? e}`);
    }
  }

  return { read, write, file };
}

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
};

/**
 * 工具定义。副作用全在闭包里注入，方便单测（`rpc` 可以给假的）。
 *
 * @param {object} p
 * @param {(m:string,p?:object)=>Promise<any>} p.rpc 外接协议
 * @param {()=>object} p.cfgOf 每次现读配置（热生效）
 * @param {object} p.slots  `createSlotStore()` 的产物
 * @param {object} p.history `createHistory()` 的产物
 * @param {(e:object)=>void} [p.audit]
 * @param {number} p.now
 */
export function buildMenuTool({ rpc, cfgOf, slots, history, audit = () => {}, now = () => Date.now(), log = () => {}, sidOf = () => '', callerOf = () => ({}) }) {
  /** 同一会话 10 秒内只允许写一次：防模型连调把 5 QPM 打光，也防它自己死循环 */
  let lastWrite = { at: 0, sid: '' };

  return {
    name: 'qq_menu',
    description:
      '改你自己在私聊里那排入口上的一行字（别人不会收到消息，只是那一格显示的字变了）。'
      + '心情变了、想换个说法招呼人时用它；不传 text 就是看现在写着什么。'
      + '改错了随时能改回来，但一次一个说法，别来回换。'
      + '可选 say 是「别人点这一格之后你发出去的第一句话」，不给就沿用原来那句。',
    parameters: {
      text: { type: 'string', description: `要显示的那行字，最多 ${MAX_MENU_TEXT} 个字；不传 = 只读` },
      say: { type: 'string', description: '可选：点这一格之后发出去的话；不给就沿用原来的' },
    },
    output: OUTPUT,
    async execute({ text, say } = {}) {
      const conf = cfgOf()?.selfExpression?.menu;
      /**
       * 双保险：注册时已经按 `enabled` 跳过了，但面板上刚关掉、agent 还没重挂时，
       * 这里必须再挡一次——否则「关了还生效」是最难解释的那种行为。
       */
      if (conf?.enabled === false) {
        return { ok: false, message: '菜单这一项现在关着，改了也不会生效。' };
      }
      /**
       * 菜单只对 C2C 生效（官方限制）。在群里改也会真的写进去，但**群里没人看得见**——
       * 模型会以为「换了心情」，用户完全不知道发生了什么。所以群里直接拒，别让它白改。
       */
      if (String(callerOf()?.kind || '') === 'group') {
        return { ok: false, message: '菜单是私聊里那排入口，群里看不见，改了也没人会发现。' };
      }

      /* ---------- 读 ---------- */
      let items = null;
      try {
        const resp = await rpc('qq.call', { method: 'getGlobalMenu', args: [] });
        items = extractMenuItems(resp);
      } catch (e) {
        return { ok: false, message: `读菜单失败：${e?.message ?? e}` };
      }
      if (!items) {
        return {
          ok: false,
          message: '读回来了，但看不懂菜单的结构（没有 items）。这一步别猜，先让主人去面板看看。',
        };
      }

      const saved = slots.read();
      const picked = pickMenuSlot(items, saved);
      if (picked.error) return { ok: false, message: picked.error };

      /* ---------- 只读 ---------- */
      if (!text) {
        const cur = picked.index < items.length ? items[picked.index] : null;
        return {
          ok: true,
          mode: 'read',
          now: cur ? String(cur.name ?? '') : '',
          say: cur ? String(cur.send_message ?? '') : '',
          items: namesOf(items),
          note: cur ? '' : '现在还没有你的一格，第一次写会自动加一格。',
        };
      }

      /* ---------- 写 ---------- */
      const v = validateMenuText(text);
      if (!v.ok) return { ok: false, message: v.message };

      const cd = cooldownCheck(history.lastAt('menu'), conf?.cooldownMin, now());
      if (!cd.ok) {
        return { ok: false, message: `刚改过，还要等 ${waitText(cd.waitMs)}。` };
      }

      const sid = String(sidOf() || '');
      if (lastWrite.at && now() - lastWrite.at < 10_000 && lastWrite.sid === sid) {
        return { ok: false, message: '这一轮已经改过一次了，别连着改。' };
      }

      const built = applyMenuSlot(items, picked.index, { text: v.text, say });
      if (!built.ok) return { ok: false, message: built.message };

      const before = picked.index < items.length
        ? { index: picked.index, ...rebuildItem(items[picked.index]) }
        : null;

      try {
        await rpc('qq.call', { method: 'setGlobalMenu', args: [built.items] });
      } catch (e) {
        const message = String(e?.message ?? e);
        history.push({ kind: 'menu', ok: false, before, after: built.slot, note: message.slice(0, 200) });
        audit({ op: 'selfexpr.menu', note: `失败：${message.slice(0, 80)}` });
        return { ok: false, message: `写菜单失败：${message}` };
      }

      slots.write(built.slot);
      lastWrite = { at: now(), sid };
      history.push({ kind: 'menu', before, after: built.slot });
      audit({ op: 'selfexpr.menu', note: picked.mode === 'append' ? '新增一格' : '换一格文案' });
      log(`[menu] 已改：${built.slot.index} → ${v.text}`);

      return { ok: true, mode: picked.mode, now: v.text, items: namesOf(built.items) };
    },
  };
}

/**
 * 挂到 agent 的工具表。形状照 `registerQqTools`（同一个 `shapeTool` / `defineTool` 分支）。
 *
 * @returns {Promise<{ok:boolean,names:string[],off?:Function,reason?:string}>}
 */
export async function registerMenuTool({ agent, ...deps } = {}) {
  const registry = agent?.ctx?.tools;
  if (!registry?.register) {
    return { ok: false, names: [], reason: '这个 agent 的 tools 服务没有 register（版本差异）' };
  }
  const defineTool = await loadDefineTool();
  const def = buildMenuTool(deps);
  try {
    const off = registry.register(shapeTool(def, defineTool));
    return { ok: true, names: [def.name], mode: defineTool ? 'defineTool' : 'plain', off };
  } catch (e) {
    return { ok: false, names: [], reason: `${def.name} 注册失败：${e?.message ?? e}` };
  }
}

/**
 * 回滚菜单里她那一格。
 *
 * 只回滚**那一格**，不是整份菜单：整份回滚会把主人在这期间自己加的项一起冲掉。
 * 如果那一格的位置已经越界（菜单被删短了），拒绝并说明——不要「就近找一格」顶上，
 * 那是拿别人那一格去改。
 *
 * @param {object} p
 * @param {{index:number,name:string,type?:string,send_message?:string}} p.before
 * @returns {Promise<{ok:boolean, message?:string, restored?:object}>}
 */
export async function restoreMenuSlot({ rpc, slots, before, log = () => {} }) {
  if (!before || !Number.isInteger(before.index) || !before.name) {
    return { ok: false, message: '这一条没记下那一格的旧样子，回不去。' };
  }
  let items = null;
  try {
    const resp = await rpc('qq.call', { method: 'getGlobalMenu', args: [] });
    items = extractMenuItems(resp);
  } catch (e) {
    return { ok: false, message: `读菜单失败：${e?.message ?? e}` };
  }
  if (!items) return { ok: false, message: '读回来了，但看不懂菜单的结构。' };

  const next = items.map(rebuildItem);
  const wantName = String(before.name);

  /**
   * 先确认「那一格还是她的」：
   *
   *   1. 位置 + 名字都对上 → 没动过，直接覆盖
   *   2. 名字对不上 → 菜单被重排过，**按名字找唯一匹配**
   *   3. 名字也找不到，但 slot 记录仍指着同一位置 → 她自己改过名，按位置覆盖
   *   4. 以上都不成立 → 拒
   *
   * 绝不「就近找一格」顶上：那是拿别人那一格去改，而错只有有人点菜单时才会发现。
   */
  let idx = -1;
  if (next[before.index] && next[before.index].name === wantName) {
    idx = before.index;
  } else {
    const hits = next.map((it, i) => ({ it, i })).filter(({ it }) => it.name === wantName);
    if (hits.length === 1) {
      idx = hits[0].i;
    } else if (hits.length > 1) {
      return { ok: false, message: `菜单里有 ${hits.length} 格都叫「${wantName}」，认不出原来那一格，没法退回。` };
    } else {
      const slot = slots?.read?.() || null;
      const sameSlot = slot && Number(slot.index) === before.index && next[before.index];
      if (!sameSlot) {
        return { ok: false, message: `菜单里找不到原来那一格「${wantName}」了（可能被删或换了位置），没法退回。` };
      }
      idx = before.index;
    }
  }

  const cur = next[idx];
  if (cur.type !== 'send_message' && cur.type !== String(before.type || '')) {
    return { ok: false, message: `那一格现在是 ${cur.type} 类型，直接覆盖会把它的用途弄坏。` };
  }
  cur.name = wantName;
  if (before.send_message !== undefined) cur.send_message = String(before.send_message);

  try {
    await rpc('qq.call', { method: 'setGlobalMenu', args: [next] });
  } catch (e) {
    return { ok: false, message: `写菜单失败：${e?.message ?? e}` };
  }
  slots.write({ index: idx, name: cur.name, type: cur.type });
  log(`[menu] 已退回：${idx} → ${cur.name}`);
  return { ok: true, restored: { index: idx, name: cur.name } };
}

/** 提示词：只在工具真挂上时注入，否则她会一直调一个不存在的工具 */
export function buildMenuPrompt({ enabled, cooldownMin = 0 } = {}) {
  if (!enabled) return '';
  const tail = cooldownMin > 0
    ? `那排字现在 ${cooldownMin} 分钟才能动一次（主人设的）。`
    : '';
  return [
    '你手边有一个很轻的出口：私聊里那排入口上的一行字（菜单）。',
    '改它不会给别人发消息，只是那一格显示的字变了；改错了随时能改回来。',
    '心情变了、想换个说法招呼人，动它就行。一次一个说法，别来回换。',
    tail,
  ].filter(Boolean).join('\n');
}
