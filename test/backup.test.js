/**
 * E4 一键备份（7a）：ZIP 内核 / 暂存 / 启动时应用的回归测试。
 *
 * 全部用临时目录，不碰真实 `~/.dsh/dsh-roost`。
 * 关键验收：导入**绝不**动现有文件、恢复前旧文件可找回、SQLite 走一致性
 * 快照且旧 WAL 不会重放到新库、路径穿越与 CRC 篡改一律拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MANIFEST, applyPendingRestore, cancelRestore, createBackup, listBackups,
  pendingRestore, safeRel, shouldSkip, stageRestore,
} from '../src/backup.js';

function fixture(t, init = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-roost-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  if (init) {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ server: { port: 17321 } }));
    mkdirSync(join(root, 'personas'));
    writeFileSync(join(root, 'personas', '小栖.md'), '# 人格\n你好呀');
    writeFileSync(join(root, 'memory.json'), '{"list":[]}');
    writeFileSync(join(root, 'binary.png'), Buffer.from([0, 1, 2, 255, 128, 9]));
  }
  return root;
}

const fixedNow = new Date('2026-11-08T06:00:00.000Z');

/** 在生成的 zip 里等长替换文件名（local + central 头各一份），用来伪造恶意条目。 */
function patchName(buf, from, to) {
  assert.equal(from.length, to.length, '测试辅助：替换必须等长');
  const a = Buffer.from(from, 'utf8');
  const b = Buffer.from(to, 'utf8');
  const out = Buffer.from(buf);
  let hits = 0;
  for (let i = 0; i + a.length <= out.length; i++) {
    if (out.subarray(i, i + a.length).equals(a)) { b.copy(out, i); hits += 1; }
  }
  assert.ok(hits >= 2, `测试辅助：应至少命中 local 与 central 两处，实际 ${hits}`);
  return out;
}

/** 定位第一个 local header 的数据区并改一个字节；用来验证 CRC 校验确实在跑。 */
function tamperFirstEntry(buf) {
  const out = Buffer.from(buf);
  const nameLen = out.readUInt16LE(26);
  const extraLen = out.readUInt16LE(28);
  const at = 30 + nameLen + extraLen;
  out[at] ^= 0xff;
  return out;
}

test('往返：文本 / 二进制 / 中文名 / 子目录，导出 → 暂存 → 启动应用后逐字节一致', (t) => {
  const root = fixture(t);
  const out = mkdtempSync(join(tmpdir(), 'dsh-roost-zip-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const exp = createBackup({ root, out, now: fixedNow, version: '1.0.7' });
  assert.ok(existsSync(exp.file));
  assert.equal(exp.files, 4);
  assert.ok(exp.name.endsWith('.zip'));

  // 暂存不改现有数据
  const before = readFileSync(join(root, 'memory.json'), 'utf8');
  const st = stageRestore({ zip: exp.file, root });
  assert.equal(st.files, 4);
  assert.equal(st.manifest.schema, 1);
  assert.equal(st.manifest.app, 'dsh-roost');
  assert.equal(readFileSync(join(root, 'memory.json'), 'utf8'), before, '暂存不得动现有文件');
  assert.ok(existsSync(join(root, '.restore', 'memory.json')));
  assert.ok(pendingRestore(root));

  // 恢复后内容一致
  writeFileSync(join(root, 'memory.json'), '{"list":["被改过"]}');
  const r = applyPendingRestore({ root, now: 1700000000000 });
  assert.equal(r.applied, 4);
  assert.equal(readFileSync(join(root, 'memory.json'), 'utf8'), before);
  assert.equal(readFileSync(join(root, 'personas', '小栖.md'), 'utf8'), '# 人格\n你好呀');
  assert.deepEqual([...readFileSync(join(root, 'binary.png'))], [0, 1, 2, 255, 128, 9]);
  assert.equal(pendingRestore(root), null);
  assert.ok(!existsSync(join(root, '.restore')));
});

test('被换掉的旧文件挪到 backups/pre-restore-*/，随时能找回', (t) => {
  const root = fixture(t);
  const exp = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  stageRestore({ zip: exp.file, root });
  const old = '{"list":["旧内容"]}';
  writeFileSync(join(root, 'memory.json'), old);
  const r = applyPendingRestore({ root, now: 1700000000001 });
  assert.ok(r.kept && r.kept.includes('pre-restore-1700000000001'));
  assert.equal(readFileSync(join(r.kept, 'memory.json'), 'utf8'), old);
});

test('apply 幂等：没有 pending 时返回 0，重复执行不产生第二份备份', (t) => {
  const root = fixture(t);
  assert.deepEqual(applyPendingRestore({ root }), { applied: 0, kept: null });
  const exp = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  stageRestore({ zip: exp.file, root });
  assert.equal(applyPendingRestore({ root, now: 1 }).applied, 4);
  assert.deepEqual(applyPendingRestore({ root, now: 2 }), { applied: 0, kept: null });
  assert.equal(readdirSync(join(root, 'backups')).filter((n) => n.startsWith('pre-restore-')).length, 1);
});

test('cancelRestore 清暂存与 pending，不动现有文件', (t) => {
  const root = fixture(t);
  const exp = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  stageRestore({ zip: exp.file, root });
  const before = readFileSync(join(root, 'config.json'), 'utf8');
  cancelRestore(root);
  assert.equal(pendingRestore(root), null);
  assert.ok(!existsSync(join(root, '.restore')));
  assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), before);
});

