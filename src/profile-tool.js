/**
 * `qq_sign` / `qq_name`：改简介与昵称
 * ===================================
 *
 * 与 `qq_menu` 最大不同：**改的是平台上的资料卡**，走开发者后台（`dev.bot.*`），
 * 不是机器人自己的 token。所以它有三个前置：
 *
 *   1. 框架侧必须已经登录开放平台（登录入口是 `manage` 档，宿主拿不到，只能人去面板扫）
 *   2. `dev.bot.set` 的 `base` 是**整包提交**，只改 desc 也会带 `name:''`，
 *      靠 `filter` 位让平台忽略——所以「只写你要改的那个字段」由这里的 `filter` 保证，
 *      不是靠不传
 *   3. 改完本地要能自洽：昵称变了，`config.persona.name` 也得跟着变，
 *      否则 6 小时后 `services/nickname.js` 把平台名字拉回来，提示词里还是旧的
 *
 * ## 为什么昵称遇到角色卡人格要拒
 *
 * 角色卡人格（QQ-Agent 那批：若叶睦、高松灯…）在 `.md` 头部写死了 `selfName`，
 * 它盖过 `config.persona.name`。平台昵称改了、selfName 没改，就会出现
 * 「资料卡叫小蓝、她自称若叶睦」——xAI 伴侣那次就是这个结构性问题把后端搞崩的。
 *
 * 但**自动改 `selfName` 更糟**：那是在写用户手写的 markdown（front-matter 里可能有
 * 注释、缩进、别的字段），一次格式化失误就把人格卡弄坏，而且不可逆。
 * 所以这里选择**拒绝并说明**：让用户明确去改人格卡。把选择权交回人，
 * 比替他改文件安全。
 */

import { statSync, readFileSync } from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';

import { loadDefineTool, shapeTool } from './tools.js';
import { cooldownCheck, waitText } from './self-expression.js';

/** 平台昵称的合理上限。官方没给明确数字，按 24 个字符挡，免得出现一串没有意义的长名 */
export const MAX_NAME_LEN = 24;

/** 简介上限。官方「介绍」字段的输入框一般允许多行但不长 */
export const MAX_DESC_LEN = 200;

/** 头像：官方只收这四种，≤2MB。框架侧还会再拦一道，这里先挡省一次上传 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/bmp', 'image/gif'];

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
};

/** 把协议/SDK 的错误翻成人话；认不出的原样带回去，别假装知道 */
export function friendlyDevError(e) {
  const raw = String(e?.message ?? e ?? '');
  if (/NOT_LOGGED_IN|未登录/i.test(raw)) {
    return '开发者后台没登录，这一步得主人先去面板那边扫码。';
  }
  if (/10000|系统繁忙|PLATFORM_BUSY/.test(raw)) {
    return '平台刚拒了一次（可能限频），过一会儿再说。';
  }
  if (/AVATAR_UPLOAD_FAILED|BAD_IMAGE/.test(raw)) {
    return raw;
  }
  return raw;
}

/** 简介/昵称的文本校验（与菜单不同：这里允许空格，但不能是一串纯空白） */
export function validateProfileText(raw, { field, max }) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return { ok: false, message: `${field}不能是空的。` };
  const len = [...text].length;
  if (len > max) return { ok: false, message: `${field}太长（${len} 字），最多 ${max} 字。` };
  return { ok: true, text };
}

/**
 * 扩展名 → MIME。官方只认这四种。
 *
 * 用扩展名而不是读文件头：读文件头要多读一遍、还要维护签名表；
 * 而真正的格式判定在框架侧和平台侧各有一道（`platform.js` 的 `AVATAR_MIMES`），
 * 这里只做「明显不是图」的拦截。
 */
const EXT_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
});

/**
 * 把本地图片读成 dataUrl。
 *
 * **为什么允许本地路径**：主人这一档本来就有读文件的工具（`read` / `fs`），
 * 再把它挡在头像这里只是「多一道猜谜」——她还得分两次调用、把图先发给主人才行。
 * 真正该守的不是「能不能读」，而是**读到的东西是不是一张官方收得下的图**：
 * 扩展名白名单 + 先 `stat` 再读（超 2MB 不读进内存）+ 只认普通文件。
 *
 * @returns {{ok:true, dataUrl:string, bytes:number, mime:string} | {ok:false, message:string}}
 */
