// 图库工具：模型侧的五只手（list / show / save / edit / remove）。
//
// 三个不能破的边界：
//   1. 工具返回值里**不能出现路径或 URL**——「不给链接」是这次需求的底线；
//   2. 写操作**只给主人**，且 execute 里再验一次（纵深防御）；
//   3. `show` 的图片块必须**原样**进返回内容——那是已登记的附件引用，
//      丢掉它等于「说好给看图结果只给了句话」。

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

/* ---------------------------- 看图 ---------------------------- */

/** 一个假附件引用。形状照 `admitPromptContent` 的返回，**小得不会触发 4 KB 预算** */
const REF = { type: 'image', attachment: { attachmentId: 'att_abc123', encodedBytes: 2048 } };

function withShow({ bucket = 'owner', turn = 't1', answer = {}, onCall } = {}) {
  const calls = [];
  const t = tools({
    bucket,
    over: {
      turnKeyOf: () => turn,
      showOf: async (o) => {
        calls.push(o);
        if (onCall) return onCall(o);
        return { ok: true, text: '#3 的图附在这条消息后面，你自己看。', blocks: [REF], ...answer };
      },
    },
  });
  return { ...t, calls };
}

test('没给 showOf 就不挂 gallery_show（不留一个永远失败的按钮）', () => {
  const { byName } = tools();
  assert.equal(byName.gallery_show, undefined);
});

test('gallery_show：图片块原样进内容，文字在前', async () => {
  const { byName } = withShow();
  const r = await byName.gallery_show.execute({ seq: '#3' });
  assert.equal(r.ok, true);
  assert.equal(r.seq, 3);

  const blocks = byName.gallery_show.output.render({}, r);
  assert.equal(blocks[0].type, 'text');
  assert.deepEqual(blocks[1], REF, '引用块必须原样带上，不能被改写或丢掉');
  /**
   * 附件引用必须小：DSH 有一个 4 KB 工具输出预算，超了会把**所有非文本块**
   * 丢掉（`ext-usage.js:truncateToolContent`）。如果哪天有人改成塞 base64，
   * 这条会立刻炸。
   */
  assert.ok(JSON.stringify(blocks).length < 4000, '整条返回要远小于 4 KB');
});

test('gallery_show：没有图片块时只回文字（视觉模型代看那条路）', async () => {
  const { byName } = withShow({ answer: { blocks: undefined, text: '画面上是一只熊猫在笑' } });
  const r = await byName.gallery_show.execute({ seq: '3' });
  const blocks = byName.gallery_show.output.render({}, r);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /熊猫/);
});

test('gallery_show：群友档拒绝，且不触发看图（那要花钱）', async () => {
  const { byName, calls } = withShow({ bucket: 'chat' });
  const r = await byName.gallery_show.execute({ seq: '3' });
  assert.equal(r.ok, false);
  assert.match(r.message, /主人和管理员/);
  assert.equal(calls.length, 0);
});

test('gallery_show：管理员可以看，主人可以看', async () => {
  for (const bucket of ['admin', 'owner']) {
    const { byName } = withShow({ bucket });
    assert.equal((await byName.gallery_show.execute({ seq: '3' })).ok, true, bucket);
  }
});

test('gallery_show：一轮最多看两张，第三张拒；换一轮又能看', async () => {
  /** 轮次键要能中途变，所以用一个盒子而不是闭包常量 */
  const box = { turn: 'turn-A' };
  const t = tools({
    over: {
      turnKeyOf: () => box.turn,
      showOf: async () => ({ ok: true, text: 'ok', blocks: [REF] }),
    },
  });
  assert.equal((await t.byName.gallery_show.execute({ seq: '1' })).ok, true);
  assert.equal((await t.byName.gallery_show.execute({ seq: '2' })).ok, true);
  const third = await t.byName.gallery_show.execute({ seq: '3' });
  assert.equal(third.ok, false);
  assert.match(third.message, /这一轮已经看过/);

  box.turn = 'turn-B';
  assert.equal((await t.byName.gallery_show.execute({ seq: '3' })).ok, true, '新的一轮不该被上一轮限制');
});

test('gallery_show：缺序号直接拒，不打 showOf', async () => {
  const { byName, calls } = withShow();
  assert.equal((await byName.gallery_show.execute({})).ok, false);
  assert.equal(calls.length, 0);
});

test('gallery_show：底层抛错回 ok:false，不把整轮带崩', async () => {
  const { byName } = withShow({ onCall: () => { throw new Error('附件服务挂了'); } });
  const r = await byName.gallery_show.execute({ seq: '3' });
  assert.equal(r.ok, false);
  assert.match(r.message, /附件服务挂了/);
});

test('gallery_show：把标注建议带出来，让模型自己决定要不要写回', async () => {
  const { byName } = withShow({
    answer: { blocks: undefined, suggest: { name: '熊猫', meaning: '在笑' } },
  });
  const r = await byName.gallery_show.execute({ seq: '3' });
  assert.deepEqual(r.suggest, { name: '熊猫', meaning: '在笑' });
});

test('gallery_edit 认 pinned="1"/"0"：固定是「配额满时不淘汰」，跟 enabled 分开', async () => {
  const { byName, calls } = tools();
  await byName.gallery_edit.execute({ seq: '3', pinned: '1' });
  /** 字符串 "1" 要转成布尔 true —— 模型给的都是字符串 */
  assert.equal(calls[0][2].pinned, true);

  await byName.gallery_edit.execute({ seq: '3', pinned: '0' });
  assert.equal(calls[1][2].pinned, false);

  /**
   * 两个字段一起给时不能互相覆盖：停用和固定是两个维度
   * （停用是「别发这张」，固定是「别删这张」）。
   */
  await byName.gallery_edit.execute({ seq: '3', enabled: '0', pinned: '1' });
  assert.deepEqual(calls[2][2], { enabled: false, pinned: true });
});
