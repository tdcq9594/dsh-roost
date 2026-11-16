/**
 * 扩展侧的「会改变什么」一组：自我表达提议 / 群管 / 语音合成
 * ============================================================
 *
 * 和 `ext-observe.js` 的分界：那一组只读，这一组每个都会**留下痕迹**。
 * 所以每个都带一道自己的闸，而不是只靠 scope：
 *
 *   · `POST /v1/self/propose`  只能**提议**，不能直接改——真正写下去要主人
 *                              在 QQ 里点确认按钮（`profile-confirm.js`）。
 *                              扩展是「别人写的代码 + 可能被模型驱动」，
 *                              改她的对外形象不该由它单方面决定。
 *   · `POST /v1/group/mute`    要 `confirm: true`（禁言是不可撤销的社交动作）
 *   · `POST /v1/group/kick`    要 `confirm: true`（踢人 + 可选拉黑）
 *   · `POST /v1/tts`           只合成**不发送**：返回音频字节，发不发、发到哪
 *                              由调用方自己决定（它还要走 `/v1/send`）
 *
 * ## 为什么群管要新开 `group:write`
 *
 * 复用 `message:write` 是错的：那条是「以机器人身份发消息」，装上就给了。
 * 踢人和禁言是**管理他人**，跟发消息不是一回事，必须单独声明、单独点头。
 * 复用 `core:write` 也不对：那个是「接管程序内置功能」。
 *
 * ## 为什么不给 `/group/join`
 *
 * 审批入群申请本质是「替主人决定谁能进群」。踢人 / 禁言至少是**减法**，
 * 错了还能重来；放人进来之后要再踢出去，代价大得多。这条留给面板。
 */

import {
  validateProfileText, validateAvatarSource, checkRenameAllowed, MAX_NAME_LEN, MAX_DESC_LEN,
} from './profile-tool.js';
import { runPreview, PREVIEW_TEXT_LIMIT } from './tts-preview.js';

/** 群管一次最多动几个人：再多应该分批，免得一口气把半个群踢了 */
export const MAX_GROUP_TARGETS = 10;
/** 禁言最长多久（秒）：30 天。官方上限更长，但「先关一个月」已经够重了 */
export const MAX_MUTE_SECONDS = 30 * 24 * 3600;
/** 头像地址上限：官方 CDN 的 URL 一两百字符，2000 已经非常宽松 */
export const MAX_AVATAR_URL = 2000;
/** 群 id 上限。官方 openid 三四十字符 */
export const MAX_GROUP_ID = 200;

const SELF_KINDS = ['name', 'sign', 'avatar'];

