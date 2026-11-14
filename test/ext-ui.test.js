// 扩展界面：声明式视图（6.1）+ 自带页面 / 表单 / 按钮（2026-11-14 放宽）。
// 自带页面走 iframe，路径仍卡在扩展目录内；表单与按钮都是声明，不是能力。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeUiSpec, normalizeFields, projectRow, projectRows, readUiData,
  UI_KINDS, UI_GROUPS, MAX_ROWS, MAX_UI_BYTES, MAX_UI_ACTIONS,
} from '../src/ext-ui.js';
import { validateManifest } from '../src/ext-registry.js';

const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ } };
const tmp = () => mkdtempSync(join(tmpdir(), 'roost-extui-'));

const okSpec = {
  nav: { label: '刷 B 站' },
  view: {
    kind: 'cards',
    source: { file: 'ui-data.json' },
    fields: ['title', { key: 'url', label: '链接', type: 'url' }],
  },
};

test('三种 kind 与四个分组是闭集，别的写法一律拒', () => {
  assert.deepEqual(UI_KINDS, ['table', 'cards', 'list', 'log']);
  assert.deepEqual(UI_GROUPS, ['home', 'self', 'express', 'group', 'power', 'mods', 'system']);

  const bad = normalizeUiSpec({ ...okSpec, view: { ...okSpec.view, kind: 'iframe' } });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('；'), /kind 只能是/);

  const badGroup = normalizeUiSpec({ nav: { label: 'x', group: '随便' }, view: okSpec.view });
  assert.match(badGroup.errors.join('；'), /group 只能是/);

  /** 中文别名也认：手写 plugin.json 时更可能写「群聊」 */
  const zh = normalizeUiSpec({ nav: { label: 'x', group: '群聊' }, view: okSpec.view });
  assert.equal(zh.ok, true, zh.errors.join('；'));
  assert.equal(zh.spec.nav.group, 'group');
});

test('没声明 ui 是合法的（多数扩展没有界面）', () => {
  const r = normalizeUiSpec(undefined);
  assert.equal(r.ok, true);
  assert.equal(r.spec, null);
});

test('数据文件必须是扩展目录内的相对路径', () => {
  for (const file of ['../x.json', '/etc/passwd', 'C:\\x.json', 'a/../../x.json']) {
    const r = normalizeUiSpec({ ...okSpec, view: { ...okSpec.view, source: { file } } });
    assert.equal(r.ok, false, `${file} 应该被拒`);
  }
  const good = normalizeUiSpec(okSpec);
  assert.equal(good.ok, true, good.errors.join('；'));
  assert.equal(good.spec.view.source.file, 'ui-data.json');
  assert.equal(good.spec.nav.group, 'mods', 'group 不填默认挂在「扩展」下');
});

test('字段名不许带 __proto__ 这类危险键', () => {
  const r = normalizeFields(['ok', '__proto__', 'constructor', '带空格 key', 'a'.repeat(50)]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.fields.map((f) => f.key), ['ok']);
  assert.equal(r.errors.length, 4);
});

test('字段最多 20 个，label 默认用 key', () => {
  const many = normalizeFields(Array.from({ length: 22 }, (_, i) => `f${i}`));
  assert.match(many.errors.join('；'), /最多 20 个/);

  const one = normalizeFields(['title']);
  assert.equal(one.fields[0].label, 'title');
  assert.equal(one.fields[0].type, 'text');
});

test('取值只保留白名单字段，嵌套对象直接丢掉', () => {
  const fields = [{ key: 'title', type: 'text' }, { key: 'n', type: 'number' }];
  const row = projectRow({ title: '标题', n: '12', secret: '不该出现', nested: { a: 1 } }, fields);
  assert.deepEqual(Object.keys(row).sort(), ['n', 'title']);
  assert.equal(row.n, 12);
  assert.equal(row.secret, undefined, '没声明的字段一个都不能给前端');
});

test('url 字段只认 http/https，javascript: 与 data: 一律清空', () => {
  const f = [{ key: 'u', type: 'url' }];
  assert.equal(projectRow({ u: 'https://b23.tv/x' }, f).u, 'https://b23.tv/x');
  assert.equal(projectRow({ u: 'HTTP://a.b' }, f).u, 'HTTP://a.b');
  assert.equal(projectRow({ u: 'javascript:alert(1)' }, f).u, '');
  assert.equal(projectRow({ u: 'data:text/html,<script>' }, f).u, '');
});

test('长字符串截断到 500 字，数组当空串', () => {
  const f = [{ key: 't', type: 'text' }];
  assert.equal(projectRow({ t: 'x'.repeat(1000) }, f).t.length, 500);
  assert.equal(projectRow({ t: [1, 2] }, f).t, '');
});

