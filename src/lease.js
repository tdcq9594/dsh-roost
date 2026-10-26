/**
 * 端口租约。
 *
 * 解决的是「谁说了算」这个问题：配置里写的是**意愿**（用户希望用 17321），
 * 实际 bind 成功的是**现实**（可能变成 17322）。两者混在一起就会互相打架：
 * 自动改了实际端口，配置没改，重启又回到被占的那个。
 *
 * 所以分开存：
 *   want   —— 配置里的值，**永远不改**（那是用户写的）
 *   actual —— 实际 bind 成功的，每次启动重写
 *
 * 文件放在 Roost 的数据目录下（`<roost>/data/ports.json`），
 * 两边都能算出来，谁先起都行。用文件而不是 HTTP 通知，是因为
 * 「Roost 想通知 dsh-roost，但它不知道 dsh-roost 换到哪了」——鸡生蛋。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** 往后试多少个端口。20 够用了，再多就是扫别人服务了 */
export const SCAN = 20;

/**
 * 从「意愿」推出候选列表：先 want，再 want+1 … want+SCAN。
 * 去重，因为上次的 actual 可能就在这个区间里。
 */
export function candidates(want, lastActual, scan = SCAN) {
  const out = [];
  const push = (p) => {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0 && n < 65536 && !out.includes(n)) out.push(n);
  };
  push(lastActual);
  push(want);
  for (let i = 1; i <= scan; i++) push(Number(want) + i);
  return out;
}

export function createLease({ file, log = () => {} }) {
  function read() {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      // 文件不存在、坏了、权限不对 —— 都当作「没有租约」。
      // 不能因为一个坏文件就让服务起不来。
      return {};
    }
  }

  /**
   * 写一个槽位。**原子写**：先写 .tmp 再 rename，
   * 避免另一侧读到写了一半的 JSON。
   */
  function claim(kind, { want, actual, pid = process.pid }) {
    const all = read();
    all[kind] = { want: Number(want) || 0, actual: Number(actual) || 0, pid, at: new Date().toISOString() };
    try {
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      log(`端口租约写不进去（不影响运行）：${e.message}`);
    }
    return all[kind];
  }

  /** 拿某个槽位的实际端口（没有就 null） */
  function actualOf(kind) {
    const n = Number(read()?.[kind]?.actual);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /** 拿某个槽位的意愿端口 */
  function wantOf(kind) {
    const n = Number(read()?.[kind]?.want);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  return { file, read, claim, actualOf, wantOf };
}
