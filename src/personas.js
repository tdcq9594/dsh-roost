/**
 * 人格库。
 *
 * 照 Aurabot（`src/persona/personas.js`）的做法：
 *   · 一个人格 = 一个 Markdown 文件，可以带 `---` 头写 name / tags
 *   · 放数据目录，首次运行把仓库自带的复制过去，之后以数据目录为准
 *   · 配置里只记「当前用哪个」，正文在文件里
 *
 * 为什么不塞进 config.json：人格是**长文本**，混在 JSON 里没法编辑、
 * 没法加注释、也没法单独备份。Markdown 文件谁都能改，改完下一轮就生效。
 *
 * 0.10.7 起，仓库根目录的 `personas/` 是**内置人格的唯一定义处**（以前是
 * 这个文件里的 `BUILTIN` 常量）。搬出去的理由：
 *   1. 人格正文写进 JS 模板字符串，`\n` 和反引号都要转义，改一句话都得动代码；
 *   2. 面板要做「从仓库更新人格库」，得有一个能下发的**文件**——常量没法下发；
 *   3. 想在 GitHub 上直接改一份人格、提个 PR 的人，不该被要求先看懂 JS。
 * 现在常量没了，`seed()` 只是把 `personas/` 里缺的文件补进数据目录。
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const safeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'default';

/**
 * 旧字段 `persona.text` 要不要拼进提示词。
 *
 * **只在人格文件读不出正文时才用**（`persona.body` 为空）。
 *
 * 为什么必须这么判：0.10.0 起人格正文在 `personas/<id>.md` 里，
 * 而 `default.md` 的正文就是从这段 `text` 抄过去的，两段几乎一字不差。
 * 以前是无条件追加到提示词末尾，于是「换了大肥鱼，提示词最后仍挂着小栖那段」——
 * 而且它排最后、离历史最近，权重最大，表现出来就是「换了人格还是原来那个」。
 */
export function legacyPersonaText(persona, cfgText) {
  if (persona?.body) return '';
  return String(cfgText ?? '').trim();
}

/** 解析 `---` 头 + 正文 */
export function parsePersona(id, raw) {
  let text = String(raw ?? '').replace(/^\uFEFF/, '');
  const meta = { id, name: id, tags: [] };

  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      if (kv[1] === 'name') meta.name = kv[2].trim() || id;
      if (kv[1] === 'tags') {
        meta.tags = kv[2]
          .replace(/^\[|\]$/g, '')
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    text = text.slice(m[0].length);
  }
  /**
   * 把正文切成四段：性格 / 开场白 / 说话示例 / 世界书。
   *
   * 为什么要示例：散文写「活泼」，模型可能理解成「堆颜文字卖萌」；
   * 给两轮真实对话，长度、语气词密度、标点习惯一次校准到位。
   * **形容词告诉它方向，示例告诉它尺度。**（AstrBot 的 begin_dialogs 就是干这个的）
   *
   * 另外两段抄的是 SillyTavern 角色卡 V2 的思路：
   *   · `## 开场白` = first_mes，主动搭话时直接用，不用每次现编
   *   · `## 世界书` = character_book，**命中关键词才注入**，比全量注入省 token
   */
  let body = text.trim();
  const take = (title) => {
    /**
     * 注意：**不能用 `m` 标志**。
     * 多行模式下 `$` 只匹配行尾，`[\s\S]*?` 会停在第一行结束——
     * 结果「说话示例」只切出一行，剩下的示例全被当成性格正文。
     * 所以这里用 `(?:^|\n)##` 锚行首、`$` 靠非多行模式锚字符串末尾。
     */
    const re = new RegExp(`(?:^|\\n)##\\s*${title}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s|$)`);
    const hit = body.match(re);
    if (!hit) return '';
    body = (body.slice(0, hit.index) + body.slice(hit.index + hit[0].length)).trim();
    return hit[1].trim();
  };

  // 顺序有讲究：先取长的，避免「说话示例」被「说话」之类的前缀误吃
  const demos = take('说话示例');
  const firstMes = take('开场白');
  const loreRaw = take('世界书');
  body = body.trim();

  /**
   * 世界书一行一条：`触发词1, 触发词2 | 内容`
   *
   * 用 `|` 分隔而不是冒号，是因为内容里经常有冒号（"她说过：..."）。
   * 解析不了的行直接跳过——宁可少一条设定，也不能让整份人格崩掉。
   */
  const lore = loreRaw
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*·]\s*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('|');
      if (i < 0) return null;
      const keys = line
        .slice(0, i)
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const text2 = line.slice(i + 1).trim();
      return keys.length && text2 ? { keys, text: text2 } : null;
    })
    .filter(Boolean);

  return { ...meta, body, demos, firstMes, lore };
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir   数据目录（`personas/` 会建在这下面）
 * @param {string} [opts.builtinDir] 仓库自带的人格目录。默认取包根下的 `personas/`。
 *   **必须可覆盖**：测试要能塞一个假目录进去，否则测「文件缺失会补回」
 *   就得依赖真实仓库内容，改一份人格就会连带改一堆测试。
 * @param {(msg: string) => void} [opts.log]
 */
