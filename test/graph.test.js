import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGraph } from '../src/graph.js';


/**
 * `close({final})` 语义（2026-11 复核）。
 *
 * 默认（final）= 收尾，之后任何写都不许把库重新打开；`final:false` 是
 * 「备份前 checkpoint、之后接着用」，一键改写靠它。
 */
test('图谱：close() 之后不再重开，close({final:false}) 之后还能用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-graph-close-'));
  try {
    const file = join(dir, 'graph.sqlite');
    const g = createGraph({ file, log: () => {} });
    g.addEpisode({ chatId: 'g1', text: '今天聊了天气', at: 1 });
    const before = g.stats().episodes;

    g.close({ final: false });
    g.addEpisode({ chatId: 'g1', text: '关完还能写', at: 2 });
    assert.equal(g.stats().episodes, before + 1, 'final:false 之后要能继续写');

    g.close();
    g.addEpisode({ chatId: 'g1', text: '关掉之后不许写', at: 3 });
    /** `stats()` 在没连上时回 `{enabled:false}`（和 journal 的 null 不同口径） */
    assert.equal(g.stats().enabled, false, '收尾之后读操作空转（库没被重开）');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
