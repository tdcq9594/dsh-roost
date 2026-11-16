/**
 * 扩展侧的配置读写（`/v1/config`）
 * ================================
 *
 * ## 它补的是什么缺口
 *
 * 人格补完之后，用户接着问「其他功能有没有类似问题，比如设置我们的配置项」。
 * 一查确实是同一类缺口：面板有 `/config`（GET 读、POST 写），`/v1` 一条都没有。
 * 扩展想「把记忆注入条数调小」「把主动发言关掉」只能干看着。
 *
 * ## 为什么不在这个文件里自己写一份保存逻辑
 *
 * 面板那条 `/config` POST 里有 100 行副作用：`__revision` 冲突检测、密钥掩码
 * 回填、端口校验、保存后按需重启监听、外接协议重连、换人格时补一句提示。
 * 在扩展这边重写一遍必然漂移（历史上「面板改了、扩展没改」已经出过事）。
 * 所以宿主把那段抽成 `applyConfigBody()`，面板与 `/v1/config` **调同一个函数**，
 * 这里只负责「校验扩展能碰什么」这一层。
 *
 * ## 边界：能改什么、不能改什么
 *
 * 全放开（2026-11-14 口径）不等于把钥匙串整个递出去。下面这张表是**结构性**
 * 收窄，不依赖主人有没有看懂风险提示——因为这几项一旦被写，扩展就能反过来
 * 控制「主人能不能管住它」：
 *
 *   · `server`      面板密钥与端口：写掉 token 等于把主人锁在面板外；
 *   · `roostHost`   外接协议地址与令牌：改掉就能把消息导去别处；
 *   · `permissions` 工具权限策略：改掉就是自己给自己提权；
 *   · `security`    安全开关（`dangerousConfirm` / SSRF 白名单）：绕过「危险操作要确认」；
 *   · `extensions`  扩展总开关：自己给自己开门；
 *   · `update`      升级源：能让宿主装上一个「官方」的包；
 *   · `persona` / `model`  有专属端点 `/v1/session.configure`，走那边才会补
 *                    「说话方式刚换了」的提示，从配置口改会静默失效。
 *
 * 其余（`memory` / `chat` / `speakUp` / `quota` / `tts` / `selfExpression` …）
 * 都是行为参数，允许改。**只允许局部合并**：整份替换会让扩展一个手滑就把
 * 几十项配置抹成默认值，而它根本不知道那些项存在。
 *
 * ## 密钥
 *
 * 读回的是 `publicConfig()` 的结果——`apiKey` / `token` 一律 `******`。
 * 写的时候如果原样把 `******` 提交回来，`saveConfig` 会回填成磁盘真值
 * （`restoreMaskedSecrets`），所以「读出来改一项再写回去」不会把密钥冲掉。
 */

/** 不允许扩展通过配置口改的顶层键 → 人话原因 */
export const CONFIG_DENY = Object.freeze({
  server: '面板密钥与端口（写掉 token 等于把主人锁在面板外）',
  roostHost: '外接协议地址与令牌（改掉就能把消息导去别处）',
  permissions: '工具权限策略（改掉等于给自己提权）',
  security: '安全开关（会绕过「危险操作要确认」）',
  extensions: '扩展总开关',
  update: '升级源',
  persona: '人格选择请用 POST /v1/session.configure',
  model: '模型选择请用 POST /v1/session.configure',
});

/** 一次最多投影多少个配置项（`config.read?keys=`） */
export const MAX_READ_KEYS = 64;

/** 会被当成对象键的入参必须挡掉的三个名字（原型污染） */
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function bad(message, status = 400, error = 'bad_request') {
  return { status, body: { ok: false, error, message } };
}

const isPlain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/**
 * 点号路径取值；中途不是对象就当没有。
 *
 * 用 `hasOwnProperty` 而不是 `k in node`：`'__proto__' in {}` 是 `true`，
 * 用 `in` 的话 `?keys=constructor` 能把 `Object` 的构造函数原样读出来。
 */
function getAt(root, path) {
  let node = root;
  for (const k of String(path).split('.')) {
    if (!isPlain(node) || !Object.prototype.hasOwnProperty.call(node, k)) return undefined;
    node = node[k];
  }
  return node;
}

/**
 * 深比较，收集所有变化路径（点号）。
 *
 * 为什么要它：`saveConfig` 会把 `DEFAULTS` 之外的键**静默裁掉**，于是扩展
 * 写了个拼错的键名，收到的是 `ok:true`，配置一个字没变——这种「成功但没生效」
 * 是最难查的一类问题。把真实变化回给调用方，它自己就能发现。
 */
export function diffPaths(before, after, prefix = '', out = []) {
  const keys = new Set([...Object.keys(isPlain(before) ? before : {}), ...Object.keys(isPlain(after) ? after : {})]);
  for (const k of keys) {
    const p = prefix ? `${prefix}.${k}` : k;
    const a = isPlain(before) ? before[k] : undefined;
    const b = isPlain(after) ? after[k] : undefined;
    if (isPlain(a) && isPlain(b)) { diffPaths(a, b, p, out); continue; }
    /** 数组 / 标量 / 类型变了：整体比，不展开（数组按下标展开只会刷屏） */
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(p);
  }
  return out;
}

/**
 * 递归挡原型污染的三个键。
 *
 * `merge()` 用的是 `Object.entries` + 赋值，`out['__proto__'] = {...}` 会改
 * 目标对象的原型。虽然 `saveConfig` 的 DEFAULTS 裁剪能兜住大部分，但那是
 * 「碰巧兜住」，不该指望。
 */
