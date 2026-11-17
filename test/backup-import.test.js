// 备份页的「导入 / 用它恢复」：两个纯函数 + 三处接线。
//
// 为什么要测这两个小函数：它们是**唯一的闸门**——`isFullBackupName()` 挡的是
// 面板传上来的文件名（请求参数，可能带 `../`），`versionGapText()` 挡的是
// 「悄悄恢复了一个别的版本」这种事后很难追的情况。路由本身在 `apply()` 闭包里
// 起不来，接线只能靠源码切片钉（和 `backup-wiring.test.js` 同一套做法）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isFullBackupName, versionGapText, BACKUP_PREFIX } from '../src/backup.js';

const OK_NAME = `${BACKUP_PREFIX}20261117-221500.zip`;

test('文件名闸门：只认 backups/ 里我们自己打出来的整包', () => {
  assert.equal(isFullBackupName(OK_NAME), true);
  assert.equal(isFullBackupName(`${BACKUP_PREFIX}2026-11-17-1.zip`), true, '重名时的 -1 后缀也要过');
  assert.equal(isFullBackupName(`${BACKUP_PREFIX}x.ZIP`), true, '扩展名大小写不该让用户踩空');
});

test('文件名闸门：路径、别的前缀、别的类型一律拒绝', () => {
  for (const bad of [
    '',
    '   ',
    'x.zip',
    'pre-retention-1794929746302.json',
    '../dsh-roost-backup-1.zip',
    'backups/dsh-roost-backup-1.zip',
    '..\\dsh-roost-backup-1.zip',
    `${BACKUP_PREFIX}1.zip `,
    `${BACKUP_PREFIX}1.tar.gz`,
    `${BACKUP_PREFIX}1.zip/../x`,
  ]) {
    assert.equal(isFullBackupName(bad), false, `不该放行：${JSON.stringify(bad)}`);
  }
});

test('版本提示：同版本、缺版本都不啰嗦', () => {
  assert.equal(versionGapText('1.3.11', '1.3.11'), '');
  assert.equal(versionGapText('', '1.3.11'), '');
  assert.equal(versionGapText('1.3.11', ''), '');
  assert.equal(versionGapText(undefined, undefined), '');
});

test('版本提示：小版本差异说「基本兼容」，大版本差异说重话', () => {
  const minor = versionGapText('1.2.3', '1.3.11');
  assert.match(minor, /v1\.2\.3/);
  assert.match(minor, /v1\.3\.11/);
  assert.match(minor, /基本兼容/);

  const major = versionGapText('0.9.7', '1.3.11');
  assert.match(major, /大版本不同/);
  assert.match(major, /大概率对不上/);
});

/* ---------------- 接线：路由与入口都在，且各走各的路 ---------------- */

const HOST = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

test('接线：两条路由都注册了，且上传那条走二进制接收而不是 readBody', () => {
  const atLocal = HOST.indexOf("route('/backup/restore-local'");
  const atImport = HOST.indexOf("route('/backup/import'");
  assert.ok(atLocal > 0, '缺 /backup/restore-local');
  assert.ok(atImport > 0, '缺 /backup/import');

  const importBody = HOST.slice(atImport, atImport + 800);
  assert.match(importBody, /receiveToFile\(req, tmp\)/, '上传必须走二进制接收');
  assert.doesNotMatch(importBody, /readBody\(req\)/, 'JSON 读取会把 zip 拼成字符串，不能用');

  /** 临时文件无论成败都要删，否则数据目录里攒一堆 .import-*.zip */
  const finallyBlock = HOST.slice(atImport, atImport + 1400);
  assert.match(finallyBlock, /rmSync\(tmp, \{ force: true \}\)/, '上传的临时文件必须清掉');
});

test('接线：两条路都落到 stageRestore，且都带版本提示', () => {
  const atStage = HOST.indexOf('const stageRestoreFrom = (zip) =>');
  assert.ok(atStage > 0, '没有共用的 stageRestoreFrom');
  const seg = HOST.slice(atStage, atStage + 700);
  assert.match(seg, /stageRestore\(\{ zip, root: dataDir\(\) \}\)/, '必须给 stageRestore 传数据目录');
  assert.match(seg, /versionGapText\(/, '版本提示不能漏');

  /** 两处入口都调同一个函数，别再各写一遍（定义是 `= (zip) =>`，不带括号，所以只数调用） */
  const hostRest = HOST.slice(atStage);
  assert.equal(
    hostRest.split('stageRestoreFrom(').length - 1, 2,
    'stageRestoreFrom 应当只有两处调用（restore-local 与 import）',
  );
});

test('接线：面板有导入按钮、清单里有「用它恢复」、成功文案点名「重启」', () => {
  assert.match(CLIENT, /'导入备份（zip）'/, '备份页 01 节缺导入按钮');
  assert.match(CLIENT, /'用它恢复'/, '备份清单缺整包恢复入口');
  assert.match(CLIENT, /\/backup\/import/, '导入按钮没接上接口');
  assert.match(CLIENT, /\/backup\/restore-local/, '清单恢复没接上接口');
  /**
   * 以前不做面板导入，就是怕人以为「点完就恢复了」。
   * 现在有按钮，这条文案就是那个约定——去掉它等于把顾虑丢了。
   */
  assert.match(HOST, /重启 DSH 后生效/, '成功返回必须写明重启才生效');
});
