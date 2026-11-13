// 记忆数据扩展 + 逐条编辑：老库逐字不变、编辑不丢元数据、归档/复习/层级生效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIENT = new URL('../client/client.js', import.meta.url);

function boot({ seed = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-mem-edit-'));
  mkdirSync(dir, { recursive: true });
  if (seed) writeFileSync(join(dir, 'memory.json'), JSON.stringify(seed), 'utf8');
  process.env.DSH_ROOST_DATA = dir;
  return { dir };
}

/** 每次重新 import，让 dataDir 的缓存跟着新的 DSH_ROOST_DATA 走 */
async function freshMemory() {
  const url = new URL('../src/memory.js', import.meta.url);
  url.searchParams.set('t', String(Date.now()) + Math.random());
  return import(url.href);
}

test('老库逐字不变：没有扩展字段时 scoreOfFact 与扩展前一致', async () => {
  const { scoreOfFact } = await freshMemory();
  const now = Date.UTC(2026, 10, 13);
  const cases = [
    [{ w: 1, at: now }, 1],
    [{ w: 3, at: now }, 3],
    [{ w: 2, at: now - 30 * 86400000 }, 1],          // 30 天半衰期
    [{ w: 4, at: now - 60 * 86400000 }, 1],
    [{ w: 2, at: now - 30 * 86400000, until: now }, 0.5],
    [{}, 1],                                          // 无元数据也不衰减
  ];
  for (const [meta, want] of cases) {
    assert.ok(Math.abs(scoreOfFact(meta, now) - want) < 1e-9,
      `scoreOfFact(${JSON.stringify(meta)}) 应是 ${want}，实际 ${scoreOfFact(meta, now)}`);
  }
});

test('扩展字段生效：pin / tier / 复习 / 归档都改变分数与亮度', async () => {
  const { scoreOfFact, brightnessOf, factIdOf, FACT_TIERS } = await freshMemory();
  const now = Date.UTC(2026, 10, 13);
  const old = { w: 1, at: now - 30 * 86400000 };
  const base = scoreOfFact(old, now);
  assert.ok(scoreOfFact({ ...old, pin: 1 }, now) > base, '重要度高的排前面');
  assert.ok(scoreOfFact({ ...old, tier: 'core' }, now) > base, '永久不衰减');
  assert.ok(scoreOfFact({ ...old, tier: 'short' }, now) < base, '临时衰减更快');
  assert.ok(scoreOfFact({ ...old, reviewedAt: now }, now) > base, '复习把衰减起点拉回来');
  assert.ok(scoreOfFact({ ...old, archivedAt: now }, now) < base, '归档打折');
  assert.ok(brightnessOf({ ...old, pin: 1, reviewedAt: now }, now) > brightnessOf(old, now));
  assert.ok(brightnessOf({}, now) >= 0.15 && brightnessOf({}, now) <= 1);
  assert.deepEqual(FACT_TIERS, ['short', 'long', 'core']);
  assert.equal(factIdOf('主人住在杭州'), factIdOf('主人住在杭州'));
  assert.notEqual(factIdOf('主人住在杭州'), factIdOf('主人住在上海'));
});

test('editFact：改正文时 w/at/src/until 全部保留，id 换新', async () => {
  boot();
  const { createMemory, factIdOf } = await freshMemory();
  const m = createMemory();
  const at = Date.now() - 10 * 86400000;
  m.add('CHAT_A', '主人住在杭州', 'chat', { w: 3, src: { manual: true, at } });
  const before = m.listFull('CHAT_A', []).chat.find((x) => x.text === '主人住在杭州');
  assert.equal(before.w, 3);
  assert.equal(before.src.manual, true);

  const r = m.editFact('CHAT_A', 'chat', factIdOf('主人住在杭州'), { text: '主人搬到上海了' }, []);
  assert.equal(r.ok, true);
  assert.equal(r.text, '主人搬到上海了');
  const after = m.listFull('CHAT_A', []).chat.find((x) => x.text === '主人搬到上海了');
  assert.equal(after.w, 3, '权重不能丢');
  assert.equal(after.src.manual, true, '出处不能丢');
  assert.equal(after.at, before.at, '时间不能丢');
  assert.equal(m.list('CHAT_A', []).chat.includes('主人住在杭州'), false, '旧正文要换掉');
  assert.equal(m.list('CHAT_A', []).chat.includes('主人搬到上海了'), true);
  assert.notEqual(after.id, factIdOf('主人住在杭州'), '编辑后 id 自然换新');
});

test('editFact：复习 / 层级 / 归档 / 恢复，且归档不进注入', async () => {
  boot();
  const { createMemory } = await freshMemory();
  const m = createMemory();
  m.add('', '猫怕黄瓜', 'global', { w: 2 });
  const key = '猫怕黄瓜';

  assert.equal(m.editFact('', 'global', key, { reviewedAt: Date.now() }, []).ok, true);
  assert.ok(m.listFull('', []).global[0].reviewedAt > 0);

  assert.equal(m.editFact('', 'global', key, { tier: 'core' }, []).ok, true);
  assert.equal(m.listFull('', []).global[0].tier, 'core');
  assert.equal(m.editFact('', 'global', key, { tier: '乱写' }, []).ok, false, '非法层级要拒');

  assert.equal(m.editFact('', 'global', key, { archivedAt: Date.now() }, []).ok, true);
  assert.ok(m.listFull('', []).global[0].archivedAt > 0);
  assert.equal(m.list('', []).global.includes(key), false, '归档的不注入');
  assert.equal(m.listRanked('', []).global.includes(key), false, '排序里也不能出现');

  assert.equal(m.editFact('', 'global', key, { archivedAt: 0 }, []).ok, true);
  assert.equal(m.listFull('', []).global[0].archivedAt, null, '恢复要清掉归档标记');
  assert.equal(m.list('', []).global.includes(key), true, '恢复后重新注入');
});

test('editFact：定位只认精确正文或 id，绝不模糊匹配', async () => {
  boot();
  const { createMemory } = await freshMemory();
  const m = createMemory();
  m.add('', '约定：A', 'global');
  m.add('', '约定：A 补充', 'global');
  assert.equal(m.editFact('', 'global', '约定', { tier: 'core' }, []).ok, false, '关键词不能命中');
  assert.equal(m.editFact('', 'global', '不存在的一句', { tier: 'core' }, []).ok, false);
  assert.equal(m.editFact('', 'global', '约定：A', { text: '' }, []).ok, false, '空正文要拒');
  assert.equal(m.editFact('', 'global', '约定：A', { text: '约定：A 补充' }, []).ok, false, '改成已有句子要拒');
});

test('路由 /memory/fact 已注册，前端确实调用它', async () => {
  const { readFileSync } = await import('node:fs');
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const client = readFileSync(CLIENT, 'utf8');
  assert.ok(host.includes("route('/memory/fact'"), '后端路由要注册');
  assert.ok(client.includes("'/memory/fact'"), '前端要有入口');
  assert.ok(client.includes('打开记忆星图'), '原位置要有入口按钮');
  assert.ok(client.includes('h(PageModal, { title: \'记忆星图\''), '星图要在弹窗里');
  assert.ok(client.includes("action: 'update'") || client.includes("factAct('update'"), '要有编辑动作');
  assert.ok(client.includes("factAct('review'"), '要有复习动作');
  assert.ok(client.includes("factAct('tier'") || client.includes("{ tier: 'core' }"), '要有层级');
});

test('弹窗按需渲染：关闭时不挂 StarMap，打开才挂', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(CLIENT, 'utf8');
  /** starOpen 为 false 时条件渲染为 null，StarMap 只能出现在弹窗分支里 */
  const idxBtn = client.indexOf('打开记忆星图');
  const idxModal = client.indexOf('h(PageModal, { title: \'记忆星图\'');
  const idxStar = client.indexOf('h(StarMap, {');
  assert.ok(idxBtn > 0 && idxModal > idxBtn, '按钮要在弹窗之前');
  assert.ok(idxStar > idxModal, 'StarMap 必须只在弹窗分支里渲染');
});