export function readImageAsDataUrl(rawPath, { stat = statSync, readFile = readFileSync } = {}) {
  const p = resolvePath(String(rawPath ?? '').trim());
  if (!String(rawPath ?? '').trim()) return { ok: false, message: '路径是空的。' };

  let st;
  try {
    st = stat(p);
  } catch {
    return { ok: false, message: `这个文件不存在：${p}` };
  }
  if (!st.isFile()) return { ok: false, message: `这是文件夹不是文件：${p}` };

  const mime = EXT_MIME[extname(p).toLowerCase()];
  if (!mime) {
    return {
      ok: false,
      message: `官方只收 ${Object.keys(EXT_MIME).join(' / ')}，这个后缀不行：${extname(p) || '（没有后缀）'}`,
    };
  }
  /**
   * 先看大小再读：2MB 的图读进内存无所谓，200MB 的「图片」读到一半才报错就很难看，
   * 而且会把整个进程的内存顶上去。`stat` 是一次系统调用，比读文件便宜得多。
   */
  if (st.size > AVATAR_MAX_BYTES) {
    return {
      ok: false,
      message: `这张 ${(st.size / 1024 / 1024).toFixed(1)}MB，官方上限 2MB。`,
    };
  }
  if (st.size === 0) return { ok: false, message: `这个文件是空的：${p}` };

  let buf;
  try {
    buf = readFile(p);
  } catch (e) {
    return { ok: false, message: `读不了这个文件：${e?.message ?? e}` };
  }
  return { ok: true, dataUrl: `data:${mime};base64,${Buffer.from(buf).toString('base64')}`, bytes: buf.length, mime };
}

/**
 * 头像来源校验。
 *
 * 三条路：`url`（http/https）、`dataUrl`（直接给图）、`path`（本机图片路径）。
 * 顺序是 url → dataUrl → path，第一个给了就算。
 *
 * @returns {{ok:true, src:object, kind:'url'|'dataUrl'|'path'} | {ok:false, message:string}}
 */
export function validateAvatarSource({ url, dataUrl, path } = {}) {
  const u = String(url ?? '').trim();
  if (u) {
    if (!/^https?:\/\//i.test(u)) {
      return { ok: false, message: '图片地址要 http 或 https 开头。' };
    }
    return { ok: true, src: { url: u }, kind: 'url' };
  }

  const d = String(dataUrl ?? '').trim();
  if (d) {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(d);
    if (!m) return { ok: false, message: '图片数据的格式不对（要 data:image/...;base64,...）。' };
    const mime = m[1].toLowerCase();
    if (!AVATAR_MIMES.includes(mime)) {
      return { ok: false, message: `官方不收 ${mime}，只收 ${AVATAR_MIMES.map((x) => x.slice(6)).join(' / ')}。` };
    }
    /** 用长度估算字节数，避免为了「查大小」先解一遍 base64 */
    const bytes = Math.floor((m[2].length * 3) / 4);
    if (bytes > AVATAR_MAX_BYTES) {
      return { ok: false, message: `这张 ${(bytes / 1024 / 1024).toFixed(1)}MB，官方上限 2MB。` };
    }
    return { ok: true, src: { dataUrl: d }, kind: 'dataUrl' };
  }

  const pth = String(path ?? '').trim();
  if (pth) {
    const got = readImageAsDataUrl(pth);
    if (!got.ok) return got;
    return { ok: true, src: { dataUrl: got.dataUrl }, kind: 'path', bytes: got.bytes };
  }

  return { ok: false, message: '要给一个图片地址（url）、一段 dataUrl，或者本机上的一张图（path）。' };
}

/**
 * 昵称能不能改。
 *
 * @param {{selfName?:string, id?:string}} persona 当前人格
 * @returns {{ok:true} | {ok:false, message:string}}
 */
