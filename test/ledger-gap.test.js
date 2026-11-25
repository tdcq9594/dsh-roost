// 账本读取（`ledger-read.js`）：缺口 `gap()` 与翻记录 `recent()`。
//
// 这块是「被叫到时补上群里刚才说了什么」和「模型主动往前翻」的数据源，
// 错法只有几种：
//   · 顺序反了 → 模型以为先说的话在后；
//   · 出站判错 → 她把自己的话记成对方说的，或者反过来；
//   · 两条路的来源判据不一致 → 同一个群在补齐块和翻记录里是两个世界；
//   · 漏了 bot_id → 每轮全表扫描，而且可能串到别的 bot。
// 各锁一遍。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLedgerReader, resolveLedger } from '../src/ledger-read.js';

const sqlite = process.getBuiltinModule?.('node:sqlite');

/**
 * 造一份真库（只建 `gap()` 会查的列）。
 *
 * @param {string} dir   临时 roost 目录
 * @param {Array} rows   事件行
 * @param {object} [o]
 * @param {false|'v1'|'v3'} [o.legacy] `'v1'` = 连 `plugin` 都没有；
 *   `'v3'` = 有 `plugin` 没 `source`；`false` = 最新（两列都有）
 * @param {boolean} [o.link] 有没有 `reply_to`（账本 v5）。默认有；
 *   `false` 造「升级前」的库，用来验相邻退路
 */
