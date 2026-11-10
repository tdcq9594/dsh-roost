#!/usr/bin/env node
/**
 * 16 项变异验证（方案 §12 / 门 G7）
 * ================================
 *
 * 每一项都是「故意改坏一处实现，跑对应测试，必须变红」。测不出红的项，
 * 说明那条断言只是摆设——这是唯一能证明「测试真的在守这条约束」的办法。
 *
 * 跑法：node scripts/mutate.mjs
 *       node scripts/mutate.mjs --only guard-tier,ns-acl
 *
 * 安全：每项先读原文到内存 → 写变异 → 跑测试 → `finally` 写回原文 →
 * 逐字节校验还原。中途 Ctrl+C 也可能留一个变异文件，所以每次启动先
 * 检查有没有 `.mutate-bak` 残留并自动还原。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BAK = join(ROOT, '.mutate-bak.json');

/** 每项：改哪个文件、把哪段换成哪段、跑哪个测试。 */
const MUTATIONS = [
  {
    id: 'guard-tier', label: '删 guard 档位判定（群友工具不再按档位收）',
    file: 'src/permissions.js',
    find: 'const deny = names.filter((n) => !keepSet.has(n));',
    replace: 'const deny = [];',
    test: ['test/permissions.test.js'],
  },
  {
    id: 'ns-acl', label: '删命名空间 ACL（档位不再限制写扩展记忆）',
    file: 'src/ext-memory.js',
    find: 'if (!canWriteExt({ extId, bucket: ctx.bucket, acl })) {',
    replace: 'if (false) {',
    test: ['test/ext-memory.test.js'],
  },
  {
    id: 'instructions-filter', label: '删 instructions 过滤（第三方说明进独立会话）',
    file: 'src/ext-usage.js',
    find: "const sections = out.sections.filter((s) => !String(s?.name ?? '').startsWith(prefix));",
    replace: 'const sections = out.sections;',
    test: ['test/ext-usage.test.js'],
  },
  {
    id: 'shadow-merge', label: '删启用 handler 的影子组合并（启用后群友断档）',
    file: 'src/host.js',
    /**
     * 整段一起删：只删 `seed.groups` 那一行没用 —— 后面的 `reconcile()` 会把
     * 缺失的影子组再补回来，最终状态看不出差别。这一段就是「合并逻辑」本体。
     */
    find: /const shadow = extGroups\.seedParts\(\);[\s\S]*?const fix = extGroups\.reconcile\(merged\);/, 
    replace: 'const merged = capStore.init(seed);\n              const fix = null;',
    test: ['test/routes.test.js'],
  },
  {
    id: 'loopback', label: '删回环校验（扩展清单可指向公网 url）',
    file: 'src/ext-registry.js',
    find: "if (m.transport === 'streamable-http' && !isLoopbackUrl(m.url)) {",
    replace: 'if (false) {',
    test: ['test/ext-registry.test.js'],
  },
  {
    id: 'idempotency', label: '去掉 requestId 幂等（重复投递重复执行）',
    file: 'src/api-v1.js',
    find: 'if (idemKey) {\n      const cached = cacheGet(idemKey, t);',
    replace: 'if (false) {\n      const cached = cacheGet(idemKey, t);',
    test: ['test/api-v1.test.js'],
  },
  {
    id: 'patch-backup', label: '受管块不做备份（写坏后无法回滚）',
    file: 'src/ext-patch.js',
    find: "fs.writeFileSync(bak, redactText(original), 'utf8');",
    replace: '/* MUTATION: 不做备份 */',
    test: ['test/ext-patch.test.js'],
  },
  {
    /**
     * §12 第「自动注入不得读 ext-memory/」项。
     *
     * ⚠️ 上一版这里有两个问题，自查时发现并修正：
     *  1. `find` 用的是 `const c = collectChat(m, chatId, aliases);` —— 这个串在
     *     `memory.js` 出现 3 次（`list` / `listRanked` / `listFull`），
     *     `String.replace` 只替第一处，**实际改的是 `list()` 而不是 `listRanked`**；
     *  2. 注入的代码是 `try { readFileSync(目录) } catch {}` —— 读目录必抛 EISDIR、
     *     被自己吞掉，**运行时零副作用**。它之所以「变红」，只是因为 G4-11 全文扫
     *     到了 `ext-memory` 这个字面量，属于文本级假红。
     *
     * 现在：锚点带后续两行保证唯一命中 `listRanked`，且注入真的会把扩展记忆
     * 混进自动注入结果，由行为断言（G4-11b）抓。
     */
    id: 'ranked-ext', label: '让 listRanked 误读 ext-memory/（隔离被破坏）',
    file: 'src/memory.js',
    find: [
      '      const c = collectChat(m, chatId, aliases);',
      '      return {',
      '        global: rank(m.global, m.meta.global, null),',
    ].join('\n'),
    replace: [
      '      const c = collectChat(m, chatId, aliases);',
      '      // MUTATION: 自动注入误读扩展记忆目录（变量拼路径，绕开全文文本扫描）',
      '      try {',
      "        const dirName = ['ext', 'memory'].join('-');",
      "        const leaked = readFileSync(join(dataDir(), dirName, 'bili.json'), 'utf8');",
      "        m.global.push('EXTLEAK:' + leaked.slice(0, 24));",
      '      } catch { /* ignore */ }',
      '      return {',
      '        global: rank(m.global, m.meta.global, null),',
    ].join('\n'),
    test: ['test/ext-memory-store.test.js'],
  },
  {
    id: 'deny-order', label: '删统一 deny 过滤（group: 引用逃逸）',
    file: 'src/capabilities.js',
    find: 'if (denyPatterns.length) {\n    allow = new Set([...allow].filter((n) => !denyPatterns.some((p) => matchPattern(n, p))));\n  }',
    replace: 'if (false) {\n    allow = new Set([...allow].filter((n) => !denyPatterns.some((p) => matchPattern(n, p))));\n  }',
    test: ['test/ext-permissions.test.js'],
  },
  {
    id: 'forceDeny-prescreen', label: '把 forceDeny 的 poolSet.has 预筛加回来（通配必失效）',
    file: 'src/capabilities.js',
    find: 'const forced = (Array.isArray(forceDeny) ? forceDeny : []).filter((x) => typeof x === \'string\' && x);',
    replace: "const forced = (Array.isArray(forceDeny) ? forceDeny : []).filter((x) => typeof x === 'string' && x).filter((n) => poolSet.has(n));",
    test: ['test/ext-permissions.test.js'],
  },
  {
    id: 'usage-in-agent', label: '把 usage section 注册到独立会话（污染）',
    file: 'src/agent-v1.js',
    find: 'offs.push(mountInstructionFilter(agentCtx));',
    replace: [
      'offs.push(mountInstructionFilter(agentCtx));',
      '    // MUTATION: usage 也挂到独立会话',
      '    {',
      "      const { mountUsageSections: mus } = await import('./ext-usage.js');",
      "      const u = mus(agentCtx, { list: () => [{ id: 'mut', manifest: { name: 'M', description: 'd' } }], liveUsage: () => 'mut' });",
      '      offs.push(() => u.dispose());',
      '    }',
    ].join('\n'),
    test: ['test/agent-v1.test.js'],
  },
  {
    id: 'extid-body', label: '让 extId 从请求体读（来源可自报）',
    file: 'src/api-v1.js',
    find: 'payload = { ...body, extId: client.extId ?? null };',
    replace: 'payload = { ...body };',
    test: ['test/api-v1.test.js'],
  },
  {
    /**
     * §12 原文是「固定 `.tmp` 名 → 同 extId 并发写丢更新」。实测：读-改-写全同步、
     * 写完立刻 rename，固定名在当前实现里**不会**丢更新（真正兜底的是串行队列）；
     * 删队列也不会（微任务仍串行）。所以约束降级为「临时名必须唯一」，
     * 由 G7-2 的静态断言守住。
     */
    id: 'fixed-tmp', label: '退回固定 .tmp 名（并发写会互相覆盖）',
    file: 'src/ext-memory-store.js',
    find: 'const tmp = join(root, `.${id}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);',
    replace: 'const tmp = join(root, `.${id}.tmp`);',
    test: ['test/ext-memory-store.test.js'],
  },
  {
    id: 'ref-normalize', label: '删 REF 规范化（含 - 的 id 撞官方规则）',
    file: 'src/ext-registry.js',
    find: "const ref = `ROOST_EXT_${String(id).toUpperCase().replace(/-/g, '_')}_TOKEN`;",
    replace: 'const ref = `ROOST_EXT_${String(id).toUpperCase()}_TOKEN`;',
    test: ['test/ext-registry.test.js'],
  },
  {
    id: 'launcher-token', label: '删 launcher 的 secrets 注入（真 server 拿不到令牌）',
    file: 'src/ext-launcher.mjs',
    find: 'childEnv.ROOST_API_TOKEN = token;',
    replace: "childEnv.ROOST_API_TOKEN = '';",
    test: ['test/ext-launcher.test.js'],
  },
  {
    id: 'managed-expr', label: '受管块放开 !!js / YAML tag（配置注入→代码执行）',
    file: 'src/ext-patch.js',
    /** 只删「记录」不删「检测」：hits 不再包含这条，assertManagedShape 就会放行。 */
    find: "hits.push('YAML tag / !!js 表达式');",
    replace: '/* MUTATION: 不记 YAML tag */',
    test: ['test/ext-patch.test.js'],
  },
];