export function checkRenameAllowed(persona) {
  const self = String(persona?.selfName ?? '').trim();
  if (!self) return { ok: true };
  return {
    ok: false,
    message: `当前人格卡里写死了她叫「${self}」（selfName），改平台昵称会变成`
      + '「资料卡一个名字、她自称另一个名字」。要改先让主人改人格卡里的 selfName；'
      + '这一步不替人动他手写的文件。',
  };
}

/**
 * @param {object} p
 * @param {(m:string,p?:object)=>Promise<any>} p.rpc
 * @param {()=>object} p.cfgOf
 * @param {object} p.history
 * @param {()=>({id?:string,selfName?:string})} p.personaOf 当前人格
 * @param {(name:string)=>void} [p.syncPersonaName] 写 `config.persona.name`
 * @param {()=>({bucket?:string,senderId?:string})} p.callerOf
 */
export function buildProfileTools({
  rpc, cfgOf, history, personaOf = () => ({}), syncPersonaName = () => {},
  callerOf = () => ({}), requestConfirm = null, audit = () => {}, now = () => Date.now(), log = () => {},
}) {
  /** 同一会话 10 秒内只允许一次写：防连调，也防模型把「改资料」当聊天动作反复用 */
  let lastWrite = { at: 0, sid: '' };

  /** 拿 appid：`system.hello` 里带着；框架没连上会抛 */
  async function appidOf() {
    const hello = await rpc('system.hello', {});
    const appid = String(hello?.bot?.appId || '');
    if (!appid) throw new Error('框架没回 appid（还没连上？）');
    return appid;
  }

  async function readBase() {
    const appid = await appidOf();
    const bot = await rpc('dev.bot.get', { appid });
    return { appid, base: bot?.base ?? {} };
  }

  /** 写之前的三道闸。返回非空就是拒绝理由 */
  async function precheck(kind) {
    const conf = cfgOf()?.selfExpression?.[kind];
    if (conf?.enabled === false) return { ok: false, message: '这一项现在关着，改了也不会生效。' };

    const cd = cooldownCheck(history.lastAt(kind), conf?.cooldownMin, now());
    if (!cd.ok) return { ok: false, message: `刚改过，还要等 ${waitText(cd.waitMs)}。` };

    const c = callerOf() || {};
    if (kind === 'name') {
      /**
       * 昵称必须**有人在场**。
       *
       * 主动搭话、定时器那些轮次没有真实消息发送者（`senderId` 为空）。
       * 注意不能靠 `bucket` 判：主动轮被硬塞了 `bucket:'owner'`，按 bucket 判是**放行**。
       */
      if (!String(c.senderId || '').trim()) {
        return { ok: false, message: '改名字得有人在跟你说话的时候才行，这会儿没有。' };
      }
      if (String(c.bucket || '') !== 'owner') {
        return { ok: false, message: '名字这事只有主人开口才算数。' };
      }
    }

    try {
      const st = await rpc('dev.status', {});
      if (st?.loggedIn !== true) {
        return { ok: false, message: '开发者后台没登录（改资料走的是开发者登录态），得先去面板扫码。' };
      }
    } catch (e) {
      return { ok: false, message: friendlyDevError(e) };
    }
    return { ok: true };
  }

  function turnGuard(sid) {
    if (lastWrite.at && now() - lastWrite.at < 10_000 && lastWrite.sid === sid) {
      return { ok: false, message: '这一轮已经改过一次了，别连着改。' };
    }
    return { ok: true };
  }

  /**
   * 需要「私聊主人确认」的那一项，把请求发出去。
   *
   * 返回 `ok:false` 但带 `pending:true` —— 对模型来说是「这件事还没成、别再试」，
   * 对用户来说是「已经去问了」。这两层意思必须同时给到，否则模型会反复重发请求。
   */
  async function gateConfirm(kind, payload, summary) {
    const conf = cfgOf()?.selfExpression?.[kind];
    if (conf?.confirm !== true) return { ok: true };
    if (typeof requestConfirm !== 'function') {
      return { ok: false, message: '这一项要求主人确认，但宿主没接确认通道，改不了。' };
    }
    const r = await requestConfirm({ kind, payload, summary });
    if (!r?.ok) return { ok: false, message: r?.message || '确认请求没发出去。' };
    return {
      ok: false,
      pending: true,
      code: r.code,
      message: `已经私聊问过主人了（编号 ${r.code}），等主人回复。这一轮不要重复请求。`,
    };
  }

  /* ---------------- 真正写入（工具与"确认后执行"共用） ---------------- */

  async function applySign(text, { sid = '' } = {}) {
    const v = validateProfileText(text, { field: '简介', max: MAX_DESC_LEN });
    if (!v.ok) return { ok: false, message: v.message };

    const tg = turnGuard(sid);
    if (!tg.ok) return tg;

    let before = '';
    try {
      const { appid, base } = await readBase();
      before = String(base.desc ?? '');
      await rpc('dev.bot.set', { appid, patch: { base: { desc: v.text } } });
    } catch (e) {
      const message = friendlyDevError(e);
      history.push({ kind: 'sign', ok: false, before, after: v.text, note: message.slice(0, 200) });
      audit({ op: 'selfexpr.sign', note: `失败：${message.slice(0, 80)}` });
      return { ok: false, message };
    }

    lastWrite = { at: now(), sid };
    history.push({ kind: 'sign', before, after: v.text });
    audit({ op: 'selfexpr.sign', note: '改简介' });
    log('[profile] 简介已改');

    /** 回读：平台可能做了裁剪/规范化，回给模型的是**实际生效值**而不是它传的值 */
    let nowDesc = v.text;
    try {
      const { base } = await readBase();
      nowDesc = String(base.desc ?? '');
    } catch { /* 回读失败不影响「已写入」这个事实 */ }
    return { ok: true, mode: 'write', desc: nowDesc, changed: nowDesc !== before };
  }

  async function applyName(name, { sid = '' } = {}) {
    const v = validateProfileText(name, { field: '昵称', max: MAX_NAME_LEN });
    if (!v.ok) return { ok: false, message: v.message };

    /** 角色卡人格：拒绝，并说清该去改哪儿（不替人动他手写的 markdown） */
    const allow = checkRenameAllowed(personaOf());
    if (!allow.ok) return allow;

    const tg = turnGuard(sid);
    if (!tg.ok) return tg;

    const persona = personaOf() || {};
    let before = { name: '', selfName: '', personaId: String(persona.id || '') };
    try {
      const got = await readBase();
      before = { ...before, name: String(got.base?.name ?? '') };
      await rpc('dev.bot.set', { appid: got.appid, patch: { base: { name: v.text } } });
    } catch (e) {
      const message = friendlyDevError(e);
      history.push({ kind: 'name', ok: false, before, after: { name: v.text }, note: message.slice(0, 200) });
      audit({ op: 'selfexpr.name', note: `失败：${message.slice(0, 80)}` });
      return { ok: false, message };
    }

    /**
     * 平台写成功了，才轮到本地。
     *
     * 顺序不能反：本地先改、平台失败的话，提示词里已经叫她新名字了，
     * 而资料卡还是旧的——用户看到的是「她说自己叫小蓝、点开还是大肥鱼」。
     */
    let synced = true;
    try {
      syncPersonaName(v.text);
    } catch (e) {
      synced = false;
      log(`[profile] 同步 persona.name 失败：${e?.message ?? e}`);
    }

    lastWrite = { at: now(), sid };
    history.push({ kind: 'name', before, after: { name: v.text }, note: synced ? '' : '本地名字没同步' });
    audit({ op: 'selfexpr.name', note: synced ? '改昵称' : '改昵称（本地未同步）' });
    log(`[profile] 昵称已改：${before.name} → ${v.text}`);

    let nowName = v.text;
    try {
      const got = await readBase();
      nowName = String(got.base?.name ?? '');
    } catch { /* 同上 */ }
    return {
      ok: true,
      mode: 'write',
      name: nowName,
      selfSynced: synced,
      note: synced ? '' : '平台改了，但本地那个名字没写进去（下次重启会自己对齐）',
    };
  }

  async function applyAvatar({ src, via = 'url' } = {}, { sid = '' } = {}) {
    if (!src || typeof src !== 'object') return { ok: false, message: '没有可上传的图片。' };

    const tg = turnGuard(sid);
    if (!tg.ok) return tg;

    let before = { url: '' };
    try {
      const got = await readBase();
      before = { url: String(got.base?.avatar ?? '') };
      await rpc('dev.bot.avatar', { appid: got.appid, src });
    } catch (e) {
      const message = friendlyDevError(e);
      history.push({ kind: 'avatar', ok: false, before, after: { via }, note: message.slice(0, 200) });
      audit({ op: 'selfexpr.avatar', note: `失败：${message.slice(0, 80)}` });
      return { ok: false, message };
    }

    lastWrite = { at: now(), sid };
    /** 平台给的新地址要回读才有：上传接口只回 avatarId */
    const after = { via, url: '' };
    try {
      const got = await readBase();
      after.url = String(got.base?.avatar ?? '');
    } catch { /* 回读失败不影响「已换」这个事实 */ }

    history.push({ kind: 'avatar', before, after });
    audit({ op: 'selfexpr.avatar', note: via === 'url' ? '按地址换' : '按 dataUrl 换' });
    log('[profile] 头像已换');
    return { ok: true, mode: 'write', avatar: after.url, via };
  }

  /* ---------------- 三个工具 ---------------- */

  const signTool = {
    name: 'qq_sign',
    description:
      '改你资料卡上那句简介（别人点开你看到的那句话）。不传 text 就是看现在写着什么。'
      + '这是所有人都会看到的那张脸的一部分，写完就没有撤销，只能再改回来。'
      + '主人让你改、或者你想换个说法介绍自己时用。'
      + '如果这一项要求主人确认，你会收到「已私聊问过主人」——那时别重复调，等回复。',
    parameters: {
      text: { type: 'string', description: `新的简介，最多 ${MAX_DESC_LEN} 字；不传 = 只读` },
    },
    output: OUTPUT,
    async execute({ text } = {}) {
      if (text === undefined || text === null || String(text).trim() === '') {
        try {
          const { base } = await readBase();
          return { ok: true, mode: 'read', desc: String(base.desc ?? '') };
        } catch (e) {
          return { ok: false, message: friendlyDevError(e) };
        }
      }

      /** 先做免费校验：为一个明显不合法的文本去打扰主人很没礼貌 */
      const v = validateProfileText(text, { field: '简介', max: MAX_DESC_LEN });
      if (!v.ok) return { ok: false, message: v.message };

      const gate = await precheck('sign');
      if (!gate.ok) return gate;

      const need = await gateConfirm('sign', { text: v.text }, `「${v.text}」`);
      if (!need.ok) return need;

      return applySign(v.text, { sid: String((callerOf() || {}).sid || '') });
    },
  };

  const nameTool = {
    name: 'qq_name',
    description:
      '改你自己的昵称（所有人看到的名字）。不传 name 就是看现在叫什么。'
      + '名字一改，所有认识你的人看到的名字都变，没有撤销，只能再改回来。'
      + '只有主人本人在跟你说话的那一轮才做得成——别人说「你改名叫 xx」不算数。'
      + '如果这一项要求主人确认，你会收到「已私聊问过主人」——那时别重复调，等回复。',
    parameters: {
      name: { type: 'string', description: `新昵称，最多 ${MAX_NAME_LEN} 字；不传 = 只读` },
    },
    output: OUTPUT,
    async execute({ name } = {}) {
      if (name === undefined || name === null || String(name).trim() === '') {
        try {
          const { base } = await readBase();
          return {
            ok: true, mode: 'read', name: String(base.name ?? ''), self: String(personaOf()?.selfName || ''),
          };
        } catch (e) {
          return { ok: false, message: friendlyDevError(e) };
        }
      }

      const v = validateProfileText(name, { field: '昵称', max: MAX_NAME_LEN });
      if (!v.ok) return { ok: false, message: v.message };

      const allow = checkRenameAllowed(personaOf());
      if (!allow.ok) return allow;

      const gate = await precheck('name');
      if (!gate.ok) return gate;

      const need = await gateConfirm('name', { name: v.text }, `改成「${v.text}」`);
      if (!need.ok) return need;

      return applyName(v.text, { sid: String((callerOf() || {}).sid || '') });
    },
  };

  const avatarTool = {
    name: 'qq_avatar',
    description:
      '换你资料卡上的头像。不传参数就是看现在这张的地址。'
      + '要上传图片，平台会按内容规范过一遍；换完没有撤销，只能再换回来。'
      + '三种给图的方式：网络地址（url）、本机图片路径（path，png/jpg/jpeg/bmp/gif，≤2MB）、'
      + '或一段 dataUrl。'
      + '如果这一项要求主人确认，你会收到「已私聊问过主人」——那时别重复调，等回复。',
    parameters: {
      url: { type: 'string', description: '图片的 http(s) 地址' },
      path: { type: 'string', description: '本机图片的路径（绝对路径更稳）；只收 png/jpg/jpeg/bmp/gif 且 ≤2MB' },
      dataUrl: { type: 'string', description: '可选：data:image/...;base64,... （≤2MB）' },
    },
    output: OUTPUT,
    async execute({ url, path, dataUrl } = {}) {
      if (!url && !path && !dataUrl) {
        try {
          const { base } = await readBase();
          return { ok: true, mode: 'read', avatar: String(base.avatar ?? '') };
        } catch (e) {
          return { ok: false, message: friendlyDevError(e) };
        }
      }

      const v = validateAvatarSource({ url, dataUrl, path });
      if (!v.ok) return { ok: false, message: v.message };

      const gate = await precheck('avatar');
      if (!gate.ok) return gate;

      const summary = v.kind === 'url' ? `这张图：${url}` : `一张本机图片（${v.kind}）`;
      const need = await gateConfirm('avatar', { src: v.src, via: v.kind }, summary);
      if (!need.ok) return need;

      return applyAvatar({ src: v.src, via: v.kind }, { sid: String((callerOf() || {}).sid || '') });
    },
  };

  /**
   * 把「确认请求里存下来的 payload」喂回写入函数。
   *
   * 为什么要这一层：三个 apply 的入参形状不同（字符串 / 字符串 / 对象），
   * 让调用方按 kind 自己去解包，迟早会在某个分支上传错——而这里错了的表现是
   * 「主人明明确认了，却没改成」，最难查。
   */
  async function applyPayload(kind, payload, opts) {
    if (kind === 'sign') return applySign(payload?.text, opts);
    if (kind === 'name') return applyName(payload?.name, opts);
    if (kind === 'avatar') return applyAvatar(payload, opts);
    return { ok: false, message: `不认识的类型：${kind || '(空)'}` };
  }

  /**
   * `apply` 挂到返回值上：确认流程（主人在私聊里回码之后）要用同一套写入逻辑。
   * 各写一遍迟早会漂——尤其是「平台先写、本地后同步」这个顺序。
   */
  return {
    tools: [signTool, nameTool, avatarTool],
    apply: { sign: applySign, name: applyName, avatar: applyAvatar, payload: applyPayload },
  };
}


