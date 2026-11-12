/**
 * 外接协议能力协商
 * ================
 *
 * 直连之后，框架那边有 70 多个方法，还会在插件启停时多出 `tool.*`。
 * 以前宿主把这些方法名写死在代码里，框架升级/降级就会出现「调用一个不存在的
 * 方法」或者「明明有却没用上」。这里在连上之后拉一次 `system.capabilities`，
 * 之后所有新增能力都先问它，再决定调不调。
 *
 * **只读白名单**：AI 工具对协议是外部输入，不能让它拿到写/管理面
 * （`config.set` / `plugin.install` / `qq.call` …）。只允许下面这些只读方法，
 * 加上框架插件投影出来的 `tool.*`（它们由插件作者声明，scope 在协议层把着）。
 */

/** 允许经 AI 工具调用的只读能力（desc 用于列给模型看） */
export const READONLY_METHODS = Object.freeze([
  { name: 'system.hello', desc: '协议版本、身份、当前方法清单' },
  { name: 'system.capabilities', desc: '完整方法表与 scope 要求' },
  { name: 'runtime.status', desc: '机器人与外接协议的运行状态' },
  { name: 'runtime.logs', desc: '框架最近日志（仅主人/管理员）' },
  { name: 'delivery.recent', desc: '最近消息的投递终态（发出去没／被拒没）' },
  { name: 'delivery.get', desc: '按 requestId 查一条投递终态' },
  { name: 'ledger.recent', desc: '消息账本最近记录' },
  { name: 'ledger.timeline', desc: '按会话取前后文' },
  { name: 'ledger.stats', desc: '事件账本统计' },
  { name: 'identity.resolve', desc: 'openid ↔ QQ 号 ↔ 群号' },
  { name: 'identity.list', desc: '身份绑定清单' },
  { name: 'reach.get', desc: '群/私聊可达性与主动消息授权' },
  { name: 'roles.resolve', desc: '算某个发送者的权限档位' },
  { name: 'msg.get', desc: '按 msgId 取账本记录' },
  { name: 'plugin.list', desc: '框架插件清单' },
  { name: 'plugin.dashboard', desc: '插件运行数据（仅主人/管理员）' },
  { name: 'plugin.versions', desc: '本地插件版本' },
  { name: 'plugin.updates', desc: '可更新插件' },
  { name: 'media.image.list', desc: 'Markdown 素材清单与配额' },
  { name: 'gate.get', desc: '暂停闸快照' },
  { name: 'config.get', desc: '脱敏后的运行时配置（仅主人/管理员）' },
  { name: 'qq.methods', desc: '官方 API 方法名与风险档' },
]);

/** 这些即使只读也只给主人/管理员：日志、运行数据、配置里可能带内部信息 */
export const PRIVILEGED_METHODS = Object.freeze([
  'runtime.logs', 'plugin.dashboard', 'config.get',
]);

const READONLY_NAMES = new Set(READONLY_METHODS.map((m) => m.name));

/**
 * @param {object} o
 * @param {(method:string, params:object)=>Promise<any>} o.rpc
 * @param {(m:string)=>void} [o.log]
 */
export function createCapabilityClient({ rpc, log = () => {} } = {}) {
  if (typeof rpc !== 'function') throw new Error('能力协商需要 rpc 函数');

  let methods = [];
  let byName = new Map();
  let sig = '';
  let lastError = '';
  let lastAt = 0;

  /** 拉一次能力表。框架没连上时抛错由调用方吞掉，保留上一次的清单 */
  async function refresh() {
    const r = await rpc('system.capabilities', {});
    const list = Array.isArray(r) ? r : Array.isArray(r?.methods) ? r.methods : [];
    methods = list
      .filter((m) => m && typeof m.name === 'string')
      .map((m) => ({
        name: m.name,
        scope: String(m.scope ?? 'read'),
        desc: String(m.desc ?? ''),
        parameters: m.parameters ?? null,
      }));
    byName = new Map(methods.map((m) => [m.name, m]));
    sig = methods.map((m) => `${m.name}:${m.scope}`).sort().join('|');
    lastError = '';
    lastAt = Date.now();
    return methods;
  }

  /** 框架插件注册的工具投影出来的一等方法 */
  function dynamic() {
    return methods.filter((m) => m.name.startsWith('tool.'));
  }

  function has(name) {
    return byName.has(String(name ?? '').trim());
  }

  /** AI 工具能不能调这个能力 */
  function allowed(name) {
    const key = String(name ?? '').trim();
    if (READONLY_NAMES.has(key)) return true;
    return key.startsWith('tool.') && byName.has(key);
  }

  /**
   * 调一个白名单能力。插件工具按协议约定把参数包成 `{args}`，
   * 内置只读方法直接透传。
   */
  async function call(name, params = {}) {
    const key = String(name ?? '').trim();
    if (!allowed(key)) {
      throw new Error(`不允许通过 AI 工具调用 ${key}：只允许只读能力与插件工具`);
    }
    if (!byName.has(key)) {
      throw new Error(`框架没有这个能力：${key}（可能版本较旧或插件已卸载，先刷新能力表）`);
    }
    return await rpc(key, key.startsWith('tool.') ? { args: params } : params);
  }

  return {
    refresh,
    dynamic,
    has,
    allowed,
    call,
    list: () => methods.slice(),
    /** 只读白名单里、当前框架确实有的那些 */
    available: () => READONLY_METHODS.filter((m) => byName.has(m.name)),
    signature: () => sig,
    lastError: () => lastError,
    lastAt: () => lastAt,
    /** 供面板/日志用，不抛错 */
    noteError(e) {
      lastError = String(e?.message ?? e ?? '未知错误');
      log(`能力表刷新失败（保留旧清单）：${lastError}`);
    },
  };
}