test('行数封顶，脏元素跳过而不是整页空白', () => {
  const rows = Array.from({ length: MAX_ROWS + 20 }, (_, i) => ({ t: `r${i}` }));
  rows.splice(3, 0, null, 'not-an-object', [1, 2]);
  const out = projectRows(rows, [{ key: 't' }]);
  assert.equal(out.length, MAX_ROWS);
  assert.equal(out[0].t, 'r0');
});

test('读数据：正常读回 rows 与 updatedAt，并按白名单过滤', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'ui-data.json'), JSON.stringify({
      updatedAt: 1700000000000,
      rows: [{ title: '视频 A', url: 'https://b23.tv/a', extra: 'x' }, { title: '视频 B' }],
    }), 'utf8');
    const spec = normalizeUiSpec(okSpec).spec;
    const r = readUiData({ dir, spec });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.rows.length, 2);
    assert.equal(r.updatedAt, 1700000000000);
    assert.deepEqual(Object.keys(r.rows[0]).sort(), ['title', 'url']);
    assert.equal(r.truncated, false);
  } finally { cleanup(dir); }
});

test('读数据：顶层数组也收，updatedAt 退回文件 mtime', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'ui-data.json'), JSON.stringify([{ title: 'A' }]), 'utf8');
    const r = readUiData({ dir, spec: normalizeUiSpec(okSpec).spec });
    assert.equal(r.ok, true);
    assert.ok(r.updatedAt > 0);
  } finally { cleanup(dir); }
});

test('读数据：文件不存在 / 不是 JSON / 太大 / 越界 都给具体原因', () => {
  const dir = tmp();
  try {
    const spec = normalizeUiSpec(okSpec).spec;
    assert.match(readUiData({ dir, spec }).reason, /还没有数据文件/);

    writeFileSync(join(dir, 'ui-data.json'), '{坏 json', 'utf8');
    assert.match(readUiData({ dir, spec }).reason, /不是合法 JSON/);

    writeFileSync(join(dir, 'ui-data.json'), JSON.stringify({ rows: [] }), 'utf8');
    assert.match(readUiData({ dir, spec, maxBytes: 5 }).reason, /太大/);

    /** 绕过字符串检查的越界路径（`a/../../x`）：解析后必须被第二道挡住 */
    const escape = { view: { source: { file: 'sub/../../outside.json' }, fields: [] } };
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, '..', 'outside.json'), '{"rows":[]}', 'utf8');
    assert.match(readUiData({ dir, spec: escape }).reason, /扩展目录外面/);
  } finally { cleanup(dir); }
});

test('读数据：既不是数组也没有 rows 时报错，不猜', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'ui-data.json'), JSON.stringify({ list: [1] }), 'utf8');
    assert.match(readUiData({ dir, spec: normalizeUiSpec(okSpec).spec }).reason, /既不是数组/);
  } finally { cleanup(dir); }
});

test('清单校验：ui 写坏了装不上，写对了能过', () => {
  const base = {
    api: 1, kind: 'dsh-extension', id: 'demo-ui', serverName: 'demo-ui',
    name: '演示', description: '带界面的演示', transport: 'stdio', command: 'node',
  };
  const good = validateManifest({ ...base, ui: okSpec }, { expectedId: 'demo-ui' });
  assert.equal(good.ok, true, (good.errors || []).join('；'));

  const bad = validateManifest({
    ...base, ui: { nav: { label: '这个页名实在是太长了根本放不下' }, view: okSpec.view },
  }, { expectedId: 'demo-ui' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('；'), /nav\.label/);
});

test('放宽：list 形态与「概览」分组都认', () => {
  const r = normalizeUiSpec({
    nav: { label: '清单', group: '概览' },
    view: { kind: 'list', source: { file: 'd.json' }, fields: ['a'] },
  });
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.spec.view.kind, 'list');
  assert.equal(r.spec.nav.group, 'home', '「概览」归一成 home');
});

test('放宽：tag / image / progress / time 四种新类型', () => {
  const fields = [
    { key: 't', type: 'tag' },
    { key: 'img', type: 'image' },
    { key: 'p', type: 'progress' },
    { key: 'at', type: 'time' },
  ];
  const row = projectRow({
    t: '热门', img: 'https://i0.hdslb.com/x.jpg', p: 130, at: 1700000000000,
  }, fields);
  assert.equal(row.t, '热门', 'tag 仍是字符串');
  assert.equal(row.img, 'https://i0.hdslb.com/x.jpg', 'image 只放 http(s)');
  assert.equal(row.p, 100, 'progress 夹到 0–100');
  assert.equal(row.at, 1700000000000, 'time 保留毫秒数，由前端本地化');

  assert.equal(projectRow({ img: 'file:///c:/x.png' }, [{ key: 'img', type: 'image' }]).img, '',
    'file:// 也要清掉');
  assert.equal(projectRow({ p: 'abc' }, [{ key: 'p', type: 'progress' }]).p, null);
});