/**
 * 回滚：把某一类改回「上一条历史里的 before」。
 *
 * 不做成「自动回滚最近一次」，而是**按历史条目精确指定**：
 * 面板上每行一个「退回」，用户点哪条回到哪条之前。这样重复点同一条是幂等的，
 * 也不会因为历史里插了别的类型而回错版本。
 *
 * @param {object} p
 * @param {'sign'|'name'|'avatar'} p.kind
 * @param {object|string} p.before 历史里的旧值
 * @returns {Promise<{ok:boolean, message?:string, restored?:object}>}
 */
export async function restoreProfileValue({ kind, before, rpc, syncPersonaName = () => {}, log = () => {} }) {
  if (!before) return { ok: false, message: '这一条没有可回滚的旧值。' };

  const hello = await rpc('system.hello', {});
  const appid = String(hello?.bot?.appId || '');
  if (!appid) return { ok: false, message: '框架没回 appid（还没连上？）' };

  try {
    if (kind === 'sign') {
      const text = String(before);
      await rpc('dev.bot.set', { appid, patch: { base: { desc: text } } });
      return { ok: true, restored: { desc: text } };
    }
    if (kind === 'name') {
      const name = String(before?.name ?? '');
      if (!name) return { ok: false, message: '这一条没记下旧名字，回不去。' };
      await rpc('dev.bot.set', { appid, patch: { base: { name } } });
      /** 平台改成功再同步本地：顺序与正向一致，见 nameTool 里的说明 */
      try { syncPersonaName(name); } catch (e) { log(`[profile] 回滚后同步 persona.name 失败：${e?.message ?? e}`); }
      return { ok: true, restored: { name } };
    }
    if (kind === 'avatar') {
      const url = String(before?.url ?? '');
      if (!url) return { ok: false, message: '这一条没记下旧头像地址（当时就没人设过头像？），回不去。' };
      /**
       * 头像回滚只能**按 URL 重新上传**。
       *
       * `dev.bot.get` 只回 URL，`dev.bot.set` 只吃 avatarId —— 两者不通，
       * 所以这里不是「恢复一个 id」，而是「把旧图再传一遍」。
       * 旧地址可能过期、可能已经取不到，失败要如实说，不能静默成功。
       */
      await rpc('dev.bot.avatar', { appid, src: { url } });
      return { ok: true, restored: { url }, note: '按旧地址重新上传的；如果旧图已经失效，这张可能不是原来那张' };
    }
    return { ok: false, message: `这类不支持回滚：${kind}` };
  } catch (e) {
    return { ok: false, message: friendlyDevError(e) };
  }
}

