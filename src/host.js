// dsh-roost · 宿主半边（DSH 插件入口）
//
// 让 DSH 里的 AI 通过 Roost 住进 QQ：
//   QQ 官方 ⇄ Roost（常驻进程）⇄ 本插件 ⇄ DSH 会话
//
// 和 Aurabot 最大的区别：**不走 OneBot、不 hook 客户端**。
// Roost 用官方接口，所以我们能拿到 OneBot 给不了的东西：
// 官方 ASR（asrText）、转好的 WAV、ARK 卡片结构化、引用索引、指令面板、流式消息。
//
// 安全默认：总开关关。不手动打开，一句都不会真的发到 QQ。

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, saveConfig, publicConfig, dataDir } from './config.js'
import { RoostClient } from './roost.js'
import { buildTools } from './tools.js'

export const name = 'roost'

/**
 * 依赖的宿主服务。
 * agents/sessions：拿会话、投递消息
 * webServer：面板接口
 * systemPrompt：注入人格
 */
export const inject = ['agents', 'sessions', 'webServer', 'systemPrompt']

const PREFIX = '/roost/api'
const SOURCE_KIND = 'roost'

/** 日志：宿主有 logger 就用，没有就退回 console */
function makeLogger(ctx) {
  const L = ctx.logger ?? console
  const wrap = (fn) => (...args) => {
    try {
      ;(typeof fn === 'function' ? fn : console.log).apply(L, args)
    } catch {}
  }
  return {
    info: wrap(L.info),
    warn: wrap(L.warn),
    error: wrap(L.error),
    debug: wrap(L.debug),
  }
}

