// 自驱技能层：整段移植自 aurabot skills.js 的 createSkillStore，验最小闭环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillStore } from '../src/autotelic-skills.js';

const mk = (opts = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'skills-'));
  const personaFile = join(root, 'persona.md');
  writeFileSync(personaFile, '# 人格卡\n\n正文不动。\n', 'utf8');
  const store = createSkillStore(join(root, 'skills'), { personaFile, ...opts });
  return { root, store, personaFile };
};

test('recordOutcome：真实 done 才加分，模型自评 score 一律丢弃', async () => {
  const { root, store } = mk();
  try {
    // ingestReflection 塞 score=0.99，落库后不该有这个分
    await store.ingestReflection({ roundId: 'r1', tag: '裁切', lesson: '先看分辨率', score: 0.99 });
    const before = store.get('r1');
    assert.ok(before, '记忆层落下来了');
    assert.notEqual(before.meta.score, 0.99, '模型自评不能改分');

    /** recordOutcome 按 skillId/tag 找条目（不按 roundId），模型自评 score 字段被丢弃。
     *  done 会同时触发 memory→skills 晋升（新文档 score 重置 0.5），所以验「真实终态触发晋升」，
     *  不验新文档分数——加分落在晋升前的 memory 层，晋升后按对方口径重置。 */
    const r = await store.recordOutcome({ tag: '裁切', status: 'done', score: 0.99 });
    assert.equal(r.ok, true);
    assert.ok((r.promoted || []).some((p) => p.includes('memory→skills')), '真实 done 触发晋升');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('写前快照 + 人格卡附加段可剥离', async () => {
  const { root, store, personaFile } = mk();
  try {
    await store.ingestReflection({ roundId: 'r2', tag: '问候', lesson: '简短点' });
    await store.recordOutcome('r2', 'done');
    // 快照目录应存在
    const hist = join(root, 'skills', 'history');
    assert.ok(existsSync(hist), '写前快照目录要有');
    assert.ok(readdirSync(hist).length > 0, '至少有一个时间戳快照');

    /** 人格卡附加段：addonText(id,title,content) 生成标记段，写进卡后 stripInstinctAddons(file) 能剥掉且正文保留 */
    const addon = store.addonText('inst-1', '问候本能', '简短点');
    assert.ok(addon, '能生成附加段');
    writeFileSync(personaFile, `${readFileSync(personaFile, 'utf8')}\n${addon}\n`, 'utf8');
    store.stripInstinctAddons(personaFile);
    assert.match(readFileSync(personaFile, 'utf8'), /正文不动/, '剥离后主卡正文不受影响');
    assert.doesNotMatch(readFileSync(personaFile, 'utf8'), /问候本能/, '附加段被剥掉');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('同一终态重复记账幂等，不重复加分', async () => {
  const { root, store } = mk();
  try {
    await store.ingestReflection({ roundId: 'r3', tag: '整理', lesson: '分类' });
    const a = await store.recordOutcome('r3', 'done');
    const s1 = store.get('整理')?.score;
    await store.recordOutcome('r3', 'done');
    const s2 = store.get('整理')?.score;
    assert.equal(s2, s1, '同一终态重放不该重复加分');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
