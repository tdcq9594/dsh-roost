/**
 * 小型环形历史（心情历史 B4 / 召回日志 D3 共用）。
 *
 * 为什么不复用 `audit.log`：那是**面板写操作**的追责日志，一行一个 JSON、
 * 不做轮转；这两份是**运行期行为记录**，要有上限、能被面板读、能被清空，
 * 语义和生命周期都不同。
 *
 * 只存结构化字段，不存消息正文（`bot/README.md` 的「不存消息正文」铁律）：
 * recallLog 里连检索词都不留，只留长度和命中 id/分数/原因。这样即使面板
 * 把它展示出来，也不会变成第二份聊天记录。
 *
 * 200 条 × 约 150 字节 = 30 KB，每次 push 整文件重写足够轻；写盘失败
 * 一律吞掉，行为日志不能把聊天弄挂。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createHistoryRing({ file, max = 200, log = () => {} } = {}) {
  let rows = null;

  function load() {
    if (rows) return rows;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      rows = Array.isArray(raw) ? raw.filter((r) => r && typeof r === 'object') : [];
    } catch {
      rows = [];
    }
    return rows;
  }

  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(load()), 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      log(`写历史失败（不影响聊天）：${e.message}`);
    }
  }

  return {
    /** @param {object} row 结构化字段，调用方负责不塞正文 */
    push(row = {}) {
      const all = load();
      all.push({ at: Date.now(), ...row });
      if (all.length > max) all.splice(0, all.length - max);
      save();
      return all.length;
    },
    /** 最新在前。limit<=0 给全部 */
    list(limit = 50) {
      const all = [...load()].reverse();
      return limit > 0 ? all.slice(0, limit) : all;
    },
    clear() {
      rows = [];
      save();
    },
    get size() {
      return load().length;
    },
  };
}
