// 表情包库：标签、分类、清单、挑图。
//
// 这几条以前完全没有测试——`stickers.js` 是「跑起来看着对」就没人管的那种模块。
// 而它错了的表现全是**群里的尴尬**：发错图、连着发同一张、清单里出现一个叫 `(1)`
// 的标签。这些都只能在聊天记录里发现，所以必须在这里挡住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createStickers,
  tagsOf,
  parseSidecar,
  MAX_BYTES,
} from '../src/stickers.js';
import { buildStickerToolDefs, registerStickerTools } from '../src/sticker-tools.js';

/** 建一个临时库，files 是「相对路径 → 内容」 */
function makeLib(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-stk-'));
  const dir = path.join(root, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body ?? 'x');
  }
  return { root, dir, stickers: createStickers({ dataDir: root, cacheMs: 0 }) };
}

test('标签：分隔符、括号序号、纯数字', () => {
  assert.deepEqual(tagsOf('开心_猫.png'), ['开心', '猫']);
  assert.deepEqual(tagsOf('猫猫 无语-2.gif'), ['猫猫', '无语']);
  // 以前 `(1)` 会被当成正经标签写进提示词
  assert.deepEqual(tagsOf('联动壁纸 (1).png'), ['联动壁纸']);
  // 纯数字是序号，不是语义
  assert.deepEqual(tagsOf('10.png'), []);
  // 中文里带数字的不拆（「庙会壁纸3」是一个词，拆开反而更差）
  assert.deepEqual(tagsOf('庙会壁纸3.png'), ['庙会壁纸3']);
});

test('侧车：标签 + 场合，只写场合也认', () => {
  assert.deepEqual(parseSidecar('开心, 猫; 有人装可爱时'), { tags: ['开心', '猫'], usage: '有人装可爱时' });
  assert.deepEqual(parseSidecar('; 提到深海时'), { tags: [], usage: '提到深海时' });
  assert.equal(parseSidecar('   '), null);
});

test('平铺：侧车标签优先于文件名', () => {
  const { stickers } = makeLib({
    '熊猫开心.png': 'x',
    '熊猫开心.png.tags': '开心, 熊猫; 对方说好笑的事',
  });
  const [s] = stickers.list({});
  assert.deepEqual(s.tags, ['开心', '熊猫']);
  assert.equal(s.usage, '对方说好笑的事');
});

test('排序：自然序，1、2、10', () => {
  const { stickers } = makeLib({ '10.png': 'x', '2.png': 'x', '1.png': 'x' });
  assert.deepEqual(stickers.list({}).map((s) => s.file), ['1.png', '2.png', '10.png']);
});

test('超过上限的图不进清单（200MB 硬限）', () => {
  const { root } = makeLib({ 'big.png': 'x'.repeat(64), 'ok.png': 'x' });
  const s = createStickers({ dataDir: root, cacheMs: 0 });
  const items = s.list({ maxBytes: 32 }, { max: 50 });
  assert.deepEqual(items.map((x) => x.file), ['ok.png']);

  // 默认上限是 200MB，64 字节的两张都该留着
  assert.equal(s.list({}, { max: 50 }).length, 2);
  assert.equal(MAX_BYTES, 200 * 1024 * 1024);
});

test('分类：一级子目录算分类，_desc.txt 是说明不是图', () => {
  const { stickers } = makeLib({
    '开心/a.png': 'x',
    '开心/b.png': 'x',
    '开心/_desc.txt': '高兴、庆祝的时候用',
    '无语/c.png': 'x',
    '零散.png': 'x', // 根目录 = 未分类
  });
  const cats = stickers.categories({});
  assert.deepEqual(cats.map((c) => c.name), ['开心', '无语']);
  const happy = cats.find((c) => c.name === '开心');
  assert.equal(happy.count, 2);
  assert.equal(happy.desc, '高兴、庆祝的时候用');
  // 空分类不出现
  assert.equal(stickers.categories({}).length, 2);
});