test('跳过备份自身 / 日志 / 缓存 / node_modules / tmp / sqlite-wal', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'logs'));
  writeFileSync(join(root, 'logs', 'a.log'), 'log');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'x.js'), 'x');
  writeFileSync(join(root, 'a.tmp'), 'tmp');
  writeFileSync(join(root, 'journal.sqlite-wal'), 'wal');
  writeFileSync(join(root, 'journal.sqlite-shm'), 'shm');
  const exp = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  const st = stageRestore({ zip: exp.file, root });
  assert.equal(st.files, 4, '只该打包 4 个正常文件');
  assert.equal(shouldSkip('backups/a.zip'), true);
  assert.equal(shouldSkip('logs/a.log'), true);
  assert.equal(shouldSkip('a/node_modules/x.js'), true);
  assert.equal(shouldSkip('journal.sqlite-wal'), true);
  assert.equal(shouldSkip('a.tmp'), true);
  assert.equal(shouldSkip('memory.json'), false);
});

test('行级备份是 backups/ 下唯一放行的条目（统一包格式）', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'backups'));
  writeFileSync(join(root, 'backups', 'pre-retention-2026-11-08.json'), '{"at":1,"facts":[],"journal":[]}');
  writeFileSync(join(root, 'backups', 'evil.json'), '{}');
  const exp = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  const st = stageRestore({ zip: exp.file, root });
  assert.equal(st.files, 5, '4 个正常文件 + 1 份行级备份');
  assert.ok(existsSync(join(root, '.restore', 'backups', 'pre-retention-2026-11-08.json')));
  assert.ok(!existsSync(join(root, '.restore', 'backups', 'evil.json')));
  assert.equal(shouldSkip('backups/pre-retention-2026-11-08.json'), false);
  assert.equal(shouldSkip('backups/evil.json'), true);
  assert.equal(shouldSkip('backups/pre-restore-x/config.json'), true);
});

