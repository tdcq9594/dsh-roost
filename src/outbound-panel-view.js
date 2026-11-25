/**
 * 出站策略面板中文视图——移植自 aurabot-beta src/host.js（TIER_VIEW/outboundPanelView）。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。
 * 纯函数：后端给 status，前端直接渲染 view，不必自己维护翻译表。
 */
const TIER_VIEW = {
    pass: { label: '不纳管（旧行为直发）', hint: '扩展想发就发，只记录不拦截，不经过主动发言决策。' },
    gate: { label: '门闸（该不该说由引擎定）', hint: '主动私聊主人要先过引擎判定；引擎说不发就不发，不会排队改约。' },
    broker: { label: '门闸 + 代发（能改约）', hint: '引擎可以压后再说；扩展提交的消息由宿主统筹投递。' },
  }
const SOURCE_STATE_VIEW = {
    configured: { label: '已配置未启用', tone: 'warn' },
    running: { label: '流程中', tone: 'ok' },
    ready: { label: '就绪', tone: 'ok' },
    error: { label: '出错', tone: 'bad' },
  }
  // P3：活跃策略下拉收拢为 purpose/auto（speakup 档已从服务与面板两侧移除；
  // 存量 'speakup' 由服务 setActivePolicy 与 /panel/outbound-policy 写入口归一化为 'purpose'）
const ACTIVE_VIEW = { auto: '自动（挑就绪的那个）', purpose: '目的引擎' }
const POLICY_NAME_VIEW = { purpose: '目的引擎' }
const LEDGER_STATE_VIEW = {
    pending: '待投递', sending: '发送中', sent: '已送达', dropped: '已丢弃',
    failed: '失败', uncertain: '结果未明', expired: '已过期', 'transport-queued': '已交由网关',
  }
export function outboundPanelView(status) {
    if (!status) {
      return {
        managed: false,
        headline: '尚未纳管',
        summary: '出站策略服务还没装配好，模块的主动私聊会照旧直接发出。',
        tier: null, tiers: [], sources: [], stats: [], ledger: [],
      }
    }
    const tierInfo = TIER_VIEW[status.tier] || TIER_VIEW.pass
    // 三种总体状态：未纳管 / 正常纳管 / 纳管出问题
    const sources = Object.entries(status.sources || {}).map(([name, s]) => {
      const st = SOURCE_STATE_VIEW[s.state] || { label: String(s.state || '未知'), tone: 'warn' }
      return {
        name,
        title: POLICY_NAME_VIEW[name] || name,
        state: s.state,
        stateLabel: st.label,
        tone: st.tone,
        reason: s.reason || '',
      }
    })
    const readyCount = sources.filter((s) => s.state === 'ready').length
    let headline
    let summary
    let tone
    if (status.tier === 'pass') {
      headline = '尚未纳管'
      summary = '当前档位是「不纳管」：扩展模块想私聊你就直接发，不经过主动发言决策。想让它们守规矩，把档位改成「门闸」或「门闸 + 代发」。'
      tone = 'warn'
    } else if (!sources.length) {
      headline = '没有可用的策略源'
      summary = '档位已经开了，但目的引擎还没启用，没有人来决定该不该说。先去把目的引擎打开。'
      tone = 'warn'
    } else if (status.managed) {
      headline = '已纳管'
      summary = `主动私聊主人会先问「${POLICY_NAME_VIEW[status.activePolicy] || status.activePolicy || '引擎'}」的意见，它说此刻不适合开口就不发。`
      tone = 'ok'
    } else {
      const bad = sources.find((s) => s.state === 'error')
      headline = '纳管异常'
      summary = bad
        ? `策略源「${bad.title}」出错了（${bad.reason || '未说明原因'}），这期间主动私聊会被拦下而不是放行。`
        : '档位已经开了，但策略源还没就绪，这期间主动私聊会被拦下而不是放行。'
      tone = 'bad'
    }
    const stats = [
      ['经过判定', status.stats?.admitted ?? 0, '有主动发送请求进入判定的次数'],
      ['放行', status.stats?.allowed ?? 0, '最终允许发出的次数'],
      ['拦下', status.stats?.denied ?? 0, '被引擎否掉的次数'],
      ['未纳管放行', status.stats?.passThrough ?? 0, '不归治理范围、直接放行的次数'],
      ['账本待投递', status.ledger?.pending ?? 0, '已提交但还没发出去的'],
    ].map(([label, value, hint]) => ({ label, value, hint }))
    const ledger = Object.entries(status.ledger?.byState || {})
      .filter(([, n]) => n > 0)
      .map(([state, n]) => ({ state, label: LEDGER_STATE_VIEW[state] || state, count: n }))
    return {
      managed: status.managed,
      tone,
      headline,
      summary,
      tier: status.tier,
      tierLabel: tierInfo.label,
      tierHint: tierInfo.hint,
      tiers: Object.entries(TIER_VIEW).map(([value, v]) => ({ value, label: v.label, hint: v.hint, selected: value === status.tier })),
      activePolicy: status.activePolicy || null,
      activeMode: status.activeMode || 'auto',
      activeLabel: ACTIVE_VIEW[status.activeMode] || status.activeMode || '自动',
      activeOptions: Object.entries(ACTIVE_VIEW).map(([value, label]) => ({ value, label, selected: value === (status.activeMode || 'auto') })),
      readyCount,
      sourceCount: sources.length,
      sources,
      stats,
      ledger,
    }
  }