test('清单：平铺时目录只写一次，不逐条重复路径', () => {
  const { stickers, dir } = makeLib({ '海妖.png': 'x', '水解.png': 'x' });
  const text = stickers.prompt({});
  assert.ok(text.includes('海妖.png（海妖）'), text);
  assert.ok(text.includes('水解.png（水解）'), text);
  // 每行不该再带一遍盘符：整段里目录最多出现两次（抬头 + 示例）
  const hits = text.split(dir).length - 1;
  assert.ok(hits <= 2, `目录出现了 ${hits} 次：\n${text}`);
});

test('清单：有分类时只列分类和少量示例，把具体文件交给工具', () => {
  const { stickers } = makeLib({
    '开心/a.png': 'x',
    '开心/b.png': 'x',
    '开心/c.png': 'x',
    '开心/d.png': 'x',
    '开心/_desc.txt': '高兴时用',
  });
  const text = stickers.prompt({});
  assert.ok(text.includes('开心（4 张）：高兴时用'), text);
  assert.ok(text.includes('sticker_pick'), '分类模式必须引导模型去调工具');
  // 只留前 3 个当兜底示例：全铺开就等于回到「清单吃预算」的老路
  assert.ok(text.includes('a.png') && text.includes('c.png'), text);
  assert.ok(!text.includes('d.png'), `第 4 个不该出现：\n${text}`);
});

test('清单：建了分类之后，根目录那批图不能凭空消失', () => {
  const { stickers } = makeLib({
    '开心/a.png': 'x',
    '零散.png': 'x',
  });
  const text = stickers.prompt({});
  assert.ok(text.includes('未分类（1 张）'), text);
  assert.ok(text.includes('零散.png'), text);
});

test('挑图：能从「未分类」里取根目录的图', () => {
  const { stickers } = makeLib({ '开心/a.png': 'x', '零散.png': 'x' });
  const r = stickers.pick({}, { category: '未分类' });
  assert.equal(r.ok, true);
  assert.equal(r.category, '未分类');
  assert.equal(r.items[0].file, '零散.png');
});

test('清单：关掉就空，没图也空', () => {
  const { stickers } = makeLib({ 'a.png': 'x' });
  assert.equal(stickers.prompt({ enabled: false }), '');
  const empty = makeLib({}).stickers;
  assert.equal(empty.prompt({}), '');
});

test('挑图：按分类取，避开刚给过的那张', () => {
  const { stickers } = makeLib({
    '开心/a.png': 'x',
    '开心/b.png': 'x',
    '无语/c.png': 'x',
  });
  const first = stickers.pick({}, { category: '开心', limit: 1 });
  assert.ok(first.ok);
  assert.equal(first.category, '开心');
  assert.equal(first.items.length, 1);

  const second = stickers.pick({}, { category: '开心', limit: 1 });
  assert.ok(second.ok);
  assert.notEqual(second.items[0].path, first.items[0].path, '连着两次给同一张 = 群里连发两张一样的');
});

test('挑图：分类不存在时把现有分类报回去', () => {
  const { stickers } = makeLib({ '开心/a.png': 'x' });
  const r = stickers.pick({}, { category: '生气' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.categories, ['开心']);
  assert.ok(r.message.includes('开心'), r.message);
});

test('挑图：库里有分类但没指定，要求先说分类', () => {
  const { stickers } = makeLib({ '开心/a.png': 'x' });
  const r = stickers.pick({}, {});
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('分类'), r.message);
});

test('挑图：超过 20MB 会标 degrade（会变成文件而不是表情）', () => {
  const { root, dir } = makeLib({});
  // 稀疏文件：stat 报 21MB，实际不占磁盘
  const big = path.join(dir, 'big.png');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 21 * 1024 * 1024);

  const s = createStickers({ dataDir: root, cacheMs: 0 });
  const r = s.pick({}, { limit: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].file, 'big.png');
  assert.equal(r.items[0].degrade, true);
});

test('匹配：标签全等优先于子串', () => {
  const { stickers } = makeLib({
    '开心.png': 'x', // 标签「开心」含「心」
    '心.png': 'x', // 标签就是「心」
  });
  const p = stickers.resolve({}, '表情: 心');
  assert.ok(p.endsWith('心.png'), `应选完全相等的那张，实际 ${p}`);
});