test('加一颗：/memory/add 认 text，且能带重要度与层级（以前恒 400 缺 fact）', async () => {
  boot();
  const { createMemory } = await freshMemory();
  const m = createMemory();
  assert.equal(m.add('', '带重要度的事实', 'global', { w: 2, pin: 0.8, tier: 'core' }), true);
  const row = m.listFull('', []).global.find((x) => x.text === '带重要度的事实');
  assert.equal(row.pin, 0.8, '重要度要写进 meta');
  assert.equal(row.tier, 'core', '层级要写进 meta');

  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.ok(host.includes('body.fact ?? body.text'), '/memory/add 必须兼容前端传的 text');
  assert.ok(host.includes('patch.pin = Number(body.importance'), '要接重要度');
  const client = readFileSync(CLIENT, 'utf8');
  assert.ok(client.includes('fact: text, text, scope: addScope'), '前端要同时传 fact 与 text');
  assert.ok(client.includes("value: addImp"), '加一颗要有重要度输入');
  assert.ok(client.includes("value: addTier"), '加一颗要有层级下拉');
});

test('星图筛选：层级只作用于事实，不把日记/人物一起筛掉', async () => {
  const src = readFileSync(CLIENT, 'utf8');
  let mod = null;
  const rt = (() => {
    const hooks = []; let i = 0;
    return {
      reset() { i = 0; hooks.length = 0; },
      React: {
        createElement: (t, p, ...c) => ({ type: t, props: { ...(p || {}), children: c } }),
        useState: (v) => { const k = i++; if (!(k in hooks)) hooks[k] = typeof v === 'function' ? v() : v; return [hooks[k], () => {}]; },
        useEffect: () => { i++; }, useCallback: (f) => { i++; return f; },
        useRef: (v) => { const k = i++; if (!(k in hooks)) hooks[k] = { current: v }; return hooks[k]; },
        Fragment: 'f',
      },
    };
  })();
  const win = { __ModuleLoader__: { load: (cfg) => { mod = cfg.factory((n) => (n === 'react' ? rt.React : {})); } } };
  new Function('window', src)(win);
  const stars = [
    { id: 'a', kind: 'fact', tier: 'short', group: 'global', brightness: 0.9, text: '临时事实' },
    { id: 'b', kind: 'fact', tier: 'core', group: 'global', brightness: 0.8, text: '永久事实' },
    { id: 'c', kind: 'episode', group: 'episode', brightness: 0.7, text: '日记' },
  ];
  const core = mod.filterStars(stars, { tier: 'core' }).stars.map((x) => x.id);
  assert.deepEqual(core, ['b'], '选永久只留永久事实');
  const all = mod.filterStars(stars, {}).stars.length;
  assert.equal(all, 3, '不选层级时全都留');
});

