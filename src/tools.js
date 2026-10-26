// 给 AI 的工具。
//
// 分层原则（跟 Roost 那边的设计一致）：
//   L1 专用工具 —— AI 天天用、参数组合复杂的（发消息、撤回、禁言、面板）
//   L2 通用工具 —— qq_api(method, args)，覆盖官方剩下全部接口
//   L3 说明书   —— qq_api_help，让 AI 自己查「官方还有什么能调」
//
// 不把 47 个接口都做成独立工具：AI 选不过来，维护也跟不上。
//
// 工具定义一旦发布尽量别改——改一次，模型的前缀缓存就失效一次。

/**
 * 和 @deepseek-ai/dsh-tools 的 defineTool 产物同形。
 * parameters / output.schema 都是 JSON Schema。
 */
export function defineTool({ name, description, properties = {}, required = [], execute }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) =>
        [{ type: 'text', text: value?.ok === false ? `✗ ${value.message || '没成功'}` : value?.message || '✓' }],
    },
    async execute(args) {
      try {
        return JSON.parse(JSON.stringify((await execute(args || {})) ?? { ok: true }));
      } catch (e) {
        return { ok: false, message: String(e?.message ?? e) };
      }
    },
  };
}

const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const int = (description) => ({ type: 'integer', description });

/**
 * 构造这个会话可用的 QQ 工具。
 *
 * @param {import('./roost.js').RoostClient} roost
 * @param {object} chat { kind:'group'|'c2c', chatId, groupId, userId, lastMsgId? }
 * @returns {object[]}
 */