test('safeRel 拒绝绝对路径、盘符、反斜杠与 ..', () => {
  for (const bad of [
    '', '../evil', 'a/../b', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', 'a/./b', 'a/\0b',
    'data/aa:b.txt', 'a|b', 'a?b', 'a*b', 'a<b', 'a>b', 'a"b',
  ]) {
    assert.equal(safeRel(bad), false, `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert.equal(safeRel('personas/小栖.md'), true);
  assert.equal(safeRel('data/a.json'), true);
});

test('路径穿越的备份被拒，且不留下 .restore/ 半份数据', (t) => {
  const root = fixture(t);
  const exp = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  // data/binary.png 与 data/../evil.gg 等长（15 字节）
  const evil = patchName(readFileSync(exp.file), 'data/binary.png', 'data/../evil.gg');
  const badZip = join(root, 'evil.zip');
  writeFileSync(badZip, evil);
  assert.throws(() => stageRestore({ zip: badZip, root }), /不安全的路径/);
  assert.ok(!existsSync(join(root, '.restore')));
  assert.equal(pendingRestore(root), null);
  assert.ok(!existsSync(join(root, 'evil.gg')));
});

test('CRC 不符 / 目录损坏 / 缺 manifest 一律拒绝', (t) => {
  const root = fixture(t);
  const exp = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  const buf = readFileSync(exp.file);
  const bad = join(root, 'bad.zip');
  writeFileSync(bad, tamperFirstEntry(buf));
  assert.throws(() => stageRestore({ zip: bad, root }));

  // dsh-roost-backup.json 与 xxx-roost-backup.json 等长（22 字节）
  const noManifest = patchName(buf, MANIFEST, 'xxx-roost-backup.json');
  const bad2 = join(root, 'bad2.zip');
  writeFileSync(bad2, noManifest);
  assert.throws(() => stageRestore({ zip: bad2, root }), /不是 dsh-roost 的备份/);

  const junk = join(root, 'junk.zip');
  writeFileSync(junk, Buffer.from('not a zip at all'));
  assert.throws(() => stageRestore({ zip: junk, root }), /不是有效的备份文件/);
});

test('SQLite 走一致性快照：包里的库可读、旧 WAL/SHM 被挪走', (t) => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const root = fixture(t);
  const dbFile = join(root, 'journal.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('记忆还在')");
  db.close();
  writeFileSync(join(root, 'journal.sqlite-wal'), 'OLD-WAL');
  writeFileSync(join(root, 'journal.sqlite-shm'), 'OLD-SHM');

  const exp = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  assert.deepEqual(exp.snapshots, ['journal.sqlite']);
  stageRestore({ zip: exp.file, root });
  const snap = join(root, '.restore', 'journal.sqlite');
  assert.ok(existsSync(snap));
  const check = new DatabaseSync(snap, { readOnly: true });
  assert.equal(check.prepare('SELECT a FROM t').get().a, '记忆还在');
  check.close();

  const r = applyPendingRestore({ root, now: 1700000000009 });
  assert.ok(r.applied >= 5);
  assert.ok(!existsSync(join(root, 'journal.sqlite-wal')), '旧 WAL 不能留');
  assert.ok(!existsSync(join(root, 'journal.sqlite-shm')), '旧 SHM 不能留');
  assert.equal(readFileSync(join(r.kept, 'journal.sqlite-wal'), 'utf8'), 'OLD-WAL');
});

test('配置里旧机器的数据目录路径换成新数据目录', (t) => {
  const root = fixture(t);
  const other = mkdtempSync(join(tmpdir(), 'dsh-roost-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const cfg = { gptSovits: { dir: join(other, 'gpt') }, tts: { model: join(other, 'model.onnx') } };
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg));
  const exp = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  stageRestore({ zip: exp.file, root });
  // 伪造「备份来自另一台机器」：只改 pending 里的来源目录
  const p = pendingRestore(root);
  p.dataDir = other;
  writeFileSync(join(root, '.restore-pending.json'), JSON.stringify(p));
  const r = applyPendingRestore({ root, now: 1700000000011 });
  assert.ok(r.applied >= 1);
  const after = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  assert.equal(after.gptSovits.dir, join(root, 'gpt'));
  assert.equal(after.tts.model, join(root, 'model.onnx'));
});

test('同一分钟导出两次不覆盖旧包；listBackups 区分完整包 / 记忆淡出备份', (t) => {
  const root = fixture(t);
  const a = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  const b = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  assert.notEqual(a.name, b.name);
  assert.ok(a.name.endsWith('.zip') && b.name.endsWith('-2.zip'));
  assert.ok(existsSync(a.file) && existsSync(b.file));
  writeFileSync(join(root, 'backups', 'pre-retention-2026-11-08.json'), '{}');
  const list = listBackups(root);
  assert.equal(list.filter((x) => x.kind === 'full').length, 2);
  assert.equal(list.filter((x) => x.kind === 'retention').length, 1);
  assert.ok(list[0].at >= list[list.length - 1].at, '按时间倒序');
});

test('备份里缺 config.json 被拒（不是本插件的数据目录）', (t) => {
  const root = fixture(t, false);
  writeFileSync(join(root, 'memory.json'), '{}');
  const exp = createBackup({ root, out: join(root, 'backups'), now: fixedNow });
  assert.throws(() => stageRestore({ zip: exp.file, root }), /没有 config.json/);
});

test('快照失败即整份备份失败，不交半成品', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'graph.sqlite'), 'not a sqlite file');
  assert.throws(() => createBackup({ root, out: join(root, 'backups'), now: fixedNow }), /没能打包/);
  assert.equal(readdirSync(join(root, 'backups')).filter((n) => n.endsWith('.zip')).length, 0);
  assert.equal(readdirSync(join(root, 'backups')).filter((n) => n.endsWith('.tmp')).length, 0);
});

test('导出目录可以在数据目录之外，且不把 out 里的东西打进包', (t) => {
  const root = fixture(t);
  const out = mkdtempSync(join(tmpdir(), 'dsh-roost-out-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeFileSync(join(out, '别的.zip'), 'x');
  const exp = createBackup({ root, out, now: fixedNow });
  assert.equal(resolve(exp.file).startsWith(resolve(out)), true);
  assert.equal(exp.files, 4);
});
