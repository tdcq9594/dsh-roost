/**
 * 用假 ctx 跑一遍 apply，看激活时到底哪里炸。
 *
 * 为什么需要：DSH 里插件激活失败只会表现成「路由 404」，
 * 真实报错在 DSH 的日志里，不好找。这个 harness 直接把 apply() 跑起来，
 * 抛什么就打印什么。
 *
 * 跑法：node scripts/dry-run.mjs
 */

const regs = [];
const logs = [];

const noop = () => () => {};
const fakeCtx = {
  /* 声明在 inject 里的四个服务 */
  agents: {
    get: () => null,
    create: async () => ({ id: 'a1', ctx: { systemPrompt: { context: noop }, tools: {} } }),
    list: () => [],
  },
  sessions: {
    get: () => null,
    list: () => [],
    create: () => ({ id: 's1' }),
  },
  systemPrompt: {
    context: (o) => {
      logs.push(`systemPrompt.context: ${o?.name}`);
      return noop;
    },
  },
  webServer: {
    register: (r) => {
      regs.push(r.path);
      return noop;
    },
  },

  /* 核心能力 */
  config: {},
  logger: {
    info: (m) => logs.push(`info ${m}`),
    warn: (m) => logs.push(`warn ${m}`),
    error: (m) => logs.push(`error ${m}`),
    debug: () => {},
  },
  effect: (cb, label) => {
    const off = cb();
    return typeof off === 'function' ? off : noop;
  },
  on: () => noop,
  dataDir: 'C:/Users/q9079/.dsh/dsh-roost',
  dir: 'C:/Users/q9079/.dsh/dsh-roost',
  name: 'roost',
  path: 'C:/Users/q9079/.dsh/dsh-roost',
};

const host = await import('../src/host.js');
console.log('inject:', host.inject?.join(', ') || '(没声明)');

try {
  const off = host.apply(fakeCtx);
  console.log(`✓ apply 跑通，注册了 ${regs.length} 条路由`);
  console.log('  路由:', regs.slice(0, 8).join(' ') + (regs.length > 8 ? ' …' : ''));
  if (typeof off === 'function') off();
} catch (e) {
  console.error('✗ apply 抛错:', e?.message ?? e);
  if (e?.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exitCode = 1;
}

// apply 会真的去 bind 端口、起定时器，干跑完必须自己退出
setTimeout(() => process.exit(process.exitCode || 0), 300).unref?.();

if (logs.length) {
  console.log('\n日志:');
  for (const l of logs.slice(-15)) console.log('  ', l);
}