/** 备份原子写：SIGKILL 落在写一半时，宁可没有 BAK 也不能留半截 JSON。 */
function saveBak(obj) {
  const tmp = `${BAK}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, BAK);
}

/**
 * 读备份。**解析失败不删**：那是唯一记录着「源码原文」的东西，
 * 删掉等于把变异后的代码永久留在工作树里。停下来让人看 git diff。
 */
function loadBak() {
  if (!fs.existsSync(BAK)) return {};
  const raw = fs.readFileSync(BAK, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`✗ 备份文件损坏，无法自动还原：${BAK}`);
    console.error('  里面本该记录被改过的源码原文。请先 git diff 确认源码是否被变异改动，处理完再删掉它。');
    process.exit(3);
  }
}

function restoreFromBak() {
  if (!fs.existsSync(BAK)) return;
  const saved = loadBak();
  for (const [rel, text] of Object.entries(saved)) {
    const file = join(ROOT, rel);
    fs.writeFileSync(file, text, 'utf8');
    // 还原也要逐字节校验：写失败/被占用时不能假装成功。
    if (fs.readFileSync(file, 'utf8') !== text) {
      console.error(`✗ 从残留备份还原后校验失败：${rel}`);
      process.exit(4);
    }
    console.log(`↩ 已从残留备份还原 ${rel}`);
  }
  fs.rmSync(BAK, { force: true });
}

/**
 * 跑一次测试，统一拿退出码 / 信号 / TAP 汇总。
 *
 * `execFileSync` 超时抛的错 `status` 是 `null`、`signal` 是 `SIGTERM` ——
 * 旧写法 `e.status ?? 1` 会把它当「变红」，等于把「跑太久」记成「断言守住了」。
 */
function runTests(testFiles) {
  try {
    const out = execFileSync(process.execPath, ['--test', ...testFiles], {
      cwd: ROOT, stdio: 'pipe', timeout: 180_000, encoding: 'utf8',
    });
    return { exit: 0, signal: null, out: String(out) };
  } catch (e) {
    return {
      exit: typeof e.status === 'number' ? e.status : null,
      signal: e.signal ?? null,
      out: `${e.stdout ?? ''}\n${e.stderr ?? ''}`,
    };
  }
}

const failCount = (out) => {
  const m = /^# fail (\d+)$/m.exec(out ?? '');
  return m ? Number(m[1]) : 0;
};

function runOne(m) {
  const file = join(ROOT, m.file);
  const original = fs.readFileSync(file, 'utf8');
  /**
   * 锚点按**文件实际行尾**适配。
   *
   * 仓库里 `src/*.js` 是 CRLF（Windows checkout），而多行锚点是用 `\n` 拼的；
   * 不适配就永远「找不到锚点」—— 上一版 `ranked-ext` 因此悄悄退回到单行锚点，
   * 结果命中了 `list()` 而不是 `listRanked`。单行锚点不受影响（不含换行）。
   */
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const fit = (s) => (eol === '\n' ? s : s.replace(/\n/g, '\r\n'));
  const find = typeof m.find === 'string' ? fit(m.find) : m.find;
  const replace = typeof m.replace === 'string' ? fit(m.replace) : m.replace;

  const hit = typeof find === 'string' ? original.includes(find) : find.test(original);
  if (!hit) return { ok: false, why: `找不到锚点（${m.file}）` };

  /**
   * **锚点必须恰好命中一次。**
   *
   * `String.replace` 只替第一处，所以「命中多处」不是小问题：它会静默改到
   * 一个不相干的同名行，测试照样变红、报告照样 ✓，实际守卫的那条约束
   * 一次都没被验证过（`ranked-ext` 就是这么假红了两个阶段）。
   */
  const hits = typeof find === 'string'
    ? original.split(find).length - 1
    : (original.match(new RegExp(find.source, find.flags.includes('g') ? find.flags : `${find.flags}g`)) || []).length;
  if (hits !== 1) {
    return { ok: false, why: `锚点在 ${m.file} 命中 ${hits} 次（必须恰好 1 次，否则会改错位置）` };
  }

  const mutated = original.replace(find, replace);
  if (mutated === original) return { ok: false, why: '替换后无变化' };

  // 先确认基线全绿：基线本来就红的话，「变异后仍红」毫无意义。
  const base = runTests(m.test);
  if (base.exit !== 0 || failCount(base.out) > 0) {
    return { ok: false, why: `基线不是全绿（exit=${base.exit}，fail=${failCount(base.out)}），先修基线` };
  }

  // 落一份「可能中断」的备份，异常退出后下次启动能自动还原
  const bak = loadBak();
  bak[m.file] = original;
  saveBak(bak);

  let r;
  try {
    fs.writeFileSync(file, mutated, 'utf8');
    r = runTests(m.test);
  } finally {
    fs.writeFileSync(file, original, 'utf8');
    if (fs.readFileSync(file, 'utf8') !== original) {
      console.error(`✗ ${m.file} 还原失败，立即停止`);
      process.exit(2);
    }
    const rest = loadBak();
    delete rest[m.file];
    if (Object.keys(rest).length) saveBak(rest);
    else fs.rmSync(BAK, { force: true });
  }

  // 只认「有断言失败」的真红：超时 / 进程被杀 / 语法错导致加载失败都不算。
  if (r.signal) return { ok: false, why: `测试进程被信号终止（${r.signal}），不算变红` };
  if (r.exit === null) return { ok: false, why: '拿不到退出码（可能超时），不算变红' };
  if (r.exit === 0) return { ok: false, why: '测试仍然全绿（断言没守住这条约束）' };
  if (failCount(r.out) === 0) return { ok: false, why: '退出码非 0 但没有任何断言失败（更像加载/语法错误）' };
  return { ok: true, exit: r.exit, fails: failCount(r.out), stderr: r.out.slice(-400) };
}

const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? new Set(String(process.argv[onlyArg + 1] ?? '').split(',').filter(Boolean)) : null;

restoreFromBak();

const picked = MUTATIONS.filter((m) => !only || only.has(m.id));
if (!picked.length) {
  console.error('没有匹配的变异项');
  process.exit(2);
}

console.log(`变异验证：${picked.length} 项（每项应让测试变红）\n`);
const bad = [];
for (const [i, m] of picked.entries()) {
  process.stdout.write(`[${i + 1}/${picked.length}] ${m.id} · ${m.label} … `);
  const r = runOne(m);
  if (r.ok) {
    console.log(`✓ 变红（exit ${r.exit}，${r.fails} 条断言失败）`);
  } else {
    console.log(`✗ ${r.why}`);
    bad.push({ id: m.id, why: r.why, stderr: r.stderr });
  }
}

console.log('');
if (bad.length) {
  console.error(`有 ${bad.length} 项没变红：`);
  for (const b of bad) console.error(`  ✗ ${b.id}: ${b.why}`);
  process.exit(1);
}
console.log(`全部 ${picked.length} 项均真跑变红。`);
