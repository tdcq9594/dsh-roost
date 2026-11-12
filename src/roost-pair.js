/**
 * 一键直连：把 roost 的外接协议开起来，再把地址和 token 写回自己的配置。
 *
 * ## 为什么不直接改 roost 的配置文件
 *
 * 改文件看着更"直接"，但要自己维护格式、自己算端口、还得让进程重启才生效，
 * 而且对方的配置校验（token 长度、依赖检查、监听地址安全性）全部绕过。
 * 一旦它的写入格式变了，这边就会写出一份没人认识的配置。
 *
 * 所以**全程走它自己的面板 API**（参考 aurabot 接管 SnowLuma 的做法：
 * 它也是通过 webui 的 `/api/processes` 去注入机器人号，而不是改它的文件）：
 *
 *   GET  /api/host              看现在开没开、拿得到 token
 *   PUT  /api/host              开启 + 设 token，**保存即热重配，不用重启**
 *
 * 不装任何依赖：本插件读 SSE，框架的 `/ws` 是给别的客户端用的可选通道。
 *
 * 三个好处：端口由框架按 `6800+hash(botId)%100` 自己算（我们只管读回来）、
 * 配置落盘和热重配都是它的职责、出错信息是它自己给的而不是我们猜的。
 *
 * ## 写回自己这边
 *
 * `roostHost.enabled` 一定要写。移除 ai-chat 后只剩一个通道，
 * `channel.current` 恒为 `roost`，不再随开关切换（否则会指向不存在的实现）。
 */

/**
 * 对面**根本没有** `/api/host` —— 版本太老，不是网络问题。
 *
 * 这两种情况必须分开：网络问题该去查端口/进程，版本问题只能升级。
 * 混成一句「连不上面板」，用户会一直在网络和进程上找。
 *
 * 判据按可靠性排序：HTTP 404 最硬；其次是它自己的错误文案
 * （`接口不存在` 是面板对未知路由的固定回复）；最后才是通用 404 字样。
 */
function isLegacyRoost(e) {
  if (Number(e?.status) === 404) return true;
  const msg = String(e?.message ?? '');
  return /接口不存在|NOT_FOUND|Cannot (GET|PUT|POST)|Not Found/i.test(msg);
}

/**
 * @param {object} o
 * @param {object} o.setup      `createSetup()` 的实例（要用它的 detect / api）
 * @param {() => object} o.cfgOf
 * @param {(patch:object)=>void} o.setCfg
 * @param {(m:string)=>void} [o.log]
 * @param {() => Promise<object>} [o.ensureWs] 顺带确保 ws 可选依赖（失败不阻塞）
 */