test('星图工具条：层级筛选 / 关系线三档 / 星星列表都在', async () => {
  const src = readFileSync(CLIENT, 'utf8');
  for (const must of ['全部层级', '只在选中时', '微光', '标准', '强度', '或从下面直接点一颗']) {
    assert.ok(src.includes(must), `缺「${must}」`);
  }
});


test('非事实节点：档案单条删除、实体连同关系一起删', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-node-'));
  mkdirSync(dir, { recursive: true });
  process.env.DSH_ROOST_DATA = dir;
  const { createProfiles } = await import('../src/profiles.js');
  const { createGraph } = await import('../src/graph.js');

  const pf = createProfiles({ file: join(dir, 'profiles.json'), log: () => {} });
  pf.note({ who: '阿岚', openid: 'OPENID_A', impression: '爱发图' });
  pf.note({ who: '大肥鱼', openid: 'OPENID_B', impression: '话少' });
  assert.equal(pf.size, 2);
  assert.equal(pf.forget('openid_a'), true, 'key 统一小写，要能命中');
  assert.equal(pf.size, 1, '只删这一条');
  assert.equal(pf.forget('不存在的人'), false);

  const g = createGraph({ file: join(dir, 'graph.sqlite'), log: () => {} });
  g.addEdge({ src: '阿岚', dst: '猫', rel: '喜欢', chatId: '' });
  g.addEdge({ src: '猫', dst: '竹子', rel: '认识', chatId: '' });
  assert.ok(g.entities({ chatId: '', limit: 20 }).length >= 3);
  const r = g.removeEntity('阿岚', { chatId: '' });
  assert.equal(r.ok, true);
  assert.ok(r.edges >= 1, '连着的关系边要一起删');
  const left = g.entities({ chatId: '', limit: 20 }).map((x) => x.name);
  assert.equal(left.includes('阿岚'), false, '实体要删掉');
  assert.equal(left.includes('猫'), true, '别的实体不能误删');
  assert.equal(g.nowEdges({ chatId: '', limit: 20 }).length, 1, '只剩猫—竹子那条');
  g.close();
});

test('路由 /memory/node 与星图非事实按钮都在', async () => {
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const client = readFileSync(CLIENT, 'utf8');
  assert.ok(host.includes("route('/memory/node'"), '后端要有非事实节点路由');
  for (const k of ["'episode'", "'entity'", "'profile'"]) {
    assert.ok(host.includes(k), `路由要处理 ${k}`);
  }
  for (const must of ['作废这条日记', '删掉这个实体（连同关系）', '忘掉这个人']) {
    assert.ok(client.includes(must), `星图详情缺「${must}」`);
  }
  assert.ok(client.includes("post('/memory/node'"), '前端要真的调它');
});

test('记忆页：长分节默认折叠 + 分层统计卡', async () => {
  const client = readFileSync(CLIENT, 'utf8');
  for (const must of ["title: '日记', defaultOpen: false", "title: '她知道的关系', defaultOpen: false", "title: '召回记录', defaultOpen: false"]) {
    assert.ok(client.includes(must), `缺默认折叠：${must}`);
  }
  for (const must of ['分层与遗忘', '临时：15 天减半', '快忘了']) {
    assert.ok(client.includes(must), `缺「${must}」`);
  }
});