export function createPersonas({ dataDir, builtinDir, log = () => {} }) {
  const dir = () => join(dataDir, 'personas');

  /**
   * 仓库自带的人格目录。
   *
   * 用 `import.meta.dirname`（Node ≥20.11）而不是 `process.cwd()`：
   * DSH 的进程工作目录是用户的 profile 目录，跟本包装在哪毫无关系。
   * 这里指向 `<包根>/personas`——`src/` 的上一级。
   */
  const builtin = () => builtinDir ?? join(import.meta.dirname, '..', 'personas');

  /**
   * 把仓库自带的补进数据目录，**已存在的不覆盖**。
   *
   * 为什么不覆盖：数据目录那份是用户的。他可能改过措辞、加了群内梗，
   * 升级一次就被打回出厂设置是不可接受的。要更新得由用户点「从仓库更新」
   * （那条路会先备份、再按 `index.json` 的 sha256 判断该不该动）。
   */
  function seed() {
    try {
      mkdirSync(dir(), { recursive: true });
      let src = [];
      try {
        src = readdirSync(builtin());
      } catch (e) {
        // 打包漏了 `personas/` 就会走到这。不抛错——人格库空着机器人还能说话，
        // 抛出去会让整个插件加载失败，代价太大。
        log(`人格库目录读不到（${builtin()}）：${e.message}`);
        return;
      }
      for (const n of src) {
        if (!n.endsWith('.md')) continue;
        const f = join(dir(), n);
        if (existsSync(f)) continue;
        try {
          copyFileSync(join(builtin(), n), f);
        } catch (e) {
          log(`人格 ${n} 复制失败：${e.message}`);
        }
      }
    } catch (e) {
      log(`人格库初始化失败：${e.message}`);
    }
  }

  return {
    seed,

    /** 仓库自带目录的绝对路径，面板「从仓库更新」要拿它做本地基准 */
    builtinDir: builtin,

    /** 列出来给面板用（不含正文，正文可能很长） */
    list() {
      seed();
      const out = [];
      try {
        for (const n of readdirSync(dir())) {
          if (!n.endsWith('.md')) continue;
          const id = n.slice(0, -3);
          try {
            const p = parsePersona(id, readFileSync(join(dir(), n), 'utf8'));
            out.push({ id, name: p.name, tags: p.tags, chars: p.body.length });
          } catch {}
        }
      } catch {}
      return out.sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.id.localeCompare(b.id)));
    },

    read(id) {
      seed();
      const f = join(dir(), `${safeId(id)}.md`);
      if (!existsSync(f)) return null;
      const raw = readFileSync(f, 'utf8');
      return { ...parsePersona(safeId(id), raw), raw };
    },

    /** 存一个人格（面板编辑用）。id 会做安全过滤，防路径穿越 */
    save(id, raw) {
      seed();
      const clean = safeId(id);
      writeFileSync(join(dir(), `${clean}.md`), String(raw ?? ''), 'utf8');
      return { id: clean };
    },

    remove(id) {
      const clean = safeId(id);
      if (clean === 'default') throw new Error('默认人格不能删');
      const f = join(dir(), `${clean}.md`);
      if (existsSync(f)) unlinkSync(f);
      return { id: clean };
    },

    /**
     * 这个会话该用哪个人格。
     *
     * 优先级：按群指定 > 全局当前 > default。
     * 指定的不存在时**静默回退**——人格文件被删了不该让机器人失声。
     */
    resolve(chatId, personaCfg = {}) {
      seed();
      const byChat = personaCfg.byChat ?? {};
      const want = byChat[chatId] || personaCfg.current || 'default';
      const got = this.read(want) || this.read('default');
      return got || { id: 'default', name: '小栖', body: '', tags: [] };
    },
  };
}
