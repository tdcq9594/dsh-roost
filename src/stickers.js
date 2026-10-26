/**
 * 表情包库。
 *
 * 思路：**不发明新机制**。我们已经能让模型发图（`<<image: 路径>>`），
 * 缺的只是「它不知道有哪些图可用」。所以这个模块只做一件事——
 * 扫一遍目录，把清单写进提示词。
 *
 * 标签从文件名来：`开心_猫.png` → `开心`、`猫`。
 * 中文名直接能用，不用额外维护索引文件。
 */

import { readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const OK_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** 一次最多列几个（列太多会吃掉提示词预算） */
export const MAX_LIST = 40;

/**
 * 从文件名拆标签：`开心_猫-2.png` → ['开心', '猫']
 * 分隔符认 `_` `-` 空格，末尾的序号丢掉。
 */
export function tagsOf(file) {
  const name = basename(file, extname(file));
  return name
    .split(/[_\-\s]+/)
    .map((s) => s.trim())
    .filter((s) => s && !/^\d+$/.test(s))
    .slice(0, 4);
}

export function createStickers({ dataDir, log = () => {} }) {
  const dirOf = (cfg = {}) => cfg.dir || join(dataDir, 'stickers');

  return {
    /** 目录（首次会建出来，用户往里丢图就行） */
    dir(cfg) {
      const d = dirOf(cfg);
      try {
        if (!existsSync(d)) mkdirSync(d, { recursive: true });
      } catch (e) {
        log(`表情包目录建不出来：${e.message}`);
      }
      return d;
    },

    /** 扫一遍，返回 [{file, path, tags}] */
    list(cfg = {}, { max = MAX_LIST } = {}) {
      const d = dirOf(cfg);
      const out = [];
      try {
        for (const n of readdirSync(d)) {
          if (!OK_EXT.has(extname(n).toLowerCase())) continue;
          const p = join(d, n);
          try {
            if (!statSync(p).isFile()) continue;
          } catch {
            continue;
          }
          out.push({ file: n, path: p, tags: tagsOf(n) });
          if (out.length >= max) break;
        }
      } catch {}
      return out.sort((a, b) => a.file.localeCompare(b.file));
    },

    /**
     * 拼给模型看的一段清单。
     *
     * 为什么给**完整路径**而不是让模型拼 `表情:标签`：
     * 解析标签得让 ai-chat 知道表情目录，那是跨仓库的耦合。
     * 直接给路径，模型原样输出，ai-chat 的扩展名白名单就能过——零耦合。
     */
    prompt(cfg = {}) {
      if (cfg.enabled === false) return '';
      const list = this.list(cfg);
      if (!list.length) return '';
      const d = dirOf(cfg);
      const items = list.map((s) => `${s.file}（${s.tags.join('/') || '无标签'}）`).join('、');
      return [
        `【表情包】共 ${list.length} 张，都在 ${d} 下：`,
        items,
        '想发表情时用 <<image: 完整路径>>，例如：',
        `<<image: ${join(d, list[0].file)}>>`,
      ].join('\n');
    },

    /**
     * 把 `表情:标签` 解析成本地路径。
     *
     * 匹配规则：标签**全部命中**优先，退而求其次命中一个也算。
     * 都匹配不上返回 null，调用方退回普通图片逻辑。
     */
    resolve(cfg, want) {
      const q = String(want ?? '').trim();
      if (!q) return null;
      const list = this.list(cfg, { max: 400 });

      // 直接给了文件名
      const byName = list.find((s) => s.file === q || s.file === `${q}.png` || s.file === `${q}.gif`);
      if (byName) return byName.path;

      const m = q.match(/^表情[:：]\s*(.+)$/);
      if (!m) return null;
      const keys = m[1].split(/[\s,，/]+/).filter(Boolean);
      if (!keys.length) return null;

      let best = null;
      let bestScore = 0;
      for (const s of list) {
        const hit = keys.filter((k) => s.tags.some((t) => t.includes(k))).length;
        if (hit > bestScore) {
          best = s;
          bestScore = hit;
        }
      }
      return best ? best.path : null;
    },
  };
}
