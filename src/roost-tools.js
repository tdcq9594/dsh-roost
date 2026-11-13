/**
 * 把框架外接协议的能力挂成 AI 工具
 * ================================
 *
 * 方案 A 的另一半：框架插件只要 `ctx.registerTool()`，协议里就多一个
 * `tool.<name>`；这里在连上之后拉能力表，让模型能**发现并调用**它们，
 * 顺带把以前没接上的只读能力（运行状态 / 投递终态 / 身份 / 可达性 /
 * 账本 / 插件运行数据…）也开放出来。
 *
 * 为什么不「一个插件工具注册一个 AI 工具」：DSH 的工具表是注册时固定的，
 * 而框架插件会热重载。做成两个通用工具（`roost_tools` 列清单 + `roost_tool`
 * 按名字调），执行时现读能力表，插件装卸不需要重新注册，也不会留下
 * 指向已卸载插件的僵尸工具。
 *
 * 权限：只读能力全员可用，日志 / 运行数据 / 配置只给主人与管理员；
 * 任何写方法都不在白名单里（`roost-capabilities.js` 统一把着）。
 */

import { shapeTool, loadDefineTool } from './tools.js';
import { READONLY_METHODS, PRIVILEGED_METHODS } from './roost-capabilities.js';

const PRIVILEGED = new Set(PRIVILEGED_METHODS);
const BUCKET_OK = new Set(['owner', 'admin']);

/**
 * 每个工具都必须声明 `output`，缺了 DSH 直接拒绝注册。
 *
 * 2026-11-13 实机：`tool "roost_tools" must declare output { schema, render,
 * presentationMeta? }` —— 四个 roost 工具全被挡在外面，框架能力整组没挂上，
 * 面板里只留一行 warn。同仓 `tools.js` / `qq-tools.js` / `sticker-tools.js`
 * 的工具早就带了这个字段，只有这里漏了，所以「别的工具能用、就这几个不能用」。
 *
 * `render` 必须返回**内容块数组**，不能返回字符串：DSH 会对 content 调
 * `.some()`，字符串没有这个方法（`content.some is not a function`，0.9.x 踩过）。
 */
const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
};

