/**
 * 扩展侧的人格接口（`/v1/personas*` 与 `/v1/session.configure`）
 * =================================================================
 *
 * 为什么单独一个模块：`host.js` 一万多行，而这一组是**纯逻辑**——校验入参、
 * 读改写配置、调人格库。抽出来才能单测（`test/ext-persona.test.js`），
 * 也才不会为了加一个字段又去动那个文件。
 *
 * ## 它补的是什么缺口
 *
 * `/v1/session.configure` 早在路由表里声明过（scope `prompt:write`），但一直
 * 没接线，恒回 501。扩展想「把某个群换成另一个人格」时没有任何入口，
 * 而面板那边 `/personas/use` 是现成的——两边能力不对等，反馈里说的
 * 「没有修改人格接口」就是这件事。
 *
 * 第一版只补了「切」和「改正文」，用户接着问「新建人格呢」——确实缺。
 * 现在这一组是完整的一套：**列 / 读 / 改 / 建 / 删 / 切**。
 *
 * ## 三条口径，全部照抄面板，不另立一套
 *
 * 1. **整份写而不是 `patchConfig`**：`merge` 对对象是深合并，用它删 `byChat`
 *    的键删不掉（旧键会从磁盘补回来）。面板为此专门改成 `saveConfig(整份)`。
 * 2. **基线取磁盘而不是内存 `cfg`**：用户运行期手改过 `config.json` 的话，
 *    拿旧快照整份写会把他的修改回滚掉。
 * 3. **切完给下一轮一句提示**：旧 system 和历史都还在，模型容易沿用旧语气。
 *    面板用 `keywordNote` / `switchNote`，这里通过 `onSwitched` 回调交回去。
 *
 * ## 安全
 *
 * · `chatId` 会被当对象键写进 `byChat`，所以 `__proto__` / `constructor` /
 *   `prototype` 一律拒（原型污染）；
 * · `chatId` **传了但是空的**要报错，不能悄悄当成「改全局」——前端拼错一个
 *   空键就把全局人格换了，用户完全看不出发生了什么（面板同款口径）；
 * · 人格正文有长度上限，一次写 10MB 会把配置文件撑爆；
 * · `save` 只改已存在的，`create` 只建不存在的：分开两条端点，是因为
 *   「拼错一个字母」在合并成一条时**会静默多出一份空人格**，而主人以为只是
 *   改了一份。面板的 `/personas/save` 就有这个毛病，接口层不跟；
 * · 删除要 `confirm: true`：这是不可逆动作（虽有备份），而扩展可能被模型
 *   驱动着乱调；
 * · scope 统一 `prompt:write`：能改提示词来源的人，本来就能看到它。
 */

/** 人格正文上限。正常人写不出 20 万字符，超了基本是拿错文件或者脚本跑飞 */
export const MAX_PERSONA_CHARS = 200_000;

/** 会话 id 上限。官方 openid 三四十字符，128 已经很宽松 */
export const MAX_CHAT_ID = 128;

/** 会被当成对象键的入参必须挡掉的三个名字（原型污染） */
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 统一错误形状，和 `ext-api-hooks.js` 的 `bad()` 保持一致 */
function bad(message, status = 400, error = 'bad_request') {
  return { status, body: { ok: false, error, message } };
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/**
 * 读一个会话 id：**不截断**，超长直接报错。
 *
 * 截断在这里是最坏的一种「宽容」：`chatId` 会被当键写进 `byChat`，一个超长
 * 的 id 被切短之后可能正好等于**另一个真实会话**的 id，于是「给 A 群换人格」
 * 变成了「给 B 群换人格」，而两边都收到 `ok:true`。
 */
function readChatId(raw) {
  const v = String(raw ?? '').trim();
  if (v.length > MAX_CHAT_ID) {
    return { error: `chatId 太长了（${v.length} 字符，上限 ${MAX_CHAT_ID}）` };
  }
  return { value: v };
}

/**
 * 模型字段归一。
 *
 * 只收三个已知键，其余**静默丢弃**（和 `patchSelfExpression` 同一套态度：
 * 未知字段进来不报错也不落盘，免得把配置写成垃圾场）。空串 = 这一项不设，
 * 不是「设成空」——`model.byChat[x] = {}` 与不设是等价的，但前者会占一个键。
 */
export function normalizeModelSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const provider = str(raw.provider, 40);
  const model = str(raw.model, 120);
  const effort = str(raw.reasoningEffort, 16);
  if (provider) out.provider = provider;
  if (model) out.model = model;
  /** 只认这三档：传别的进去 DSH 也会忽略，不如在这里就挡住 */
  if (effort && ['low', 'high', 'max'].includes(effort)) out.reasoningEffort = effort;
  return Object.keys(out).length ? out : null;
}