test('自带页面：ui.page 可以替代 view，路径必须落在扩展目录内', () => {
  const ok = normalizeUiSpec({ nav: { label: '刷 B 站' }, page: 'ui/index.html' });
  assert.equal(ok.ok, true);
  assert.equal(ok.spec.page, 'ui/index.html');
  assert.equal(ok.spec.view, null, '没有 view 时不能给个空壳对象');

  for (const bad of ['../x.html', '/etc/x.html', 'C:/x.html', 'ui/x.js', 'a/../b.html']) {
    assert.equal(normalizeUiSpec({ nav: { label: 'x' }, page: bad }).ok, false, `${bad} 应被拒`);
  }
  assert.equal(normalizeUiSpec({ nav: { label: 'x' } }).ok, false, 'view 和 page 一个都没有');
});

test('表单声明：true / 数组 / 对象三种写法，保留字与空 key 拒', () => {
  const base = { nav: { label: 'x' }, page: 'ui/index.html' };
  assert.equal(normalizeUiSpec({ ...base, form: true }).spec.form.enabled, true);
  assert.deepEqual(normalizeUiSpec({ ...base, form: ['cookie', 'pushOwner'] }).spec.form.keys, ['cookie', 'pushOwner']);
  const obj = normalizeUiSpec({ ...base, form: { title: '设置', keys: ['cookie'] } });
  assert.equal(obj.spec.form.title, '设置');
  assert.equal(normalizeUiSpec({ ...base, form: ['__proto__'] }).ok, false);
  assert.equal(normalizeUiSpec({ ...base, form: 'yes' }).ok, false);
  assert.equal(normalizeUiSpec({ ...base }).spec.form.enabled, false, '没写就是关');
});

test('进程内运行时：必须给 .mjs 入口，路径卡在扩展目录内', () => {
  const base = { nav: { label: 'x' }, page: 'ui/index.html' };
  const ok = normalizeUiSpec({ ...base, runtime: 'inprocess', entry: 'ui/main.mjs' });
  assert.equal(ok.ok, true);
  assert.equal(ok.spec.runtime, 'inprocess');
  assert.equal(ok.spec.entry, 'ui/main.mjs');
  assert.equal(normalizeUiSpec(base).spec.runtime, 'mcp', '不写默认走队列');

  assert.equal(normalizeUiSpec({ ...base, runtime: 'inprocess' }).ok, false, '缺 entry');
  assert.equal(normalizeUiSpec({ ...base, runtime: 'inprocess', entry: 'ui/main.txt' }).ok, false);
  assert.equal(normalizeUiSpec({ ...base, runtime: 'inprocess', entry: '../x.mjs' }).ok, false);
  assert.equal(normalizeUiSpec({ ...base, runtime: 'magic' }).ok, false);
});

test('按钮声明：只认 {id,label}，重复与超长都拒', () => {
  const base = { nav: { label: 'x' }, page: 'ui/index.html' };
  const ok = normalizeUiSpec({
    ...base,
    actions: [{ id: 'feed_now', label: '现在刷一轮' }, { id: 'refresh_hot', label: '刷新热门', confirm: true }],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.spec.actions.map((a) => a.id), ['feed_now', 'refresh_hot']);
  assert.equal(ok.spec.actions[1].confirm, true);

  assert.equal(normalizeUiSpec({ ...base, actions: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }).ok, false);
  assert.equal(normalizeUiSpec({ ...base, actions: [{ id: 'a', label: '这个标签实在是太长放不下了' }] }).ok, false);
  assert.equal(normalizeUiSpec({ ...base, actions: [{ id: 'a b', label: 'x' }] }).ok, false);
  assert.equal(normalizeUiSpec({ ...base, actions: 'feed_now' }).ok, false);
  assert.deepEqual(normalizeUiSpec(base).spec.actions, [], '没写就是没有按钮');
});

test('按钮上限翻倍到 16：9 个动作的扩展不该被判清单不合格', () => {
  const base = { nav: { label: 'x' }, page: 'ui/index.html' };
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, label: `按钮${i}` }));

  assert.equal(MAX_UI_ACTIONS, 16, '8 → 16（主人：「也翻倍吧」）');
  /** B 站插件现在正好 9 个动作，原来 8 的上限会把整个扩展从导航里藏掉 */
  const nine = normalizeUiSpec({ ...base, actions: mk(9) });
  assert.equal(nine.ok, true, '9 个动作必须过');
  assert.equal(nine.spec.actions.length, 9);
  assert.equal(normalizeUiSpec({ ...base, actions: mk(16) }).ok, true, '正好 16 个也过');

  const over = normalizeUiSpec({ ...base, actions: mk(17) });
  assert.equal(over.ok, false, '17 个还是要拦');
  assert.match(over.errors.join(' '), /ui.actions 最多 16 个/);
});