export function createPairing({ setup, cfgOf, setCfg, log = () => {}, ensureWs = null }) {
  const selfCfg = () => cfgOf()?.roostHost ?? {};
  const channelCfg = () => cfgOf()?.channel ?? {};

  /** 把 roostHost / channel 合进现有配置再写——面板的 patch 是浅合并，直接传整段会冲掉 decide/merge */
  function save({ enabled, url, token }) {
    const cur = selfCfg();
    setCfg({
      roostHost: {
        ...cur,
        ...(enabled === undefined ? {} : { enabled }),
        ...(url === undefined ? {} : { url }),
        ...(token === undefined ? {} : { token }),
      },
      channel: { ...channelCfg(), current: 'roost' },
    });
  }

  /**
   * 现在是什么状况。面板一打开就调它，所以**不能抛错**——
   * Roost 没装、没起来、面板没开，都要能如实显示。
   */
  async function inspect() {
    let detect = null;
    let detectError = '';
    try {
      detect = await setup.detect();
    } catch (e) {
      detectError = e?.message ?? String(e);
    }

    let host = null;
    let hostError = '';
    let legacy = false;
    if (detect?.installed && detect?.running) {
      try {
        const r = await setup.api('/api/host');
        host = {
          enabled: Boolean(r?.cfg?.enabled),
          port: Number(r?.cfg?.port) || 0,
          tokenSet: Boolean(r?.cfg?.tokenSet),
          scopes: Array.isArray(r?.cfg?.scopes) ? r.cfg.scopes : [],
          allowManage: Boolean(r?.cfg?.allowManage),
          /** `missing` 只影响框架的 /ws 通道，不影响我们用的 HTTP + SSE */
          depsReady: Boolean(r?.deps?.ready),
          missing: Array.isArray(r?.deps?.missing) ? r.deps.missing : [],
          /** 框架实际开出来的通道（老版本没有这个字段，按 ws 缺省 true 处理） */
          transports: r?.state?.transports ?? null,
          state: String(r?.state?.state ?? ''),
          actualPort: Number(r?.state?.port) || 0,
          error: String(r?.state?.error ?? ''),
          connections: Number(r?.state?.connections) || 0,
        };
      } catch (e) {
        if (isLegacyRoost(e)) legacy = true;
        else hostError = e?.message ?? String(e);
      }
    }

    const self = selfCfg();
    const roost = {
      installed: Boolean(detect?.installed),
      running: Boolean(detect?.running),
      version: String(detect?.version ?? ''),
      error: detectError,
    };

    /** 一句话结论 + 下一步该干什么。前端直接照着显示，不再自己拼判断 */
    let step = 'ready';
    let text = '已直连，消息走外接协议进来';
    if (!roost.installed) {
      step = 'no-roost'; text = '还没装 Roost（第 1 步）';
    } else if (!roost.running) {
      step = 'no-run'; text = 'Roost 没在跑，先启动（第 2 步）';
    } else if (legacy) {
      /**
       * 旧版 Roost 没有 `/api/host`。这里必须和「面板连不上」分开说：
       * 前者只能升级，后者要查端口和进程，给出的下一步完全不同。
       */
      step = 'old-roost';
      text = `Roost ${roost.version || '当前版本'} 版本太老，还没有「外接协议」—— 先把它更新到最新版`;
    } else if (hostError) {
      step = 'no-panel'; text = `连不上 Roost 面板：${hostError}`;
    } else if (host && !host.enabled) {
      step = 'no-host'; text = '外接协议没开，点下面一键开启';
    } else if (!String(self.url || '').trim() || !String(self.token || '').trim()) {
      step = 'no-self'; text = 'Roost 那边开了，但这边还没配对，点下面一键配对';
    }

    return {
      ok: true,
      roost,
      host,
      hostError,
      /** 对面没有 `/api/host`：面板据此显示「先升级 Roost」，而不是「网络不通」 */
      legacy,
      self: {
        enabled: Boolean(self.enabled),
        url: String(self.url ?? ''),
        tokenSet: Boolean(self.token),
        channel: 'roost',
      },
      step,
      text,
    };
  }

  /**
   * 一键：装依赖 → 开协议 → 写自己的配置。
   *
   * @param {object} [o]
   * @param {boolean} [o.rotate] 强制换一个新 token（怀疑泄漏时用）
   * @param {string[]} [o.scopes] 默认 read + message（能收能发，但不能改配置）
   * @param {boolean} [o.allowManage] manage 总闸，默认关
   */
  async function enable({ rotate = false, scopes = ['read', 'message'], allowManage = false } = {}) {
    const d = await setup.detect();
    if (!d?.installed) throw Object.assign(new Error('还没装 Roost，先去第 1 步'), { step: 'no-roost' });
    if (!d?.running) throw Object.assign(new Error('Roost 没在跑，先去第 2 步启动'), { step: 'no-run' });

    let cur;
    try {
      cur = await setup.api('/api/host');
    } catch (e) {
      if (isLegacyRoost(e)) {
        /**
         * 版本问题给**可执行**的下一步。只说「接口不存在」，用户不知道该点哪。
         */
        throw Object.assign(
          new Error(
            `Roost ${d?.version || '当前版本'} 还没有「外接协议」接口（/api/host）。`
            + '先把 Roost 更新到最新版（面板「系统 → 更新」，或重新下载解压），再点一次「一键直连」。',
          ),
          { step: 'old-roost' },
        );
      }
      throw Object.assign(new Error(`连不上 Roost 面板：${e?.message ?? e}`), { step: 'no-panel' });
    }

    /**
     * 1) 顺带把可选依赖 `ws` 准备好。
     *
     * 两条事件通道都通（SSE 零依赖 / WS 更快），所以这一步**失败也不拦**：
     * 装不上就继续走 SSE，功能一点不少，只是事件流慢一点点。
     *
     * 顺序由调用方（host.js）决定：优先复用框架已装的那份，没有再装。
     */
    let wsNote = null;
    if (typeof ensureWs === 'function') {
      try {
        wsNote = await ensureWs();
        if (wsNote?.ok && wsNote.mode !== 'reuse' && wsNote.mode !== 'own') {
          log(`可选依赖 ws：${wsNote.message || wsNote.mode}`);
        }
      } catch (e) {
        /** 明确吞掉：依赖装不上不是「连不上」，不该让整次配对失败 */
        wsNote = { ok: false, mode: 'failed', message: e?.message ?? String(e) };
        log(`可选依赖 ws 准备失败（继续用 SSE）：${e?.message ?? e}`);
      }
    }


    /**
     * 2) token。
     *
     * **不从 `GET /api/host` 读明文了**——那个接口现在只报「有没有设置」。
     * 理由：它对回环请求返回明文，等于让本机任意进程一条 GET 就抄走一个
     * 能以机器人身份说话的凭证。改成「要么用自己存的那份，要么让服务端生成」。
     *
     * 沿用自己配置里那份是为了**不把正在用的客户端踢下线**；
     * 自己没有、或者要求 rotate，就让服务端生成，明文只在这次响应里出现一次。
     */
    const own = String(selfCfg().token ?? '').trim();
    const useOwn = !rotate && own.length >= 16;

    /** 3) 开监听。端口沿用它的配置——`0` 表示框架按 botId 自己算，我们不插手 */
    let put;
    try {
      put = await setup.api('/api/host', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: true,
          token: useOwn ? own : 'auto',
          scopes: Array.isArray(scopes) ? scopes : ['read', 'message'],
          allowManage: Boolean(allowManage),
          port: Number(cur?.cfg?.port) || 0,
        }),
      });
    } catch (e) {
      const detail = e?.message ?? String(e);
      throw Object.assign(new Error(`开启外接协议失败：${detail}`), { step: 'no-host' });
    }

    /**
     * 4) 端口从**返回的 state** 里读，不用自己算。
     *
     * 配置里的 `port` 是「意愿」（0 = 自动），`state.port` 才是真在听的端口。
     * 端口被占时框架会顺延，自己按公式算就会连到一个没人听的端口上。
     */
    const port = Number(put?.state?.port) || 0;
    if (!port) {
      throw Object.assign(
        new Error('协议已开，但拿不到监听端口（可能刚起来还没 bind），稍等几秒再点一次'),
        { step: 'no-host' },
      );
    }
    const url = `http://127.0.0.1:${port}`;

    /**
     * 服务端生成的密钥**只在那一次响应里出现**，拿不到就是对面版本不对。
     *
     * 不能「拿不到就算了先存个空」——那会存下一个连不上的配置，症状是
     * 面板显示已配对、事件一条都进不来。
     */
    const token = useOwn ? own : String(put?.token ?? '');
    if (!token) {
      throw Object.assign(
        new Error('Roost 没有回传新密钥 —— 对面版本可能太老（不支持服务端生成）。先把 Roost 更新到最新版再试。'),
        { step: 'old-roost' },
      );
    }

    /** 5) 写回自己这边。两个开关一起写，别出现「收得到发不出」 */
    save({ enabled: true, url, token });

    return {
      ok: true,
      url,
      port,
      token,
      /** 前端可据此提示「已顺带装好 ws / 复用框架的 / 装不上走 SSE」 */
      ws: wsNote,
      /** 前端据此调自己的重连（`roost.stop()` → `roost.start()`） */
      restartNeeded: true,
      state: String(put?.state?.state ?? ''),
    };
  }

  /** 关掉协议（保留地址和 token，下次开的时候不用重新配） */
  async function disable() {
    let warning = '';
    try {
      await setup.api('/api/host', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    } catch (e) {
      /** 面板连不上也要把本地开关关掉，否则会出现「本地以为在直连、对面早关了」 */
      warning = `Roost 那边没关成：${e?.message ?? e}`;
    }
    save({ enabled: false });
    return { ok: true, warning, restartNeeded: true };
  }

  /** 真连一次（`system.ping`）。面板上「测一下」用的，不依赖自己那套长连接 */
  async function test() {
    const url = String(selfCfg().url ?? '').trim();
    const token = String(selfCfg().token ?? '').trim();
    if (!url) throw new Error('还没配对（缺地址）');
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`${url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ id: 'pair-test', method: 'system.ping', params: {} }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      const hint = e?.cause?.code === 'ECONNREFUSED' ? '（端口没人监听：协议没开，或者进程退了）' : '';
      throw new Error(`连不上 ${url}${hint}`);
    }
    const body = await res.json().catch(() => null);
    if (!body) throw new Error(`没回 JSON（HTTP ${res.status}）`);
    if (body.ok === false) {
      const code = body?.error?.code ?? '';
      const hint = code === 'UNAUTHORIZED' ? '（token 对不上，重新点一次「一键配对」）' : '';
      throw new Error(`${body?.error?.message ?? '调用失败'}${hint}`);
    }
    return { ok: true, ms: Date.now() - t0, pong: body?.data?.pong ?? 0 };
  }

  return { inspect, enable, disable, test };
}
