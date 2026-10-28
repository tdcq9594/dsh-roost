// 重试调度的测试。
//
// 这段代码平时不说话——只在「Roost 起得比 dsh-roost 晚」时才起作用。
// 也正因如此，写错了没人会发现：面板红字照样在，用户照样被支使去
// 「接入」第 5 步手动写一次。所以这里用假定时器把节奏和边界全钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncRetry } from '../src/sync-retry.js';

/** 假定时器：不真等，手动推进 */
function fakeClock() {
  const queued = [];
  let clock = 0;
  return {
    now: () => clock,
    setT: (fn, ms) => {
      const t = { fn, ms, at: clock + ms, cleared: false };
      queued.push(t);
      return { unref() {}, __t: t };
    },
    clearT: (h) => {
      if (h?.__t) h.__t.cleared = true;
    },
    /** 推进时间，把到点的任务跑掉 */
    advance(ms) {
      clock += ms;
      for (const t of queued) {
        if (!t.cleared && !t.ran && t.at <= clock) {
          t.ran = true;
          t.fn();
        }
      }
    },
    get queued() { return queued; },
    get pending() { return queued.filter((t) => !t.cleared && !t.ran); },
  };
}

function make(opts = {}) {
  const c = fakeClock();
  const logs = [];
  const runs = [];
  const retry = createSyncRetry({
    run: (a) => runs.push(a),
    log: (m) => logs.push(m),
    now: c.now,
    setT: c.setT,
    clearT: c.clearT,
    ...opts,
  });
  return { retry, clock: c, logs, runs };
}

test('重试：第一次排 5 秒，不是立刻打一次', () => {
  const { retry, clock } = make();
  assert.equal(retry.schedule(17322), 5_000);
  assert.equal(retry.tries, 1);
  assert.equal(clock.pending.length, 1);
});

test('重试：排队中再来一次不叠加（否则失败一次变两条链）', () => {
  const { retry, clock } = make();
  retry.schedule(17322);
  assert.equal(retry.schedule(17322), null, '已经排了就不该再排');
  assert.equal(retry.tries, 1, '次数不该涨');
  assert.equal(clock.pending.length, 1, '只能有一个待跑的任务');
});

test('重试：前 6 次快、之后慢下来，别一直每 5 秒敲一次', () => {
  const { retry, clock } = make();
  const delays = [];
  for (let i = 0; i < 8; i++) {
    delays.push(retry.schedule(17322));
    // 推进足够长，把待跑的那个真的跑掉（模拟这次又失败了，回来再排）
    clock.advance(60_000);
  }
  assert.deepEqual(delays, [5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 60_000, 60_000]);
});

test('重试：到点真的去跑 run，并带上实际端口', () => {
  const { retry, clock, runs } = make();
  retry.schedule(17325);
  clock.advance(5_000);
  assert.deepEqual(runs, [17325]);
});

test('重试：run 抛错不许把进程带崩', () => {
  const logs = [];
  const c = fakeClock();
  const retry = createSyncRetry({
    run: () => { throw new Error('炸了'); },
    log: (m) => logs.push(m),
    now: c.now, setT: c.setT, clearT: c.clearT,
  });
  retry.schedule(17321);
  assert.doesNotThrow(() => c.advance(5_000));
  assert.match(logs.join(''), /重试同步出错/);
});

test('重试：超过上限就放弃，并且只说一次', () => {
  const { retry, clock, logs } = make({ maxMs: 60_000, fastTimes: 100, fastMs: 5_000 });
  retry.schedule(17321);
  clock.advance(70_000); // 越过上限
  assert.equal(retry.schedule(17321), null, '超时后不该再排');
  assert.equal(retry.tries, 0, '放弃时要清干净');
  assert.equal(logs.length, 1, '只提醒一次，别每次失败都刷屏');
  assert.match(logs[0], /手动写一次/);
});

test('重试：reset 能作废队列——端口重启后不能改回旧端口', () => {
  const { retry, clock, runs } = make();
  retry.schedule(17322);
  retry.reset();
  assert.equal(retry.pending, false);
  assert.equal(retry.tries, 0);
  clock.advance(60_000);
  assert.deepEqual(runs, [], '作废之后不该再跑（否则会把 ai-chat 改回没人听的端口）');
});

test('重试：成功后 reset 一次，之后还能为下一次端口变化重新开始', () => {
  const { retry, clock } = make();
  retry.schedule(17322);
  retry.reset();
  assert.equal(retry.schedule(17323), 5_000, '重新开始应该是快的，不是 60 秒');
  clock.advance(5_000);
  assert.equal(retry.tries, 1);
});