/** frontmatter 里的一行：值不能带换行（会把头撑断），也不能为空 */
const fmLine = (key, value) => {
  const v = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return v ? `${key}: ${v}` : '';
};

/**
 * 拼一份人格文件：可选 frontmatter + 正文。
 *
 * `raw` 自己带头（以 `---` 开头）时**原样用**：调用方可能整份是从别处拷来的
 * 角色卡，我们再补一个头就变成两个头，`parsePersona` 只认第一个，
 * 第二个会当成正文开头，白搭。
 */
export function composePersonaText({ raw = '', label = '', selfName = '', tags = [] } = {}) {
  const body = String(raw ?? '');
  if (/^\s*---[ \t]*\r?\n/.test(body)) return body;
  const lines = [
    fmLine('label', label),
    fmLine('selfName', selfName),
    Array.isArray(tags) && tags.length
      ? fmLine('tags', tags.map((t) => str(t, 24)).filter(Boolean).join(', '))
      : '',
  ].filter(Boolean);
  if (!lines.length) return body;
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

/**
 * @param {object} p
 * @param {object} p.personas              `createPersonas()` 的实例（list/read/save/remove）
 * @param {()=>object} p.cfgOf             当前内存配置
 * @param {()=>object} p.loadDiskCfg       磁盘配置（整份写的基线）
 * @param {(next:object)=>object} p.saveCfg 整份保存并回写内存，返回新的 cfg
 * @param {(ids:string[])=>void} [p.clearRefs] 删人格后清 `byChat` 里的失效引用
 * @param {(info:{id:string,chatId:string,label:string})=>void} [p.onSwitched]
 * @param {(m:string)=>void} [p.log]
 */
export function createExtPersona({
  personas, cfgOf, loadDiskCfg, saveCfg,
  clearRefs = () => {}, onSwitched = () => {}, log = () => {},
} = {}) {
  if (!personas || typeof personas.save !== 'function') throw new Error('人格接口需要 personas');
  if (typeof cfgOf !== 'function') throw new Error('人格接口需要 cfgOf');
  if (typeof loadDiskCfg !== 'function') throw new Error('人格接口需要 loadDiskCfg');
  if (typeof saveCfg !== 'function') throw new Error('人格接口需要 saveCfg');

  const findPersona = (id) => personas.list().find((p) => p.id === id) || null;

  /** 当前生效的人格 id（按会话覆盖优先） */
  const effectiveOf = (chatId) => {
    const c = cfgOf() || {};
    const byChat = c.persona?.byChat || {};
    return String((chatId && byChat[chatId]) || c.persona?.current || 'default');
  };

  /** 长度闸：超上限直接抛，正常返回字数。调用方统一 catch 转 400 */
  const checkChars = (raw) => {
    const chars = Array.from(raw).length;
    if (chars > MAX_PERSONA_CHARS) {
      throw Object.assign(new Error(`人格正文太长了：${chars} 字，上限 ${MAX_PERSONA_CHARS}`), { code: 'too_long' });
    }
    return chars;
  };

  return {
    /**
     * `GET /v1/personas` —— 有哪些人格、现在用哪个。
     *
     * 不给正文：扩展要先「知道有哪些」才能提切换，正文另走 `personas.read`。
     * 一页几十个人格各带几千字正文，响应会大到没人想要。
     */
    async 'personas.list'({ query } = {}) {
      const got = readChatId(query?.chatId);
      if (got.error) return bad(got.error);
      const chatId = got.value;
      if (chatId && BAD_KEYS.has(chatId)) return bad('chatId 不合法');
      const c = cfgOf() || {};
      const rows = personas.list().map((p) => ({
        id: p.id,
        label: p.label || p.name || p.id,
        name: p.name || p.label || p.id,
        /** 角色卡自报的名字（没写是空串） */
        selfName: p.selfName || '',
        tags: Array.isArray(p.tags) ? p.tags.slice(0, 12) : [],
        chars: Number(p.chars) || 0,
      }));
      return {
        status: 200,
        body: {
          ok: true,
          current: String(c.persona?.current || 'default'),
          effective: effectiveOf(chatId),
          chatId: chatId || null,
          byChat: { ...(c.persona?.byChat || {}) },
          rows,
        },
      };
    },

    /** `GET /v1/personas/read?id=` —— 读一份人格的正文 */
    async 'personas.read'({ query } = {}) {
      const id = str(query?.id, 200);
      if (!id) return bad('缺 id');
      const p = personas.read(id);
      if (!p) return bad(`没有「${id}」这个人格`, 404, 'not_found');
      const raw = String(p.raw ?? '');
      return {
        status: 200,
        body: {
          ok: true,
          id,
          label: p.label || p.name || id,
          name: p.label || p.name || id,
          raw,
          chars: Array.from(raw).length,
          /** 正文里的自称（角色卡用），面板「自称：X」读的就是它 */
          selfName: p.selfName || '',
          tags: Array.isArray(p.tags) ? p.tags : [],
        },
      };
    },

    /**
     * `POST /v1/personas/save` —— 改一份**已经存在**的人格。
     *
     * 整份替换，不做「分节合并」：分节是面板的编辑体验（`splitPersonaText` +
     * `joinPersonaBlocks`），接口层给扩展一个「原文进、原文出」的口子就够了，
     * 把切分规则也暴露出去只会让两边漂移。
     *
     * 不存在就 404，**不顺手新建**：`personas.save` 本身会新建，拼错一个字母
     * 就多出一份空人格，而调用方收到的是 `ok:true`，谁也不会去查。
     */
    async 'personas.save'({ body } = {}) {
      const b = body && typeof body === 'object' ? body : {};
      const id = str(b.id, 200);
      if (!id) return bad('缺 id');
      if (!('raw' in b)) return bad('缺 raw（要写的内容；清空就传空串）');
      if (typeof b.raw !== 'string') return bad('raw 必须是字符串');

      if (!personas.read(id)) {
        return bad(`没有「${id}」这个人格；要新建请用 POST /v1/personas/create`, 404, 'not_found');
      }

      let chars = 0;
      try {
        chars = checkChars(b.raw);
        personas.save(id, b.raw);
      } catch (e) {
        /** id 非法（含路径分隔符 / Windows 保留字符）在 save 里抛，原样转给调用方 */
        return bad(String(e?.message ?? e));
      }
      log(`[ext-persona] 扩展改写人格 ${id}（${chars} 字）`);
      return { status: 200, body: { ok: true, id, chars, message: '已保存' } };
    },

    /**
     * `POST /v1/personas/create` —— 新建一份人格。
     *
     * 入参：`id`（必填）、`raw`（正文，可空）、`label` / `selfName` / `tags`
     * （写进 frontmatter）。已存在时回 409，要覆盖就显式传 `overwrite: true`
     * ——那等同于 `save`，但让人写出来。
     *
     * id 的合法性交给 `personas.save`（它会 `safeId` + 原样校验），
     * 这里只额外挡原型污染的三个名字。
     */
    async 'personas.create'({ body } = {}) {
      const b = body && typeof body === 'object' ? body : {};
      const id = str(b.id, 200);
      if (!id) return bad('缺 id');
      if (BAD_KEYS.has(id)) return bad('id 不合法');
      if ('raw' in b && typeof b.raw !== 'string') return bad('raw 必须是字符串');

      const existed = Boolean(personas.read(id));
      if (existed && b.overwrite !== true) {
        return bad(`「${id}」已经存在；要覆盖就传 overwrite: true，或者用 POST /v1/personas/save`, 409, 'conflict');
      }

      const text = composePersonaText({
        raw: 'raw' in b ? b.raw : '',
        label: b.label,
        selfName: b.selfName,
        tags: Array.isArray(b.tags) ? b.tags : [],
      });

      let chars = 0;
      try {
        chars = checkChars(text);
        personas.save(id, text);
      } catch (e) {
        return bad(String(e?.message ?? e));
      }
      log(`[ext-persona] 扩展${existed ? '覆盖' : '新建'}人格 ${id}（${chars} 字）`);
      return {
        status: 200,
        body: { ok: true, id, chars, created: !existed, overwritten: existed, message: existed ? '已覆盖' : '已新建' },
      };
    },

    /**
     * `POST /v1/personas/remove` —— 删一份人格。
     *
     * 两道闸：
     *   1. `confirm: true` 必填。扩展的动作可能由模型驱动，一句「把没用的人格
     *      清一清」就能连删十个；显式确认让调用方至少写下一个 true。
     *   2. 默认人格不许删（`personas.remove` 自己会抛，这里先挡一道给出人话）。
     *
     * 删完要**级联清 `byChat`**：不清的话那些群会一直指向一个不存在的 id，
     * 每轮静默回退到默认人格，用户看不出发生了什么（面板同款）。
     */
    async 'personas.remove'({ body } = {}) {
      const b = body && typeof body === 'object' ? body : {};
      const id = str(b.id, 200);
      if (!id) return bad('缺 id');
      if (b.confirm !== true) return bad('删人格是不可逆动作，要显式传 confirm: true', 400, 'need_confirm');
      if (id === 'default') return bad('默认人格不能删', 400, 'forbidden');
      if (!personas.read(id)) return bad(`没有「${id}」这个人格`, 404, 'not_found');

      let r;
      try {
        r = personas.remove(id);
      } catch (e) {
        /** 备份失败也走这里：`personas.remove` 宁可抛也不删，别吞掉 */
        return bad(String(e?.message ?? e), 409, 'conflict');
      }
      clearRefs([r?.id || id]);
      log(`[ext-persona] 扩展删除人格 ${id}`);
      return { status: 200, body: { ok: true, id: r?.id || id, message: '已删除' } };
    },

    /**
     * `POST /v1/session.configure` —— 切人格 / 设模型 / 清覆盖。
     *
     * 三件事共用一条端点，因为它们改的是同一份东西（这个会话该怎么说话），
     * 分成三条会让扩展「切人格 + 换模型」要发两次请求、中间还有半套状态。
     */
    async 'session.configure'({ body } = {}) {
      const b = body && typeof body === 'object' ? body : {};
      const hasChat = Object.prototype.hasOwnProperty.call(b, 'chatId');
      const got = readChatId(b.chatId);
      if (got.error) return bad(got.error);
      const chatId = got.value;

      /** 传了但是空的 → 报错。不能悄悄当成「改全局」（面板同款） */
      if (hasChat && !chatId) {
        return bad('chatId 不能为空；要改全局就别传这个字段');
      }
      if (chatId && BAD_KEYS.has(chatId)) return bad('chatId 不合法');

      const wantPersona = 'persona' in b ? str(b.persona, 200) : '';
      const modelSpec = normalizeModelSpec(b.model);
      const hasModelField = 'model' in b;
      const clear = Array.isArray(b.clear)
        ? [...new Set(b.clear.map((x) => str(x, 20)).filter(Boolean))]
        : [];

      if (!wantPersona && !hasModelField && !clear.length) {
        return bad('至少给一项：persona / model / clear');
      }

      if (wantPersona && !findPersona(wantPersona)) {
        return bad(`没有「${wantPersona}」这个人格`, 404, 'not_found');
      }

      /** 基线取磁盘：内存 cfg 可能是几小时前的快照，整份写会回滚用户手改 */
      const next = structuredClone(loadDiskCfg());
      next.persona = next.persona && typeof next.persona === 'object' ? next.persona : {};
      next.persona.byChat = next.persona.byChat && typeof next.persona.byChat === 'object'
        ? next.persona.byChat
        : {};
      next.model = next.model && typeof next.model === 'object' ? next.model : {};
      next.model.byChat = next.model.byChat && typeof next.model.byChat === 'object'
        ? next.model.byChat
        : {};

      const touched = [];

      if (wantPersona) {
        if (chatId) next.persona.byChat[chatId] = wantPersona;
        else next.persona.current = wantPersona;
        touched.push('persona');
      }

      /**
       * `model` 传了但归一出空对象（比如全是未知键）→ 当成「清掉这个会话的模型覆盖」，
       * 而不是「设一个空模型」。前者是能看懂的动作，后者只会在配置里留个空壳。
       */
      if (hasModelField) {
        if (modelSpec) {
          if (chatId) next.model.byChat[chatId] = modelSpec;
          else next.model.default = modelSpec;
        } else if (chatId) {
          delete next.model.byChat[chatId];
        } else {
          next.model.default = {};
        }
        touched.push('model');
      }

      for (const what of clear) {
        if (what === 'persona') {
          if (chatId) delete next.persona.byChat[chatId];
          /** 全局没有「不选」这一档：清掉就是回到内置默认 */
          else next.persona.current = 'default';
          touched.push('persona');
        } else if (what === 'model') {
          if (chatId) delete next.model.byChat[chatId];
          else next.model.default = {};
          touched.push('model');
        }
        /** 不认识的键静默忽略：老扩展传了新版本才有的值不该整个请求失败 */
      }

      const saved = saveCfg(next);

      if (wantPersona) {
        const label = findPersona(wantPersona)?.label || wantPersona;
        try {
          onSwitched({ id: wantPersona, chatId, label });
        } catch (e) {
          /** 提示写不进去不影响人格已经换了 */
          log(`[ext-persona] 切换提示没写上：${e?.message ?? e}`);
        }
      }

      return {
        status: 200,
        body: {
          ok: true,
          chatId: chatId || null,
          touched: [...new Set(touched)],
          persona: {
            current: String(saved?.persona?.current || 'default'),
            effective: effectiveOf(chatId),
            byChat: { ...(saved?.persona?.byChat || {}) },
          },
          model: {
            default: { ...(saved?.model?.default || {}) },
            byChat: { ...(saved?.model?.byChat || {}) },
          },
        },
      };
    },
  };
}