function seed(dir, rows, { legacy = false, link = true } = {}) {
  const botsDir = join(dir, 'data', 'bots', 'main');
  mkdirSync(botsDir, { recursive: true });
  const file = join(botsDir, 'events.db');
  const db = new sqlite.DatabaseSync(file);
  /** 老版本不可能带 `reply_to`，只有最新库有 */
  const withLink = !legacy && link;
  const extraCols = legacy === 'v1'
    ? ''
    : legacy === 'v3'
      ? ", plugin TEXT NOT NULL DEFAULT ''"
      : ", plugin TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT ''"
        + (withLink ? ', reply_to TEXT' : '');
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      bot_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      msg_id TEXT,
      user_id TEXT,
      user_name TEXT,
      content TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      time_basis TEXT NOT NULL,
      dedupe TEXT NOT NULL UNIQUE,
      msg_idx TEXT,
      ref_msg_idx TEXT,
      union_openid TEXT,
      quoted TEXT,
      payload TEXT NOT NULL
      ${extraCols}
    );
  `);
  const colList = ['id', 'bot_id', 'kind', 'chat_id', 'msg_id', 'user_id', 'user_name', 'content', 'at', 'observed_at', 'time_basis', 'dedupe', 'payload'];
  if (legacy !== 'v1') colList.push('plugin');
  if (!legacy) colList.push('source');
  if (withLink) colList.push('reply_to');
  const ins = db.prepare(
    `INSERT INTO events (${colList.join(',')}) VALUES (${new Array(colList.length).fill('?').join(',')})`,
  );
  for (const r of rows) {
    const at = r.at ?? Date.now();
    const vals = [
      r.id, r.botId ?? 'main', r.kind ?? 'group_message', r.chatId ?? 'g1', r.msgId ?? '',
      r.userId ?? '', r.userName ?? '', r.content ?? '', at, at, 'server', r.id, '{}',
    ];
    if (legacy !== 'v1') vals.push(r.plugin ?? '');
    if (!legacy) vals.push(r.source ?? '');
    if (withLink) vals.push(r.replyTo ? String(r.replyTo) : null);
    ins.run(...vals);
  }
  db.close();
  return file;
}

/** 每个用例自己的临时目录，跑完删掉 */
function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-gap-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('gap：正序返回（老的在前），出站行标成 self', () => {
  if (!sqlite?.DatabaseSync) return; // 老 Node 没有 node:sqlite，跳过
  withDir((dir) => {
    seed(dir, [
      { id: 'a', msgId: 'm1', userName: '张三', content: '第一句', at: 1000 },
      { id: 'b', msgId: 'm2', userName: '', content: '她回的', at: 2000, plugin: 'host', source: 'host' },
      { id: 'c', msgId: 'm3', userName: '李四', content: '第二句', at: 3000 },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    const rows = reader.gap({ chatId: 'g1' });
    assert.deepEqual(rows.map((r) => r.msgId), ['m1', 'm2', 'm3'], '时间顺序，老的在前');
    assert.deepEqual(rows.map((r) => r.self), [false, true, false], '只有机器人自己那条算 self');
    assert.equal(rows[1].text, '她回的');
    reader.close();
  });
});

test('gap：只取这个 bot 的行，别的 bot 的串不进来', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'a', msgId: 'm1', userName: '张三', content: '本 bot 的' },
      { id: 'x', botId: 'other', msgId: 'mx', userName: '外人', content: '别的 bot 的' },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    const rows = reader.gap({ chatId: 'g1' });
    assert.deepEqual(rows.map((r) => r.msgId), ['m1']);
    reader.close();
  });
});

test('gap：另一个会话的行不进来', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'a', msgId: 'm1', chatId: 'g1', userName: '张三', content: '本群' },
      { id: 'b', msgId: 'm2', chatId: 'g2', userName: '李四', content: '别群' },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(reader.gap({ chatId: 'g1' }).map((r) => r.msgId), ['m1']);
    reader.close();
  });
});

test('gap：v1/v2 老库（连 plugin 都没有）只留真人消息，出站一律丢弃', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'a', msgId: 'm1', userName: '张三', content: '人说的' },
      { id: 'b', msgId: 'm2', userName: '', content: '她说的' },
    ], { legacy: 'v1' });
    const reader = createLedgerReader({ roostDirOf: () => dir });
    const rows = reader.gap({ chatId: 'g1' });
    /**
     * 老库分不出「自有协议说的」和「别的插件说的」，只能一并丢。
     * 宁可这一版看不见自己说过什么，也不把插件回复冒充成她的话。
     */
    assert.deepEqual(rows.map((r) => r.msgId), ['m1'], '出站行无从证明来源，不补进上下文');
    assert.deepEqual(rows.map((r) => r.self), [false]);
    reader.close();
  });
});

test('gap：v3 老库（有 plugin 没 source）按 plugin 认自有协议，别的插件剔除', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'a', msgId: 'm1', userName: '张三', content: '真人' },
      { id: 'b', msgId: 'm2', userName: '', content: '她自己说的', plugin: 'host' },
      { id: 'c', msgId: 'm3', userName: '', content: '回声插件说的', plugin: 'echo' },
      { id: 'd', msgId: 'm4', userName: '', content: '框架菜单', plugin: '' },
    ], { legacy: 'v3' });
    const reader = createLedgerReader({ roostDirOf: () => dir });
    const rows = reader.gap({ chatId: 'g1' });
    assert.deepEqual(rows.map((r) => r.msgId), ['m1', 'm2'], '只留真人和自有协议');
    assert.deepEqual(rows.map((r) => r.self), [false, true]);
    reader.close();
  });
});

test('gap：其他插件、菜单、mock、notice 都不进上下文，只留真人与自有协议', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'r1', msgId: 'm1', userName: '张三', content: '网关来的真人', source: 'gateway' },
      { id: 'r2', msgId: 'm2', userName: '李四', content: 'Webhook 来的真人', source: 'webhook' },
      { id: 'h1', msgId: 'm3', userName: '', content: '她自己说的', plugin: 'host', source: 'host' },
      { id: 'p1', msgId: 'm4', userName: '', content: '回声插件说的', plugin: 'echo', source: 'plugin' },
      { id: 'p2', msgId: 'm5', userName: '', content: 'AI 对话插件说的', plugin: 'ai-chat', source: 'plugin' },
      { id: 'm1', msgId: 'm6', userName: '', content: '框架菜单', plugin: '', source: '' },
      { id: 'o1', msgId: 'm7', userName: '', content: 'OneBot 代发', plugin: '', source: 'onebot' },
      { id: 'a1', msgId: 'm8', userName: '', content: '兜底直发', plugin: '', source: 'api' },
      { id: 'k1', msgId: 'm9', userName: '某人', content: '面板模拟的', source: 'mock' },
      { id: 'k2', msgId: 'm10', userName: '某人', content: '命令行模拟的', source: 'dev' },
      { id: 'k3', msgId: 'm11', userName: '某人', content: '导入的', source: 'import' },
      { id: 'n1', msgId: 'm12', userName: '', content: '[事件] GUILD_CREATE', kind: 'notice', source: 'gateway' },
      { id: 'j1', msgId: 'm13', userName: '', content: '她+回声合并发的一条', plugin: 'host,echo', source: 'plugin' },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    const rows = reader.gap({ chatId: 'g1' });
    assert.deepEqual(
      rows.map((r) => r.msgId),
      ['m1', 'm2', 'm3'],
      '只留真人（gateway/webhook）和自有协议（host），其余全部剔除',
    );
    assert.deepEqual(rows.map((r) => r.self), [false, false, true]);
    reader.close();
  });
});

test('gap：limit 生效，取的是最新那几条', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'a', msgId: 'm1', userName: '甲', content: '1' },
      { id: 'b', msgId: 'm2', userName: '乙', content: '2' },
      { id: 'c', msgId: 'm3', userName: '丙', content: '3' },
      { id: 'd', msgId: 'm4', userName: '丁', content: '4' },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(reader.gap({ chatId: 'g1', limit: 2 }).map((r) => r.msgId), ['m3', 'm4']);
    reader.close();
  });
});

test('gap：账本不存在时返回空数组，不抛', () => {
  withDir((dir) => {
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(reader.gap({ chatId: 'g1' }), []);
    reader.close();
  });
});

test('resolveLedger：目录名就是 botId，和 events_timeline 索引前缀对得上', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, []);
    const r = resolveLedger({ roostDir: dir });
    assert.equal(r.botId, 'main');
    assert.match(r.file, /events\.db$/);
  });
});

/* ---------------- recent()：和 gap() 共用同一套来源白名单 ---------------- */

test('recent：其他插件、菜单、notice 都不给模型看，只留真人与自有协议', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'r1', msgId: 'm1', userName: '张三', content: '网关来的真人', source: 'gateway' },
      { id: 'r2', msgId: 'm2', userName: '李四', content: 'Webhook 来的真人', source: 'webhook' },
      { id: 'h1', msgId: 'm3', userName: '', content: '她自己说的', plugin: 'host', source: 'host' },
      { id: 'p1', msgId: 'm4', userName: '', content: '回声插件说的', plugin: 'echo', source: 'plugin' },
      { id: 'p2', msgId: 'm5', userName: '', content: '框架菜单', plugin: '__core', source: 'plugin' },
      { id: 'm1', msgId: 'm6', userName: '', content: '老路径菜单', plugin: '', source: '' },
      { id: 'k1', msgId: 'm7', userName: '某人', content: '面板模拟的', source: 'mock' },
      { id: 'n1', msgId: 'm8', userName: '', content: '[事件] GUILD_CREATE', kind: 'notice', source: 'gateway' },
      { id: 'j1', msgId: 'm9', userName: '', content: '她+回声合并发的一条', plugin: 'host,echo', source: 'plugin' },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    const rows = reader.recent({ chatId: 'g1' });
    assert.deepEqual(
      rows.map((r) => r.who),
      ['张三', '李四', '（未知）'],
      '和 gap() 一样，只留真人（gateway/webhook）与自有协议（host）',
    );
    assert.deepEqual(rows.map((r) => r.self), [false, false, true]);
    assert.deepEqual(rows.map((r) => r.text), ['网关来的真人', 'Webhook 来的真人', '她自己说的']);
    reader.close();
  });
});

test('recent：v3 老库（有 plugin 没 source）同样过滤，自有协议仍标 self', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'a', msgId: 'm1', userName: '张三', content: '真人' },
      { id: 'b', msgId: 'm2', userName: '', content: '她自己说的', plugin: 'host' },
      { id: 'c', msgId: 'm3', userName: '', content: '回声插件说的', plugin: 'echo' },
    ], { legacy: 'v3' });
    const reader = createLedgerReader({ roostDirOf: () => dir });
    const rows = reader.recent({ chatId: 'g1' });
    assert.deepEqual(rows.map((r) => r.text), ['真人', '她自己说的']);
    assert.deepEqual(rows.map((r) => r.self), [false, true]);
    reader.close();
  });
});

test('recent：v1/v2 老库只留真人，出站无从证明来源一并丢弃', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'a', msgId: 'm1', userName: '张三', content: '人说的' },
      { id: 'b', msgId: 'm2', userName: '', content: '不知道谁说的' },
    ], { legacy: 'v1' });
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(reader.recent({ chatId: 'g1' }).map((r) => r.text), ['人说的']);
    reader.close();
  });
});

test('recent：limit 是「给模型看的条数」，剔掉菜单后仍然凑得满', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'a', msgId: 'm1', userName: '甲', content: '一', source: 'gateway' },
      { id: 'p1', msgId: 'p1', userName: '', content: '菜单 1', plugin: '__core', source: 'plugin' },
      { id: 'b', msgId: 'm2', userName: '乙', content: '二', source: 'gateway' },
      { id: 'p2', msgId: 'p2', userName: '', content: '菜单 2', plugin: '__core', source: 'plugin' },
      { id: 'p3', msgId: 'p3', userName: '', content: '菜单 3', plugin: '__core', source: 'plugin' },
      { id: 'c', msgId: 'm3', userName: '丙', content: '三', source: 'gateway' },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(reader.recent({ chatId: 'g1', limit: 2 }).map((r) => r.text), ['二', '三']);
    reader.close();
  });
});

test('recent：beforeSeq 分页仍然只翻到更早的那些', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'a', msgId: 'm1', userName: '甲', content: '一', source: 'gateway' },
      { id: 'b', msgId: 'm2', userName: '乙', content: '二', source: 'gateway' },
      { id: 'c', msgId: 'm3', userName: '丙', content: '三', source: 'gateway' },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    const page = reader.recent({ chatId: 'g1', limit: 2 });
    assert.deepEqual(page.map((r) => r.text), ['二', '三']);
    const older = reader.recent({ chatId: 'g1', limit: 2, beforeSeq: page[0].seq });
    assert.deepEqual(older.map((r) => r.text), ['一']);
    reader.close();
  });
});

/* ---------------- 命令剔除：触发别的插件的那条指令不进上下文 ---------------- */

/** 造一份框架配置（命令前缀） */
function seedConfig(dir, prefix) {
  const cfgDir = join(dir, 'config', 'bots');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'main.json'), JSON.stringify({ commandPrefix: prefix }), 'utf8');
}

test('recent：命令后面紧跟着别的插件的回复 → 这条命令不进上下文', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'c1', msgId: 'm1', userName: '张三', content: '/help', source: 'gateway', at: 1000 },
      { id: 'p1', msgId: 'p1', userName: '', content: '# 大鲸鱼', plugin: '__core', source: 'plugin', at: 1200 },
      { id: 'c2', msgId: 'm2', userName: '李四', content: '在吗', source: 'gateway', at: 3000 },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(reader.recent({ chatId: 'g1' }).map((r) => r.text), ['在吗']);
    assert.deepEqual(reader.gap({ chatId: 'g1' }).map((r) => r.text), ['在吗'], '缺口补齐同一套判据');
    reader.close();
  });
});

test('recent：普通聊天后面被插件顺带回一句 → 那句话仍然保留', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'c1', msgId: 'm1', userName: '张三', content: '今天好热', source: 'gateway', at: 1000 },
      { id: 'p1', msgId: 'p1', userName: '', content: '🎲 10 / 100', plugin: 'dice', source: 'plugin', at: 1200 },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(reader.recent({ chatId: 'g1' }).map((r) => r.text), ['今天好热']);
    reader.close();
  });
});

test('recent：命令后面没有插件回复（或超出窗口）→ 不剔', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'c1', msgId: 'm1', userName: '张三', content: '/help', source: 'gateway', at: 1000 },
      { id: 'c2', msgId: 'm2', userName: '李四', content: '在吗', source: 'gateway', at: 2000 },
      { id: 'c3', msgId: 'm3', userName: '王五', content: '/roll', source: 'gateway', at: 10000 },
      /** 30 秒后才回，超出 20 秒窗口：更像主动推送，不敢认作触发 */
      { id: 'p1', msgId: 'p1', userName: '', content: '🎲 71 / 100', plugin: 'dice', source: 'plugin', at: 40000 },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(reader.recent({ chatId: 'g1' }).map((r) => r.text), ['/help', '在吗', '/roll']);
    reader.close();
  });
});

test('recent：她也回了（host,echo 合并出站）的命令不算「只触发了别的插件」', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'c1', msgId: 'm1', userName: '张三', content: '/help', source: 'gateway', at: 1000 },
      { id: 'j1', msgId: 'j1', userName: '', content: '她说的 + 回声', plugin: 'host,echo', source: 'plugin', at: 1200 },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(reader.recent({ chatId: 'g1' }).map((r) => r.text), ['/help']);
    reader.close();
  });
});

/* ---------------- 精确关联（账本 v5 的 reply_to）：不再靠相邻猜 ---------------- */

test('recent：reply_to 精确命中时，回复不紧邻也能认出这条命令被回过', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'c1', msgId: 'm1', userName: '张三', content: '/roll', source: 'gateway', at: 1000 },
      /** 回答慢了几秒，中间插进了别人的话——按「紧邻」就读不出来 */
      { id: 'c2', msgId: 'm2', userName: '李四', content: '等一下', source: 'gateway', at: 1500 },
      { id: 'p1', msgId: 'p1', userName: '', content: '🎲 10 / 100', plugin: 'dice', source: 'plugin', at: 9000, replyTo: 'm1' },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(reader.recent({ chatId: 'g1' }).map((r) => r.text), ['等一下']);
    assert.deepEqual(reader.gap({ chatId: 'g1' }).map((r) => r.text), ['等一下'], '缺口补齐同一套判据');
    reader.close();
  });
});

test('recent：紧邻的插件回复其实答的是别人 → 这条命令留着', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      /** 王五让它查东西，菜单回的是这句（reply_to=m0） */
      { id: 'c0', msgId: 'm0', userName: '王五', content: '帮我查下天气', source: 'gateway', at: 500 },
      { id: 'c1', msgId: 'm1', userName: '张三', content: '/help', source: 'gateway', at: 1000 },
      { id: 'p1', msgId: 'p1', userName: '', content: '# 菜单', plugin: '__core', source: 'plugin', at: 1200, replyTo: 'm0' },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(
      reader.recent({ chatId: 'g1' }).map((r) => r.text),
      ['帮我查下天气', '/help'],
      '回复带 reply_to 指向别处时，相邻只是巧合',
    );
    reader.close();
  });
});

test('recent：升级前的库没有 reply_to，仍按相邻剔命令', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seed(dir, [
      { id: 'c1', msgId: 'm1', userName: '张三', content: '/help', source: 'gateway', at: 1000 },
      { id: 'p1', msgId: 'p1', userName: '', content: '# 大鲸鱼', plugin: '__core', source: 'plugin', at: 1100 },
      { id: 'c2', msgId: 'm2', userName: '李四', content: '在吗', source: 'gateway', at: 2000 },
    ], { link: false });
    const reader = createLedgerReader({ roostDirOf: () => dir });
    assert.deepEqual(reader.recent({ chatId: 'g1' }).map((r) => r.text), ['在吗']);
    reader.close();
  });
});

test('recent：命令前缀跟框架配置走，不是写死 /', () => {
  if (!sqlite?.DatabaseSync) return;
  withDir((dir) => {
    seedConfig(dir, '!');
    seed(dir, [
      { id: 'c1', msgId: 'm1', userName: '张三', content: '/help', source: 'gateway', at: 1000 },
      { id: 'p1', msgId: 'p1', userName: '', content: '# 菜单', plugin: '__core', source: 'plugin', at: 1100 },
      { id: 'c2', msgId: 'm2', userName: '李四', content: '!roll', source: 'gateway', at: 2000 },
      { id: 'p2', msgId: 'p2', userName: '', content: '🎲 71 / 100', plugin: 'dice', source: 'plugin', at: 2100 },
      { id: 'c3', msgId: 'm3', userName: '王五', content: '在吗', source: 'gateway', at: 3000 },
    ]);
    const reader = createLedgerReader({ roostDirOf: () => dir });
    const texts = reader.recent({ chatId: 'g1' }).map((r) => r.text);
    assert.deepEqual(texts, ['/help', '在吗'], '前缀是 ! 时 /help 只是普通发言，!roll 才是命令');
    reader.close();
  });
});
