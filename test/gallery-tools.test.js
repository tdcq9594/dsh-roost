// 图库工具：模型侧的四个手（list / save / edit / remove）。
//
// 两个不能破的边界：
//   1. 工具返回值里**不能出现路径或 URL**——「不给链接」是这次需求的底线；
//   2. 写操作**只给主人**，且 execute 里再验一次（纵深防御）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGalleryToolDefs } from '../src/gallery-tools.js';

const PATH = 'D:/表情/开心/熊猫.png';

function tools({ bucket = 'owner', over = {} } = {}) {
  const calls = [];
  const defs = buildGalleryToolDefs({
    listOf: (o) => {
      calls.push(['list', o]);
      return { ok: true, text: '#1  开心.png  熊猫大笑 · 用来接梗', total: 1, items: [{ seq: 1, path: PATH }] };
    },
    saveOf: (o) => {
      calls.push(['save', o]);
      return { ok: true, seq: 5, item: { seq: 5, path: PATH, file: '熊猫.png' }, dup: false };
    },
    editOf: (seq, patch) => {
      calls.push(['edit', seq, patch]);
      return { ok: true, item: { seq, name: patch.name ?? '' } };
    },
    removeOf: (seq) => {
      calls.push(['remove', seq]);
      return { ok: true };
    },
    callerOf: () => ({ bucket }),
    ...over,
  });
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  return { byName, calls };
}

test('四个工具都在，且都有 render（字符串会让 DSH 的 content.some 炸掉）', () => {
  const { byName } = tools();
  for (const n of ['gallery_list', 'gallery_save', 'gallery_edit', 'gallery_remove']) {
    assert.ok(byName[n], `缺 ${n}`);
    const blocks = byName[n].output.render({}, { ok: true, text: 'x' });
    assert.ok(Array.isArray(blocks) && blocks[0].type === 'text');
  }
});

test('gallery_list 把清单文本直接给模型，不带路径', async () => {
  const { byName, calls } = tools();
  const r = await byName.gallery_list.execute({ cat: '开心', n: '10', fresh: '1' });
  assert.equal(r.ok, true);
  assert.match(r.text, /#1/);
  assert.deepEqual(calls[0], ['list', { cat: '开心', n: '10', fresh: '1' }]);
  const rendered = byName.gallery_list.output.render({}, r);
  /** 文件名可以有（主人要的就是「序号 + 文件名」），路径不行 */
  assert.doesNotMatch(rendered[0].text, /D:\/表情|表情\/开心|[A-Za-z]:[\\/]/);
});

test('gallery_save 只给主人：群友档直接拒绝，且不落库', async () => {
  const { byName, calls } = tools({ bucket: 'chat' });
  const r = await byName.gallery_save.execute({ from: 'last' });
  assert.equal(r.ok, false);
  assert.match(r.message, /只对主人开放/);
  assert.equal(calls.length, 0, '拒绝时不能真去写库');
});

test('gallery_save 返回值里不能有 path，只给序号和文件名', async () => {
  const { byName } = tools();
  const r = await byName.gallery_save.execute({ from: 'last', name: '熊猫' });
  assert.equal(r.ok, true);
  assert.equal(r.seq, 5);
  assert.equal(r.file, '熊猫.png');
  assert.ok(!JSON.stringify(r).includes('表情/开心'), '路径一个字都不能漏');
});

test('gallery_edit 把 "#3" 和 "3" 都认成序号 3，enabled="0" 转 false', async () => {
  const { byName, calls } = tools();
  await byName.gallery_edit.execute({ seq: '#3', name: '猫' });
  assert.deepEqual(calls[0], ['edit', 3, { name: '猫' }]);

  await byName.gallery_edit.execute({ seq: '3', enabled: '0' });
  assert.equal(calls[1][2].enabled, false);

  await byName.gallery_edit.execute({ seq: '3', enabled: '1' });
  assert.equal(calls[2][2].enabled, true);
});

test('gallery_edit 只传白名单字段，乱塞的键不进去', async () => {
  const { byName, calls } = tools();
  await byName.gallery_edit.execute({ seq: '3', name: '猫', path: '/etc/passwd', seq2: 'x' });
  assert.deepEqual(Object.keys(calls[0][2]), ['name']);
});

test('gallery_edit 没给序号 / 没给字段都说清楚', async () => {
  const { byName, calls } = tools();
  assert.equal((await byName.gallery_edit.execute({ name: '猫' })).ok, false);
  assert.equal((await byName.gallery_edit.execute({ seq: '3' })).ok, false);
  assert.equal(calls.length, 0);
});

test('gallery_remove 非主人拒绝，主人成功', async () => {
  const a = tools({ bucket: 'chat' });
  assert.equal((await a.byName.gallery_remove.execute({ seq: '1' })).ok, false);
  assert.equal(a.calls.length, 0);

  const b = tools();
  const r = await b.byName.gallery_remove.execute({ seq: '#1' });
  assert.equal(r.ok, true);
  assert.deepEqual(b.calls[0], ['remove', 1]);
});

test('底层抛错时工具回 ok:false，不把整轮对话带崩', async () => {
  const { byName } = tools({
    over: {
      listOf: () => { throw new Error('磁盘炸了'); },
      saveOf: () => { throw new Error('磁盘炸了'); },
    },
  });
  const a = await byName.gallery_list.execute({});
  assert.equal(a.ok, false);
  assert.match(a.text, /磁盘炸了/);
  const b = await byName.gallery_save.execute({ from: 'last' });
  assert.equal(b.ok, false);
});

test('取不到身份时按「不是主人」处理', async () => {
  const { byName } = tools({
    over: { callerOf: () => { throw new Error('没有 speaker'); } },
  });
  const r = await byName.gallery_save.execute({ from: 'last' });
  assert.equal(r.ok, false);
});