test('匹配：直接给文件名', () => {
  const { stickers, dir } = makeLib({ '海妖.png': 'x' });
  assert.equal(stickers.resolve({}, '海妖.png'), path.join(dir, '海妖.png'));
  assert.equal(stickers.resolve({}, '不存在.png'), null);
});

test('工具：字符串参数能用，空分类被挡，返回值带「怎么发」', async () => {
  const { stickers } = makeLib({ '开心/a.png': 'x', '开心/b.png': 'x' });
  const [tool] = buildStickerToolDefs({ pickOf: (o) => stickers.pick({}, o) });

  assert.equal(tool.name, 'sticker_pick');
  // 参数是字符串：DSH 的 defineTool 对 number 没有先例，见 sticker-tools.js 注释
  assert.equal(tool.parameters.n.type, 'string');

  assert.equal((await tool.execute({})).ok, false);

  const one = await tool.execute({ category: '开心', n: '1' });
  assert.equal(one.ok, true);
  assert.equal(one.items.length, 1);
  // 只给路径不给用法时，模型会把路径写进正文，群里看到一串盘符
  assert.ok(one.how.includes('<<image:'), JSON.stringify(one));

  const bad = await tool.execute({ category: '生气' });
  assert.equal(bad.ok, false);
  assert.ok(bad.message.includes('开心'), bad.message);
});

test('工具：render 必须是内容块数组（字符串会让 DSH 的 content.some 炸掉）', () => {
  const [tool] = buildStickerToolDefs({ pickOf: () => ({ ok: true }) });
  const r = tool.output.render({}, { ok: true });
  assert.ok(Array.isArray(r));
  assert.equal(r[0].type, 'text');
});

test('挑图：优先给能正常发的图，会降级的垫底', () => {
  const { root, dir } = makeLib({ 'small.png': 'x' });
  // 自然序 big < small，如果不按大小分档，第一张永远是这个 21MB 的
  const big = path.join(dir, 'big.png');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 21 * 1024 * 1024);

  const s = createStickers({ dataDir: root, cacheMs: 0 });
  const r = s.pick({}, { limit: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].file, 'small.png');
  assert.equal(r.items[0].degrade, false);
});

test('扫描上限：图太多时只认前 N 张，并说清还有更多', () => {
  const { root } = makeLib({ 'a.png': 'x', 'b.png': 'x', 'c.png': 'x', 'd.png': 'x' });
  const s = createStickers({ dataDir: root, cacheMs: 0, maxScan: 2 });
  assert.equal(s.list({}, { max: 10 }).length, 2);
  const text = s.prompt({});
  assert.ok(text.includes('只扫了前 2 张'), text);
});

test('侧车只写场合时，标签仍走文件名', () => {
  const { stickers } = makeLib({
    '熊猫开心.png': 'x',
    '熊猫开心.png.tags': '; 对方说好笑的事',
  });
  const [s] = stickers.list({});
  assert.deepEqual(s.tags, ['熊猫开心']); // 侧车没有标签，退回文件名
  assert.equal(s.usage, '对方说好笑的事');
});

test('注册：sticker_pick 挂上 agent 的 tools，缺服务时不抛', async () => {
  const registered = [];
  const agent = {
    ctx: {
      tools: {
        register: (t) => {
          registered.push(t);
          return () => {};
        },
      },
    },
  };

  const r = await registerStickerTools({ agent, pickOf: () => ({ ok: true }) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.names, ['sticker_pick']);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'sticker_pick');
  // 测试环境拿不到 @deepseek-ai/dsh-tools，走 plain 分支：扁平表要转成 JSON Schema
  assert.equal(registered[0].parameters.type, 'object');
  assert.ok(registered[0].parameters.properties.category);
  r.off();

  // 没有 tools 服务的 agent：返回失败而不是抛错（工具是增强，不能拖垮整轮对话）
  const bad = await registerStickerTools({ agent: {}, pickOf: () => ({ ok: true }) });
  assert.equal(bad.ok, false);
  assert.ok(bad.reason);
});