function findBadKeys(node, prefix = '') {
  if (!isPlain(node)) return [];
  const hits = [];
  for (const k of Object.keys(node)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (BAD_KEYS.has(k)) { hits.push(p); continue; }
    hits.push(...findBadKeys(node[k], p));
  }
  return hits;
}

/**
 * @param {object} p
 * @param {()=>({config:object, revision:string})} p.readConfig 打码后的配置 + 版本号
 * @param {(patch:object, opts:{mode:string, source:string})=>({status:number, body:object})} p.applyPatch
 *        面板 `/config` POST 的同一份实现（宿主注入 `applyConfigBody`）
 * @param {(m:string)=>void} [p.log]
 */
export function createExtConfigHooks({ readConfig, applyPatch, log = () => {} } = {}) {
  if (typeof readConfig !== 'function') throw new Error('配置接口需要 readConfig');
  if (typeof applyPatch !== 'function') throw new Error('配置接口需要 applyPatch');

  return {
    /**
     * `GET /v1/config` —— 读配置（密钥已打码）。
     *
     * `?keys=memory.injectCount,chat.typing` 只取这几项：整份配置有几十 KB，
     * 扩展多数时候只想知道一两个值。给投影比让它自己 `JSON.parse` 整坨好。
     */
    async 'config.read'({ query } = {}) {
      const keys = str(query?.keys, 2000);
      const snap = readConfig() || {};
      const config = snap.config ?? {};
      const revision = String(snap.revision ?? '');

      if (!keys) return { status: 200, body: { ok: true, config, revision } };

      const want = [...new Set(keys.split(',').map((s) => s.trim()).filter(Boolean))];
      if (want.length > MAX_READ_KEYS) {
        return bad(`一次最多取 ${MAX_READ_KEYS} 项，收到 ${want.length} 项`);
      }
      const values = {};
      const missing = [];
      for (const p of want) {
        /** 路径里任何一段是 `__proto__` 之类，一律当「没有」——不给探原型的口子 */
        if (p.split('.').some((seg) => BAD_KEYS.has(seg))) { missing.push(p); continue; }
        const v = getAt(config, p);
        if (v === undefined) missing.push(p);
        else values[p] = v;
      }
      return { status: 200, body: { ok: true, values, missing, revision } };
    },

    /**
     * `POST /v1/config` —— 改配置（**只做局部合并**）。
     *
     * 入参 `{ patch: { … } }`。`patch` 会被深合并进磁盘配置，没提到的键不动。
     * 响应里的 `changed` 是**真实发生变化的路径**——空数组就说明这次提交
     * 什么都没改（多半是键名写错了，`DEFAULTS` 之外的键会被裁掉）。
     */
    async 'config.patch'({ body } = {}) {
      const b = isPlain(body) ? body : {};

      /** 整份替换一律不给：扩展不知道配置里有哪些项，抹成默认值也看不出来 */
      if (b.mode === 'full') {
        return bad('扩展不能整份替换配置，只能传 patch 做局部合并');
      }

      const patch = b.patch;
      if (!isPlain(patch)) {
        return bad('缺 patch；请求体形如 { "patch": { "memory": { "injectCount": 8 } } }');
      }
      if (!Object.keys(patch).length) return bad('patch 是空的，没有要改的东西');

      const polluted = findBadKeys(patch);
      if (polluted.length) return bad(`patch 里有不合法的键名：${polluted.join('、')}`);

      const denied = Object.keys(patch).filter((k) => k in CONFIG_DENY);
      if (denied.length) {
        const why = denied.map((k) => `\`${k}\`（${CONFIG_DENY[k]}）`).join('；');
        return bad(`这些配置项不开放给扩展：${why}`, 403, 'forbidden');
      }

      /**
       * 乐观并发：传了 `revision` 就带上，`applyConfigBody` 发现磁盘已经变了
       * 会回 409，扩展重新读一遍再改。不传就是「以我的为准」（后写覆盖）。
       */
      const want = b.revision == null ? '' : String(b.revision);
      if (want) patch.__revision = want;

      /** 前后各取一份打码快照做 diff。打码不影响「变没变」的判断 */
      const before = readConfig()?.config ?? {};
      const out = applyPatch(structuredClone(patch), { mode: 'patch', source: 'ext' });

      /** applyPatch 失败时原样透传（400 参数错 / 409 冲突），不要吞成 200 */
      if (Number(out?.status) !== 200) return out;

      const after = out?.body?.config ?? {};
      const changed = diffPaths(before, after);
      /**
       * 200 的回执里**不带整份 config**：那份有几十 KB，而调用方刚提交完 patch，
       * 想知道的是「哪几项真的变了」。要整份再发一次 `GET /v1/config` 就行。
       * （409 冲突那条仍然带 `config`——那时候调用方最需要看到现状。）
       */
      const { config: _snapshot, ...rest } = out.body;
      const payload = {
        ...rest,
        changed,
        /** 空 = 一个字都没变，调用方该去看键名了 */
        ...(changed.length ? {} : {
          note: '配置没有变化：`DEFAULTS` 之外的键会被裁掉，检查一下键名拼写',
        }),
      };
      log(`[ext-config] 扩展改配置：${changed.join(', ') || '（无变化）'}`);
      return { status: 200, body: payload };
    },
  };
}
