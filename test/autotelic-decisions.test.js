// 决策审计哈希链：移植自 aurabot plan.js，验证链完整/篡改/断点宽容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecisionLog, verifyDecisionLog } from '../src/autotelic-decisions.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'dec-log-'));

test('决策日志：逐阶段落行、链完整、verify 过', async () => {
  const d = tmp();
  try {
    const file = join(d, 'decisions.jsonl');
    const log = createDecisionLog({ file });
    await log.append('intent', 1, { candidates: 2 });
    await log.append('gate', 1, { verdicts: ['pass'] });
    const r = await verifyDecisionLog(file);
    assert.equal(r.ok, true);
    assert.equal(r.total, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('决策日志：篡改 payload 必被抓', async () => {
  const d = tmp();
  try {
    const file = join(d, 'decisions.jsonl');
    const log = createDecisionLog({ file });
    await log.append('intent', 1, { candidates: 2 });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[0]);
    rec.payload.candidates = 99;
    writeFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
    const r = await verifyDecisionLog(file);
    assert.equal(r.ok, false, '改了 payload 必须断链');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('决策日志：没有文件时验链为空且完好', async () => {
  const d = tmp();
  try {
    const r = await verifyDecisionLog(join(d, 'none.jsonl'));
    assert.equal(r.ok, true);
    assert.equal(r.total, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