export function apply(ctx) {
  const log = makeLogger(ctx)
  let cfg = loadConfig()

  /** chatId -> { sessionId, preset, at } */
  const mapFile = () => join(dataDir(), 'sessions.json')
  const readMap = () => {
    try {
      return JSON.parse(readFileSync(mapFile(), 'utf8'))
    } catch {
      return { chats: {} }
    }
  }
  const writeMap = (m) => {
    try {
      writeFileSync(mapFile(), JSON.stringify(m, null, 2), 'utf8')
    } catch (e) {
      log.warn('会话映射写盘失败：', e.message)
    }
  }
  let map = readMap()

  /** 已经挂过工具的 agent（避免重复注册） */
  const mounted = new WeakMap()

  let client = null

  /* ---------------- 宿主服务 ---------------- */

  function controller() {
    const c = ctx.get('sessionController')
    if (!c) throw new Error('宿主没有 sessionController（需要 DSH 桌面版 / Web 组合）')
    return c
  }

  /** 给 QQ 会话找一个 DSH 工作区。没有登记过就取第一个 */
  async function workspaceId() {
    const reg = ctx.get('workspaceRegistry')
    try {
      const list = (await reg?.list?.()) ?? []
      if (list.length) return list[0].id
    } catch {}
    throw new Error('宿主里没有可用工作区，先在 DSH 里打开一个项目')
  }

  async function resolveAgent(sid) {
    const live = ctx.agents.get(sid) || ctx.agents.get('session-' + sid)
    if (live) return live
    const r = await controller().resolveAgent(sid)
    if (r?.agent) return r.agent
    throw new Error(r?.error?.message || '恢复 DSH 会话失败')
  }

  /** 拿到这个 QQ 会话对应的活 agent（没有就建） */
  async function agentFor(chat) {
    const preset = chat.kind === 'c2c' ? 'roost-private' : 'roost-social'
    const entry = map.chats[chat.chatId]
    const sid = entry && entry.preset === preset ? entry.sessionId : ''

    if (sid) {
      try {
        return { agent: await resolveAgent(sid), sessionId: sid, preset }
      } catch (e) {
        log.warn(`${chat.chatId}：旧会话 ${sid.slice(-8)} 拉不起来了（${e.message}），重建`)
      }
    }

    const r = await controller().create({ workspaceId: await workspaceId(), agentPreset: preset })
    const newSid = String(r.sessionId)
    try {
      await controller().rename({ sessionId: newSid, title: `QQ · ${chat.title || chat.chatId}` })
    } catch {}
    map.chats[chat.chatId] = { sessionId: newSid, preset, at: Date.now() }
    writeMap(map)
    log.info(`为 ${chat.chatId} 新建 DSH 会话 ${newSid.slice(-8)}（${preset}）`)
    return { agent: await resolveAgent(newSid), sessionId: newSid, preset }
  }

  /** 给 agent 挂上 QQ 工具 + 人格上下文（只挂一次） */
  function mount(agent, chat) {
    if (mounted.has(agent)) return
    const offs = []

    for (const tool of buildTools(client, chat)) {
      try {
        offs.push(agent.ctx.tools.register(tool))
      } catch (e) {
        log.warn(`工具 ${tool.name} 挂不上：`, e.message)
      }
    }

    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'roost-context',
          order: 905,
          text: () => {
            const p = cfg.persona
            const extra = chat.kind === 'c2c' ? p.rulesPrivate : p.rulesSocial
            return [`你现在叫「${p.name}」。`, p.text, extra].filter(Boolean).join('\n')
          },
        }),
      )
    } catch (e) {
      log.debug('挂人格上下文失败：', e.message)
    }

    mounted.set(agent, offs)
  }

  /* ---------------- 消息 → 会话 ---------------- */

  /**
   * 把 Roost 推来的消息拼成一段给模型看的文本。
   *
   * 这里就是「用官方接口」的好处所在：语音直接有官方 ASR 结果，
   * 卡片直接有结构化字段，引用直接有被引用的原文 —— 都不用自己解析。
   */
  function render(m) {
    const lines = []
    const who = m.userName || m.userId || '某人'
    lines.push(`${who}：${m.content || '（空）'}`)

    if (m.quoted) lines.push(`（引用了：${m.quoted}）`)

    for (const a of m.attachments ?? []) {
      if (a.type === 'voice') {
        lines.push(a.asrText ? `（语音，转文字：${a.asrText}）` : '（语音，没转出文字）')
      } else if (a.type === 'image') {
        lines.push(`（发了一张图：${a.url}）`)
      } else if (a.type === 'video') {
        lines.push('（发了一段视频）')
      } else if (a.type === 'file') {
        lines.push(`（发了个文件：${a.filename || '未命名'}）`)
      }
    }

    for (const el of m.elements ?? []) {
      if (el.type === 'chatRecord') lines.push(`（合并转发的内容：${String(el.content || '').slice(0, 500)}）`)
      if (el.type === 'ark') lines.push(`（卡片：${el.ark?.title || el.content || '无标题'}）`)
    }

    if (m.ark) lines.push(`（卡片：${m.ark.title || m.ark.name || '无标题'}）`)
    return lines.join('\n')
  }

  async function onMessage(m) {
    if (!cfg.chat.enabled) return
    if (!m || !m.chatId) return

    // 群聊里要不要理没 @ 的消息
    const addressed = Boolean(m.addressed || m.mentioned || m.isCommand)
    if (!addressed && !(cfg.chat.replyWithoutAt && m.kind === 'group')) return

    const chat = {
      kind: m.kind === 'c2c' ? 'c2c' : 'group',
      chatId: m.chatId,
      groupId: m.groupId,
      userId: m.userId,
      title: m.userName,
    }

    try {
      const { agent, sessionId } = await agentFor(chat)
      mount(agent, chat)

      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: render(m) }],
        source: { kind: SOURCE_KIND, chatId: m.chatId, msgId: m.msgId },
      })
      try {
        await ctx.sessions?.flush?.(agent.session)
      } catch {}
      log.debug(`${chat.chatId} → 会话 ${sessionId.slice(-8)}`)
    } catch (e) {
      log.error(`处理 ${chat.chatId} 的消息失败：`, e.message)
    }
  }

  /* ---------------- 连接管理 ---------------- */

  function start() {
    if (client) return
    const { baseUrl, accessKey, bot } = cfg.roost
    if (!baseUrl) {
      log.warn('没配 Roost 地址，先不动')
      return
    }
    client = new RoostClient({
      baseUrl,
      accessKey,
      bot,
      onMessage,
      onEvent: (ev, data) => log.debug(`[${ev}]`, JSON.stringify(data).slice(0, 100)),
      onError: (e) => log.warn('Roost 连接：', e.message),
    })
    client.start()
    log.info(`连接 Roost：${baseUrl}${bot ? `（只接 ${bot}）` : ''}`)
  }

  function stop() {
    client?.stop()
    client = null
  }

  /* ---------------- 面板接口 ---------------- */

  const send = (res, code, body) => {
    try {
      res.statusCode = code
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.setHeader?.('cache-control', 'no-store')
      res.end?.(JSON.stringify(body))
    } catch {}
  }

  const readBody = async (req) => {
    let s = ''
    try {
      for await (const c of req) s += c
    } catch {}
    try {
      return JSON.parse(s || '{}')
    } catch {
      return {}
    }
  }

  const route = (path, handler) =>
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: PREFIX + path,
          handler: (req, res) => handler(req, res).catch((e) => send(res, 500, { error: e.message })),
        }),
      `dsh-roost: ${path}`,
    )

  ctx.effect(() => {
    route('/config', async (req, res) => {
      if (req.method === 'GET') return send(res, 200, publicConfig(cfg))
      const body = await readBody(req)
      // 密钥打码时原样保留，别让面板把真 key 冲掉
      if (body?.roost?.accessKey === '******') delete body.roost.accessKey
      cfg = saveConfig(body)
      stop()
      start()
      return send(res, 200, publicConfig(cfg))
    })

    route('/status', async (req, res) =>
      send(res, 200, {
        connected: Boolean(client?.connected),
        baseUrl: cfg.roost.baseUrl,
        enabled: cfg.chat.enabled,
        chats: Object.keys(map.chats).length,
        version: '0.1.0',
      }),
    )

    return () => {}
  }, 'dsh-roost: 面板接口')

  /* ---------------- 启动 ---------------- */

  ctx.effect(() => {
    start()
    return () => stop()
  }, 'dsh-roost: 连接 Roost')

  ctx.effect(() => () => {
    map = readMap()
  }, 'dsh-roost: 收尾')
}