export function buildTools(roost, chat) {
  const scene = chat.kind === 'c2c' ? 'c2c' : 'group';
  const target = chat.kind === 'c2c' ? chat.userId : chat.groupId;

  /** 发一条：文本 / markdown / 图片，都能带被动回复或引用 */
  async function send({ text, markdown, imageUrl, replyTo, quote, keyboard }) {
    const base = {};
    // 被动回复窗口：带 msgId 就是被动，Roost 自己管 5 分钟和 5 次上限
    if (replyTo) base.msgId = replyTo;
    if (quote) base.messageReference = { message_id: quote };
    if (keyboard) base.keyboard = keyboard;

    // 图片要先传，拿 file_info 再发
    if (imageUrl) {
      const up = await roost.call('uploadMedia', { scene, target, fileType: 1, url: imageUrl });
      if (!up?.file_info) throw new Error('图片上传没拿到 file_info');
      return roost.call(scene === 'group' ? 'sendGroup' : 'sendC2C', target, {
        ...base,
        msgType: 7,
        content: ' ',
        media: { file_info: up.file_info },
      });
    }
    if (markdown) {
      return roost.call(scene === 'group' ? 'sendGroup' : 'sendC2C', target, {
        ...base,
        markdown: { content: String(markdown) },
      });
    }
    if (!text) throw new Error('text / markdown / imageUrl 至少给一个');
    return roost.call(scene === 'group' ? 'sendGroup' : 'sendC2C', target, {
      ...base,
      content: String(text),
    });
  }

  return [
    defineTool({
      name: 'qq_send',
      description:
        '在当前的 QQ 会话里发一条消息。可以发纯文本、Markdown（支持标题/列表/加粗）、或者一张图片（给 URL）。'
        + '想「回复某条消息」就带 replyTo（那条消息的 id，5 分钟内有效，同一条最多回 5 次）；'
        + '想以「引用」的形式发就带 quote（引用索引 REFIDX_…）。',
      properties: {
        text: str('纯文本内容'),
        markdown: str('Markdown 内容，和 text 二选一'),
        imageUrl: str('图片 URL（http/https），和 text/markdown 三选一'),
        replyTo: str('要被动回复的消息 id'),
        quote: str('要引用的消息索引 REFIDX_…'),
      },
      execute: async (a) => {
        const r = await send(a);
        return { ok: true, message: `已发出（id=${r?.id ?? '?'}）`, id: r?.id };
      },
    }),

    defineTool({
      name: 'qq_recall',
      description: '撤回当前会话里的一条消息（只能撤机器人自己发的，2 分钟内）。',
      properties: { messageId: str('消息 id') },
      required: ['messageId'],
      execute: async ({ messageId }) => {
        await roost.call(scene === 'group' ? 'retractGroupMessage' : 'retractC2CMessage', target, messageId);
        return { ok: true, message: '已撤回' };
      },
    }),

    defineTool({
      name: 'qq_mute',
      description:
        '查或设置群成员禁言。不传 durationSec 就是「查状态」；传了就是「禁言这么久」（秒，最长 30 天）。'
        + '需要机器人是群管理员。',
      properties: {
        memberOpenid: str('群成员的 openid'),
        durationSec: int('禁言秒数，0 表示解除禁言'),
      },
      required: ['memberOpenid'],
      execute: async ({ memberOpenid, durationSec }) => {
        if (durationSec === undefined) {
          const r = await roost.call('getMuteStatus', target);
          return { ok: true, message: `查询完成`, result: r };
        }
        await roost.call('muteMembers', target, [{ memberOpenid, durationSec }]);
        return { ok: true, message: durationSec ? `已禁言 ${durationSec} 秒` : '已解除禁言' };
      },
    }),

    defineTool({
      name: 'qq_panel',
      description:
        '管理「指令面板」——用户在聊天框旁边看到的快捷指令列表（最多 20 项，可设仅管理员可见）。'
        + 'action=list 列出 / get 看详情 / create 新建 / update 改 / delete 删。',
      properties: {
        action: str('list | get | create | update | delete'),
        panelId: str('面板 id（get/update/delete 需要）'),
        scope: str('c2c | group | channel | dm（list/create 需要）'),
        panel: { type: 'object', description: 'create/update 时的面板内容 { items:[{type,name,desc,only_admin,link}], remark }' },
      },
      required: ['action'],
      execute: async ({ action, panelId, scope, panel }) => {
        const map = {
          list: () => roost.call('listPanels', { scope }),
          get: () => roost.call('getPanel', panelId),
          create: () => roost.call('createPanel', { scope, panel }),
          update: () => roost.call('updatePanel', panelId, panel),
          delete: () => roost.call('deletePanel', panelId),
        };
        const fn = map[action];
        if (!fn) throw new Error(`action 只能是 ${Object.keys(map).join(' / ')}`);
        const r = await fn();
        return { ok: true, message: `${action} 完成`, result: r };
      },
    }),

    defineTool({
      name: 'qq_api',
      description:
        '直接调 Roost 封装的任意官方接口。不知道有哪些方法时先调 qq_api_help。'
        + '参数原样透传给官方接口（驼峰命名，跟 Roost 的 QQApi 一致）。'
        + '危险操作（踢人、黑名单、执行审批策略）要额外带 confirm=true。',
      properties: {
        method: str('方法名，如 sendGroup / createPanel / getGroupInfo'),
        args: { type: 'object', description: '参数对象；需要目标会话的接口把 target 放第一个位置参数' },
        confirm: bool('危险操作确认'),
      },
      required: ['method'],
      execute: async ({ method, args = {}, confirm }) => {
        const r = await roost.call(method, args, { confirm });
        return { ok: true, message: `${method} 调用成功`, result: r };
      },
    }),

    defineTool({
      name: 'qq_api_help',
      description:
        '查官方接口清单：有哪些方法能调、每个是干什么的、风险等级。'
        + '可以给关键词过滤（如「禁言」「面板」「成员」）。',
      properties: { keyword: str('关键词，不传就列全部') },
      execute: async ({ keyword }) => {
        const caps = await roost.capabilities();
        const list = Array.isArray(caps) ? caps : (caps?.endpoints ?? []);
        const kw = String(keyword || '').trim().toLowerCase();
        const hit = kw
          ? list.filter((e) =>
            `${e.group} ${e.method} ${e.path} ${e.api} ${e.note ?? ''}`.toLowerCase().includes(kw))
          : list;
        return {
          ok: true,
          message: `${hit.length} 个接口${kw ? `（关键词「${keyword}」）` : ''}`,
          endpoints: hit.map((e) => ({
            api: e.api, http: `${e.method} ${e.path}`, group: e.group, risk: e.risk ?? 'read', note: e.note,
          })),
        };
      },
    }),
  ];
}