/** 纯函数，方便单测：不碰 DSH、不碰网络 */
export function buildRoostToolDefs({ caps, callerOf = () => ({}) } = {}) {
  const caller = () => callerOf?.() || {};
  const privileged = () => BUCKET_OK.has(String(caller().bucket || ''));

  const summaryOf = () => {
    const builtin = (caps?.available?.() ?? READONLY_METHODS).map((m) => ({
      name: m.name, desc: m.desc, scope: 'read',
    }));
    const plugins = (caps?.dynamic?.() ?? []).map((m) => ({
      name: m.name,
      desc: m.desc.replace(/^\[插件工具·[^\]]*\]\s*/, ''),
      scope: m.scope,
      parameters: m.parameters,
    }));
    return { builtin, plugins };
  };

  const listTool = {
    name: 'roost_tools',
    description:
      '列出框架（Roost 外接协议）现在能用的能力：一类是只读查询（机器人状态、投递终态、'
      + '身份解析、可达性、消息账本、插件清单等），一类是框架插件注册的新工具（名字以 tool. 开头，'
      + '会带参数说明）。想用哪一个，把它的 name 原样交给 roost_tool。'
      + '框架没连上时清单可能是空的，先别猜能力名字。',
    parameters: {
      filter: {
        type: 'string',
        description: '可选：按名字片段筛选，例如 "delivery" 或 "tool."',
      },
    },
    output: OUTPUT,
    async execute({ filter = '' } = {}) {
      const { builtin, plugins } = summaryOf();
      const f = String(filter ?? '').trim().toLowerCase();
      const hit = (m) => !f || `${m.name} ${m.desc}`.toLowerCase().includes(f);
      return {
        ok: true,
        connected: (caps?.list?.() ?? []).length > 0,
        builtin: builtin.filter(hit),
        pluginTools: plugins.filter(hit),
        note: '调用时用 roost_tool({name, args})；插件工具的参数照 parameters 填。',
      };
    },
  };

  const callTool = {
    name: 'roost_tool',
    description:
      '调用框架（Roost 外接协议）的一个能力。name 必须来自 roost_tools 的清单：'
      + '只读能力直接用原名（如 runtime.status、identity.resolve），插件工具用 tool. 前缀的名字。'
      + '只允许只读查询与插件工具，写操作/管理操作会被拒绝。'
      + '不确定参数时先调 roost_tools 看 parameters。',
    parameters: {
      name: {
        type: 'string', required: true,
        description: '能力名，来自 roost_tools 清单',
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: '参数对象；不需要参数就传空对象',
      },
    },
    output: OUTPUT,
    async execute({ name = '', args = {} } = {}) {
      const key = String(name ?? '').trim();
      if (!key) return { ok: false, message: '要给能力名 name' };
      if (PRIVILEGED.has(key) && !privileged()) {
        return { ok: false, message: `${key} 只有主人或管理员能查` };
      }
      try {
        const data = await caps.call(key, args && typeof args === 'object' ? args : {});
        return { ok: true, name: key, data };
      } catch (e) {
        return { ok: false, name: key, message: e?.message ?? String(e) };
      }
    },
  };

  const statusTool = {
    name: 'roost_status',
    description:
      '看机器人与框架外接协议现在的状态：在不在线、协议连接状态、当前事件通道、'
      + '暂停闸有没有开。排查「怎么没反应」时先调这个，比猜快。',
    parameters: {},
    output: OUTPUT,
    async execute() {
      const out = {};
      for (const m of ['runtime.status', 'gate.get']) {
        try { out[m] = await caps.call(m, {}); }
        catch (e) { out[m] = { ok: false, message: e?.message ?? String(e) }; }
      }
      return { ok: true, ...out };
    },
  };

  const deliveryTool = {
    name: 'roost_delivery',
    description:
      '看最近几条消息到底发出去没有（含审核中、被拒、失败原因）。'
      + '用户说「刚才那句没看到」时调它，别凭印象回答。',
    parameters: {
      limit: {
        type: 'number',
        description: '看几条，默认 20',
      },
    },
    output: OUTPUT,
    async execute({ limit = 20 } = {}) {
      try {
        const data = await caps.call('delivery.recent', { limit: Math.max(1, Math.min(200, Number(limit) || 20)) });
        return { ok: true, ...data };
      } catch (e) {
        return { ok: false, message: e?.message ?? String(e) };
      }
    },
  };

  return [listTool, callTool, statusTool, deliveryTool];
}

/**
 * 挂到 agent 的工具表。和 `registerQqTools` 同一套形状处理
 * （DSH 有 defineTool 就交扁平表，否则转标准 JSON Schema）。
 *
 * @returns {Promise<{ok:boolean,names:string[],off?:Function,reason?:string}>}
 */
export async function registerRoostTools({ agent, caps, callerOf = () => ({}), log = () => {} } = {}) {
  const registry = agent?.ctx?.tools;
  if (!registry?.register) {
    return { ok: false, names: [], reason: '这个 agent 的 tools 服务没有 register（版本差异）' };
  }
  const defineTool = await loadDefineTool();
  const defs = buildRoostToolDefs({ caps, callerOf });
  const made = [];
  for (const def of defs) {
    try {
      const off = registry.register(shapeTool(def, defineTool));
      made.push({ off, name: def.name });
    } catch (e) {
      log(`框架能力工具 ${def.name} 没装上：${e?.message ?? e}`);
      for (const m of made) { try { m.off?.(); } catch {} }
      return { ok: false, names: [], reason: `${def.name} 注册失败：${e?.message ?? e}` };
    }
  }
  return {
    ok: true,
    names: made.map((m) => m.name),
    mode: defineTool ? 'defineTool' : 'plain',
    off: () => { for (const m of made) { try { m.off?.(); } catch {} } },
  };
}
