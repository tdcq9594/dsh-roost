/**
 * 平台注册框架：把「怎么拿到一个能用的机器人」抽象出来。
 *
 * 现在的唯一实现是**扫码**（`/api/bots/qr/start` + `/qr/poll`，官方绑定页），
 * 它自己就有一整套状态机。问题在于：这套状态机写死在 `setup.js` 里，
 * 以后加第二种注册方式（填 AppID/Secret 手动绑、换个平台的授权页），
 * 就得再抄一遍"生成 → 轮询 → 拿凭证 → 落配置"。
 *
 * 所以这里只抽**接口**，不抽实现：
 *
 *   Registration = {
 *     name, label,
 *     start()            → { ok, taskId, qrUrl?, qrSvg?, message? }
 *     poll(taskId)       → { ok, status, appId?, appSecret?, message? }
 *     cancel?(taskId)    → 可选，能取消的才实现
 *   }
 *
 * `status` 归一成四个值（pending / done / expired / error）。
 * 为什么非归一不可：不同平台的状态码、含义、边界都不一样
 * （QQ 这里是数字 0/1/2，别家可能是 "WAITING"/"SUCCESS"）。
 * 上层只认这四个，加平台时不用改判断逻辑。
 */

/** 归一后的四个状态。别处判断只许用这四个 */
export const REG_STATUS = Object.freeze(['pending', 'done', 'expired', 'error']);

/**
 * 把各种平台的状态归一。
 *
 * 输入可以是字符串或数字；认不出来的一律按 `pending` 处理而不是 `error`——
 * 这是刻意的：状态认错成 error 会让用户以为"失败了"而重来一遍，
 * 认成 pending 最多是多轮询一次。
 */
export function normalizeStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'pending';
  if (['done', 'ok', 'success', 'succeed', 'confirmed', 'finished', '1', '2'].includes(s)) return 'done';
  if (['expired', 'timeout', 'timedout', '3', '4'].includes(s)) return 'expired';
  if (['error', 'fail', 'failed', 'invalid', 'denied'].includes(s)) return 'error';
  return 'pending';
}

/**
 * 扫码注册：包住 `setup.qrStart()` / `setup.qrPoll()`。
 *
 * 为什么不在这里直接 fetch 框架接口：那两个函数已经处理了
 * 「Roost 面板地址 + 密钥 + 错误文案」，重复一份必然漂移。
 */
export function createQrRegistration({ setup, name = 'qr', label = '扫码注册' } = {}) {
  return {
    name,
    label,
    /**
     * 开始一次注册。
     * @returns {Promise<{ok:boolean, taskId?:string, qrUrl?:string, qrSvg?:string, message?:string}>}
     */
    async start() {
      try {
        const r = await setup.qrStart();
        if (!r || r.ok === false) return { ok: false, message: r?.message || '生成二维码失败' };
        const taskId = String(r.taskId ?? '').trim();
        if (!taskId) return { ok: false, message: '框架没给 taskId' };
        return { ok: true, taskId, qrUrl: r.qrUrl, qrSvg: r.qrSvg };
      } catch (e) {
        return { ok: false, message: e?.message ?? String(e) };
      }
    },

    /**
     * 查一次。
     *
     * 成功时带回 `appId` / `appSecret`——**这两个只在这一刻能拿到**，
     * 框架不解密第二次。所以上层拿到后必须立刻落配置，不能等下一次轮询。
     */
    async poll(taskId) {
      const id = String(taskId ?? '').trim();
      if (!id) return { ok: false, status: 'error', message: '缺 taskId' };
      try {
        const r = await setup.qrPoll(id);
        const status = normalizeStatus(r?.status);
        if (status === 'done' && (!r?.appId || !r?.appSecret)) {
          return { ok: false, status: 'error', message: '扫码成功了，但没拿到完整凭证' };
        }
        return {
          ok: status !== 'error',
          status,
          appId: r?.appId,
          appSecret: r?.appSecret,
          message: r?.message,
        };
      } catch (e) {
        return { ok: false, status: 'error', message: e?.message ?? String(e) };
      }
    },
  };
}

/**
 * 手动填凭证：第二个实现，用来证明这层抽象真的能装下别的东西。
 *
 * 它不做"注册"这件事（凭证是用户自己去开放平台拿的），
 * 但接口形状一样，所以上层的"选一个注册方式"不用分叉。
 */
export function createManualRegistration({ submit } = {}) {
  return {
    name: 'manual',
    label: '手动填 AppID / AppSecret',
    async start() {
      return { ok: true, taskId: 'manual', message: '请在表单里填 AppID 和 AppSecret' };
    },
    async poll() {
      return { ok: false, status: 'pending', message: '手动注册不轮询，提交表单即可' };
    },
    async submit({ appId, appSecret } = {}) {
      if (!appId || !appSecret) return { ok: false, message: 'AppID 和 AppSecret 都要填' };
      const r = await submit?.({ appId, appSecret });
      return r ?? { ok: true };
    },
  };
}

/**
 * 注册方式注册表。
 *
 * 和通道注册表同构（`createChannelRegistry`）：按名字存、按配置挑。
 * 现在有两个实现（qr / manual），刚好说明这层不是为单个实现写的空壳。
 */
export function createRegistrationRegistry({ impls = [], pick = () => 'qr', log = () => {} } = {}) {
  const map = new Map((impls || []).filter(Boolean).map((i) => [i.name, i]));
  function resolve(name) {
    const n = String(name || '') || pick();
    const impl = map.get(n);
    if (!impl) {
      log(`没有叫「${n}」的注册方式，可用的有：${[...map.keys()].join('、') || '（空）'}`);
      return null;
    }
    return impl;
  }
  return {
    get: resolve,
    active: () => resolve(pick()),
    /** 面板用：列出所有注册方式，前端不必知道有哪几个 */
    list: () => [...map.values()].map((i) => ({ name: i.name, label: i.label })),
  };
}
