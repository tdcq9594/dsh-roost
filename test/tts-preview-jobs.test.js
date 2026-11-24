import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPreviewJobs, PREVIEW_JOB_TTL } from '../src/tts-preview-jobs.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('试听任务：提交后先 running，完成后带音频结果', async () => {
  let clock = 1_000;
  const jobs = createPreviewJobs({ now: () => clock });
  const started = jobs.start(async ({ update }) => {
    update({ phase: '合成中', progress: 40 });
    await tick();
    return { ok: true, audio: 'YQ==', bytes: 1 };
  });
  assert.equal(started.status, 'running');
  assert.equal(started.phase, '排队中');

  await tick();
  const mid = jobs.get(started.id);
  assert.equal(mid.status, 'running');
  assert.equal(mid.phase, '合成中', '后台改的 phase 要能在轮询里看到');
  await tick();

  const done = jobs.get(started.id);
  assert.equal(done.status, 'done');
  assert.equal(done.progress, 100);
  assert.equal(done.result.audio, 'YQ==');
});

test('试听任务：异常按 status/code/message 存，不让轮询拿到裸栈', async () => {
  const jobs = createPreviewJobs();
  const err = Object.assign(new Error('上游 401'), { status: 401, code: 'auth_failed' });
  const started = jobs.start(async () => { throw err; });
  await tick();

  const job = jobs.get(started.id);
  assert.equal(job.status, 'error');
  assert.equal(job.error.status, 401);
  assert.equal(job.error.code, 'auth_failed');
  assert.equal(job.error.message, '上游 401');
  assert.equal(JSON.stringify(job).includes('at '), false);
});

test('试听任务：get 返回快照，外部改不到内部状态', async () => {
  const jobs = createPreviewJobs();
  const started = jobs.start(async () => ({ ok: true }));
  const first = jobs.get(started.id);
  first.status = 'done';
  first.progress = 999;
  assert.equal(jobs.get(started.id).status, 'running', '快照不能被外部改写');
  await tick();
  assert.equal(jobs.get(started.id).status, 'done');
});

test('试听任务：未知 id 返回 null，过期结果自动清掉', async () => {
  let clock = 10_000;
  const jobs = createPreviewJobs({ now: () => clock });
  assert.equal(jobs.get('nope'), null);

  const started = jobs.start(async () => ({ ok: true }));
  await tick();
  assert.equal(jobs.size(), 1);

  clock += PREVIEW_JOB_TTL + 1;
  assert.equal(jobs.get(started.id), null, '超期结果直接当作不存在，不再把旧音频发给前端');
  assert.equal(jobs.size(), 0);
});

test('试听任务：同步抛错也进 error，不会卡在 running', async () => {
  const jobs = createPreviewJobs();
  const started = jobs.start(() => { throw new Error('boom'); });
  await tick();
  const job = jobs.get(started.id);
  assert.equal(job.status, 'error');
  assert.equal(job.error.code, 'tts_failed');
});