function bad(message, status = 400, error = 'bad_request') {
  return { status, body: { ok: false, error, message } };
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/**
 * 读群 id：**不截断**，超长直接报错。
 * 截断后的 id 可能正好等于另一个真实群，于是「禁言 A 群的人」变成「禁言 B 群」。
 */
function readGroupId(raw) {
  const v = String(raw ?? '').trim();
  if (v.length > MAX_GROUP_ID) {
    return { error: `groupId 太长了（${v.length} 字符，上限 ${MAX_GROUP_ID}）` };
  }
  return { value: v };
}

/**
 * 读 `targets`：**不截断**，异常长度直接报错。
 *
 * `slice` 会按 UTF-16 码元切，一个长 openid 被切短之后 `groupAdmin` 会拿它
 * 去匹配一个不存在的人——`mute` 的返回是「没有这个人」，看起来像「这个人
 * 不在群里」，实际是我们把参数改坏了。宁可显式拒绝。
 */
function readTargets(raw) {
  if (!Array.isArray(raw)) return { list: [], error: '' };
  const list = raw.map((x) => String(x ?? '').trim()).filter(Boolean);
  const bad = list.find((t) => t.length > 200);
  if (bad) return { list: [], error: `targets 里有异常的 openid（${bad.length} 字符，上限 200）` };
  return { list, error: '' };
}

/**
 * @param {object} p
 * @param {(req:{kind:string,payload:object,summary:string})=>Promise<{ok:boolean,reused?:boolean,message?:string}>} p.ask
 *        主人确认通道（`profileConfirm.ask`）
 * @param {()=>object} p.groupAdminOf
 * @param {()=>object} p.ttsOf
 * @param {()=>{rpc:Function}} p.roostOf
 * @param {()=>object} p.cfgOf
 * @param {()=>object} [p.personaOf]  当前生效的人格（判断 selfName 是否写死）
 * @param {(m:string)=>void} [p.log]
 */
export function createExtAct({
  ask, groupAdminOf, ttsOf, roostOf, cfgOf, personaOf = null, log = () => {},
} = {}) {
  if (typeof ask !== 'function') throw new Error('动作接口需要 ask（主人确认通道）');
  if (typeof groupAdminOf !== 'function') throw new Error('动作接口需要 groupAdminOf');
  if (typeof ttsOf !== 'function') throw new Error('动作接口需要 ttsOf');

  return {
    /**
     * `POST /v1/self/propose` —— 提议改她的名字 / 签名 / 头像。
     *
     * 入参 `{ kind: 'name'|'sign'|'avatar', value }`。
     * 响应 `{ ok:true, pending:true }` 表示**已经发给主人了**，不是「已改」。
     * 主人点「确认改」之后才真的写下去，回执发到主人私聊。
     *
     * 头像只收 http(s) 地址（和面板手动改一致）：本机路径那种事应该由她自己
     * 用工具做——那条路会过 `readImageAsDataUrl` 的越界检查，这里没有。
     */
    async 'self.propose'({ body } = {}) {
      const b = body && typeof body === 'object' ? body : {};
      const kind = str(b.kind, 16);
      /**
       * **不在这里 `slice`**：`String.prototype.slice` 按 UTF-16 码元切，
       * 一串 emoji 会被切成半个代理对，然后 `validateProfileText` 数出来的
       * 长度变短、校验通过——表现是「提交了 600 字，存进去 300 字」。
       * 长度一律交给校验函数按码点判，这里只 trim。
       */
      const value = String(b.value ?? '').trim();
      if (!SELF_KINDS.includes(kind)) return bad(`kind 只能是 ${SELF_KINDS.join(' / ')}`);
      if (!value) return bad('缺 value（要改成什么）');

      let payload;
      let summary;
      if (kind === 'name') {
        const v = validateProfileText(value, { field: '昵称', max: MAX_NAME_LEN });
        if (!v.ok) return bad(v.message);
        /**
         * 人格卡写了 `selfName` 的话，改平台昵称会变成「资料卡一个名字、
         * 她自称另一个名字」。这道检查在写入时也有（`profile-tool.js`），
         * 但**提议时先拦**更好：否则主人点完「确认改」才收到「没改成」。
         */
        if (typeof personaOf === 'function') {
          let persona = null;
          try { persona = personaOf(); } catch { /* 拿不到人格就不拦，写入时还有一道 */ }
          const allowed = checkRenameAllowed(persona);
          if (!allowed.ok) return bad(allowed.message, 409, 'conflict');
        }
        payload = { name: v.text };
        summary = `名字改成「${v.text}」`;
      } else if (kind === 'sign') {
        const v = validateProfileText(value, { field: '签名', max: MAX_DESC_LEN });
        if (!v.ok) return bad(v.message);
        payload = { text: v.text };
        summary = `签名改成「${v.text}」`;
      } else {
        /** 地址本身没有长度校验，得自己挡：一个 500KB 的 URL 存进配置没人受得了 */
        if (value.length > MAX_AVATAR_URL) {
          return bad(`图片地址太长了（${value.length} 字符，上限 ${MAX_AVATAR_URL}）`);
        }
        const v = validateAvatarSource({ url: value });
        if (!v.ok) return bad(v.message);
        payload = { src: v.src, via: v.kind };
        summary = '换一张头像';
      }

      let r;
      try {
        r = await ask({ kind, payload, summary });
      } catch (e) {
        return bad(`发起确认失败：${e?.message ?? e}`, 500, 'internal');
      }
      if (!r?.ok) return bad(r?.message || '没能发起确认');
      log(`[ext-act] 扩展提议改${kind}：${summary}`);
      return {
        status: 200,
        body: {
          ok: true,
          /** 明确写出来：这是「已发出请求」，不是「已改」 */
          pending: true,
          reused: r.reused === true,
          kind,
          summary,
          message: r.reused
            ? '已经有一条同类请求在等主人点了，这次没有重复发'
            : '已发到主人私聊，等他点确认',
        },
      };
    },

    /** `GET /v1/group/info?groupId=` —— 群基本信息（人数、管理员、机器人权限） */
    async 'group.info'({ query } = {}) {
      const g = readGroupId(query?.groupId);
      if (g.error) return bad(g.error);
      const groupId = g.value;
      if (!groupId) return bad('缺 groupId');
      try {
        const r = await groupAdminOf().info(groupId);
        return { status: 200, body: { ...r, ok: r?.ok !== false } };
      } catch (e) {
        return bad(`读群信息失败：${e?.message ?? e}`, 502, 'upstream');
      }
    },

    /**
     * `POST /v1/group/mute` —— 禁言。
     *
     * 入参 `{ groupId, targets:[openid], seconds, confirm:true }`。
     * `seconds: 0` = 解除禁言（这是恢复动作，仍然要 confirm，因为 targets
     * 写错就会把不该解除的人解了）。
     */
    async 'group.mute'({ body } = {}) {
      const b = body && typeof body === 'object' ? body : {};
      const g = readGroupId(b.groupId);
      if (g.error) return bad(g.error);
      const groupId = g.value;
      const targets = readTargets(b.targets);
      if (!groupId) return bad('缺 groupId');
      if (targets.error) return bad(targets.error);
      if (!targets.list.length) return bad('缺 targets（要禁言谁的 openid 列表）');
      if (targets.list.length > MAX_GROUP_TARGETS) {
        return bad(`一次最多 ${MAX_GROUP_TARGETS} 人，收到 ${targets.list.length} 个`);
      }
      const seconds = Number(b.seconds);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_MUTE_SECONDS) {
        return bad(`seconds 要是 0–${MAX_MUTE_SECONDS} 的整数（0 = 解除禁言）`);
      }
      if (b.confirm !== true) return bad('禁言需要显式确认：传 confirm: true', 400, 'need_confirm');

      try {
        const r = await groupAdminOf().mute({ groupId, targets: targets.list, seconds });
        log(`[ext-act] 扩展禁言 ${targets.list.length} 人 ${seconds}s：${r?.ok ? 'ok' : 'fail'}`);
        return { status: 200, body: { ...r, ok: r?.ok !== false } };
      } catch (e) {
        return bad(`禁言失败：${e?.message ?? e}`, 502, 'upstream');
      }
    },

    /**
     * `POST /v1/group/kick` —— 移出群成员。
     *
     * 入参 `{ groupId, targets:[openid], addToBlacklist?, confirm:true }`。
     * 主人自己被 `groupAdmin` 在本地就挡住了（`protectedTargets`），
     * 不用等官方回 protected。
     */
    async 'group.kick'({ body } = {}) {
      const b = body && typeof body === 'object' ? body : {};
      const g = readGroupId(b.groupId);
      if (g.error) return bad(g.error);
      const groupId = g.value;
      const targets = readTargets(b.targets);
      if (!groupId) return bad('缺 groupId');
      if (targets.error) return bad(targets.error);
      if (!targets.list.length) return bad('缺 targets（要移出谁的 openid 列表）');
      if (targets.list.length > MAX_GROUP_TARGETS) {
        return bad(`一次最多 ${MAX_GROUP_TARGETS} 人，收到 ${targets.list.length} 个`);
      }
      if (b.confirm !== true) return bad('踢人需要显式确认：传 confirm: true', 400, 'need_confirm');

      try {
        const r = await groupAdminOf().kick({
          groupId, targets: targets.list, addToBlacklist: b.addToBlacklist === true,
        });
        log(`[ext-act] 扩展移出 ${targets.list.length} 人：${r?.ok ? 'ok' : 'fail'}`);
        return { status: 200, body: { ...r, ok: r?.ok !== false } };
      } catch (e) {
        return bad(`移出失败：${e?.message ?? e}`, 502, 'upstream');
      }
    },

    /**
     * `POST /v1/tts` —— 把一句话合成语音，**只返回字节，不发出去**。
     *
     * 为什么不直接发：发到哪、配什么文字、要不要带卡片，是调用方的决定。
     * 宿主只负责「这句话念出来是什么声音」。
     *
     * 拿到的 base64 要落一份到扩展自己的目录，再用 `/v1/send` 的 `files`
     * 发出去——那条路只收扩展目录下的文件。
     */
    async 'tts.speak'({ body } = {}) {
      const b = body && typeof body === 'object' ? body : {};
      /** 同 `self.propose`：不 `slice`，长度按码点判，别把 emoji 切成半个 */
      const text = String(b.text ?? '').trim();
      if (!text) return bad('缺 text');
      if (Array.from(text).length > PREVIEW_TEXT_LIMIT) {
        return bad(`一次最多 ${PREVIEW_TEXT_LIMIT} 字，长了应该分几次说`, 413, 'text_too_long');
      }

      try {
        const r = await runPreview({
          text,
          /** 用已保存的配置，不收调用方传的 draft：那是面板试听才有的东西 */
          draft: cfgOf()?.tts || {},
          synth: (t, o) => ttsOf().synthesize(t, o),
          convert: (p) => roostOf().rpc('media.convert', p, { timeout: 30_000 }),
        });
        log(`[ext-act] 扩展合成语音 ${r.bytes} 字节（${r.provider || '?'}）`);
        return { status: 200, body: { ...r, message: '合成好了，自己决定怎么发' } };
      } catch (e) {
        const status = Number(e?.status) || 502;
        const code = String(e?.code || 'tts_failed').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'tts_failed';
        return bad(String(e?.message || '语音合成失败'), status, code);
      }
    },
  };
}