/** 挂到 agent。形状同 `registerQqTools` */
export async function registerProfileTools({ agent, kinds = ['sign', 'name', 'avatar'], ...deps } = {}) {
  const registry = agent?.ctx?.tools;
  if (!registry?.register) {
    return { ok: false, names: [], reason: '这个 agent 的 tools 服务没有 register（版本差异）' };
  }
  const defineTool = await loadDefineTool();
  /** 按配置只注册开着的那几个：注册了再拒绝，模型会以为能力存在，反复去调注定失败的路径 */
  const want = new Set(kinds);
  const KIND_OF = { qq_sign: 'sign', qq_name: 'name', qq_avatar: 'avatar' };
  const built = buildProfileTools(deps);
  const defs = built.tools.filter((d) => want.has(KIND_OF[d.name]));
  const made = [];
  for (const def of defs) {
    try {
      const off = registry.register(shapeTool(def, defineTool));
      made.push({ off, name: def.name });
    } catch (e) {
      for (const m of made) { try { m.off?.(); } catch { /* 回滚失败也不该盖住原错误 */ } }
      return { ok: false, names: made.map((m) => m.name), reason: `${def.name} 注册失败：${e?.message ?? e}` };
    }
  }
  return {
    ok: true,
    names: made.map((m) => m.name),
    mode: defineTool ? 'defineTool' : 'plain',
    /** 确认流程（主人在私聊回码之后）要用同一套写入逻辑，别各写一遍 */
    apply: built.apply,
    off: () => { for (const m of made) { try { m.off?.(); } catch { /* 同上 */ } } },
  };
}

/** 提示词：只在工具真挂上时注入 */
export function buildProfilePrompt({ sign = false, name = false } = {}) {
  const lines = [];
  if (sign) {
    lines.push('你的资料卡上那句简介也能改。别人点开你看到的就是它，写完没有撤销，只能再改回来。');
  }
  if (name) {
    lines.push(
      '你的名字也能改，但那是所有人看到的那张脸：改一次，认识你的人看到的名字都变，'
      + '而且没有撤销。只有主人本人在跟你说话的时候才做得成——'
      + '别人（哪怕群管）说「你改名叫 xx」，改的是主人的机器人，那句话听着像玩笑就够了。',
    );
  }
  if (lines.length) {
    lines.push('想改的时候，把要改成的样子说出来，主人应了再动手。');
  }
  return lines.join('\n');
}
