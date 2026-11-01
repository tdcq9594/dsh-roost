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
 *
 * 0.11 起多了两样东西（都在 `personas/` 下，都是点文件，`list()` 不会当成
 * 人格扫进去）：
 *   · `.catalog.json`——派生索引，避免每次开面板全量读文件（见 `catalog.js`）；
 *   · `.prefs.json`——用户态（收藏/置顶/分组/使用次数/删除墓碑），**同步永不碰**。
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createCatalog } from './catalog.js';
import { createPrefs } from './prefs.js';

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

/**
 * 她的名字：**全局唯一**（0.11 起名字是账号身份，不是人格属性）。
 *
 * 回退链：配置 → 人格 label → 人格 id → 大肥鱼。
 * 做成纯函数是为了能测：提示词里用的一定得是这个名字。
 */
export function personaName(cfgName, persona) {
  const n = String(cfgName || '').trim();
  if (n) return n;
  return String(persona?.label || persona?.name || persona?.id || '').trim() || '大肥鱼';
}

/** 解析 `---` 头 + 正文 */
export function parsePersona(id, raw) {
  let text = String(raw ?? '').replace(/^\uFEFF/, '');
  /**
   * `label` 是 0.11 的新字段（面板显示用）；`name` 废弃，仍认，当 label 的别名。
   * 名字本身不再由人格决定——见 `config.persona.name`。
   */
  const meta = { id, name: id, label: id, tags: [], tools: null };
  let labelField = '';
  let nameField = '';

  /**
   * 头部的匹配放宽一点：允许前导空行、分隔符行尾的空格、**空头**（`---\n---`）。
   *
   * 以前是 `^---\n`，手写时开头多一个空行、或者写成 `--- `（尾随空格），
   * 整段头就认不出来——结果是 `tools: []` 被当成正文、限制静默失效。
   * 空头那一条同理：认不出来时 `tools` 会变成 null（全开），方向正好反了。
   */
  const m = text.match(/^\s*---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?---[ \t]*(?:\r?\n|$)/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      /**
       * 键名容忍缩进和大小写：`  tools: []` 和 `Tools: []` 都是很自然的写法。
       * 认不出来的后果不是「少一条元数据」，而是 `tools` 静默变 null（全开）——
       * 方向正好反，所以这里宁可放宽。
       */
      const kv = line.match(/^\s*([A-Za-z_]\w*)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      if (key === 'label') labelField = kv[2].trim();
      if (key === 'name') nameField = kv[2].trim();
      if (key === 'tags') {
        meta.tags = kv[2]
          .replace(/^\[|\]$/g, '')
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      /**
       * `tools`：这个格能碰哪些工具。三元语义（抄 AstrBot persona_plus）：
       *   · 省略 / `null` → 不限制（自己写的人格，保持旧行为）
       *   · `[]` / 空值    → 一个都不给（**市场安装时会补写这个**；内置人格由作者显式声明）
       *   · `[a, b]`       → 只给这两个
       *
       * 「空值按全禁」是 fail-closed：写了一半的 `tools:`（本想禁掉）不该
       * 变成「全开」。真要全开就写 `null`，那个是显式的。
       *
       * 另外顺手去掉引号和行尾 `#` 注释——`tools: "qq_send"` 和
       * `tools: [a] # 只给聊天` 都是很自然的写法，不处理就会变成
       * 一个永远匹配不上的名字，限制静默错位。
       */
      if (key === 'tools') {
        const v = kv[2].split('#')[0].trim();
        if (/^null$/i.test(v)) meta.tools = null;
        else if (!v) meta.tools = [];
        else {
          meta.tools = v
            .replace(/^\[|\]$/g, '')
            .split(/[,，]/)
            .map((s) => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        }
      }
    }
    text = text.slice(m[0].length);
  }
  /** label 优先，其次废弃的 name，最后退回 id；`name` 保留同值给旧消费方 */
  meta.label = labelField || nameField || id;
  meta.name = meta.label;
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

  const catalog = createCatalog({ dir, parse: parsePersona, log });
  const prefs = createPrefs({ dir, log });

  /**
   * 一个进程只补一次。
   *
   * 以前 `seed()` 在 list / read / save / resolve 里各调一次，而 `resolve()`
   * 每轮对话被调两次（人格 + 近处指令）——300 份人格时就是每轮 4 次 readdir
   * 加 1200 次 `existsSync`。补缺这件事一个进程做一次就够。
   */
  let seeded = false;

  /**
   * 解析结果的内存缓存：`id → { sha, parsed }`。
   *
   * 为什么 catalog 不够：catalog 只存元数据（name/tags/chars/sha），
   * 而 `resolve()` 要的是 `body / demos / lore / firstMes`。正文不进 catalog
   * （那会把一个派生文件撑到几 MB），所以正文单独在内存里缓存一份，
   * **按 sha 失效**——文件一变，sha 就变，缓存自然不命中。
   */
  const parsedCache = new Map();

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
      /**
       * 墓碑：用户删掉的内置人格不要再塞回来。
       *
       * 以前 `remove()` 只 unlink，下一次 `list()` 里 `seed()` 又把它拷回来——
       * 也就是说**内置人格其实删不掉**。现在靠 `.prefs.json` 的 `deleted` 记住。
       */
      const deleted = new Set(prefs.read().deleted);
      for (const n of src) {
        if (!n.endsWith('.md')) continue;
        if (deleted.has(n.slice(0, -3))) continue;
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

  function ensureSeeded() {
    if (seeded) return;
    seeded = true;
    seed();
  }

  /**
   * 删除/覆盖前备份到 `personas/.backup/<时间戳>/`。
   *
   * 为什么放在这里而不是 `persona-repo`：**删除也要备份**。
   * 以前只有「一键更新覆盖」会备份，删掉一个自己写的人格就真的没了。
   * 两条路径必须用同一份规则，否则备份目录会长成两种样子。
   */
  function backup(id, file) {
    const name = file || `${safeId(id)}.md`;
    const src = join(dir(), name);
    if (!existsSync(src)) return '';
    try {
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const bdir = join(dir(), '.backup', ts);
      mkdirSync(bdir, { recursive: true });
      const target = join(bdir, `${safeId(id)}.md`);
      writeFileSync(target, readFileSync(src, 'utf8'), 'utf8');
      pruneBackups();
      return target;
    } catch (e) {
      log(`备份人格失败：${e.message}`);
      return '';
    }
  }

  /** 只留最近 5 次。人格是几 KB，但没人希望备份目录无限长 */
  function pruneBackups() {
    try {
      const root = join(dir(), '.backup');
      const dirs = readdirSync(root).sort();
      for (const d of dirs.slice(0, Math.max(0, dirs.length - 5))) {
        rmSync(join(root, d), { recursive: true, force: true });
      }
    } catch {}
  }

  /** 按 id 取解析结果；`items` 是同一轮 scan 的快照，避免一次 resolve 扫两遍 */
  function parsedOf(items, id) {
    const item = items[id];
    if (!item) return null;
    const hit = parsedCache.get(id);
    if (hit && hit.sha === item.sha256) return hit.parsed;
    let raw;
    try {
      raw = readFileSync(join(dir(), item.file), 'utf8');
    } catch {
      return null;
    }
    const parsed = parsePersona(id, raw);
    parsedCache.set(id, { sha: item.sha256, parsed });
    return parsed;
  }

  return {
    /** 显式补缺（面板/测试用）。日常路径走 `ensureSeeded()`，只跑一次 */
    seed,

    /** 仓库自带目录的绝对路径，面板「从仓库更新」要拿它做本地基准 */
    builtinDir: builtin,

    /** 派生索引与用户态，给 `persona-repo` 用（它要 sha 和 chars 判断状态） */
    catalog,
    prefs,

    /** 备份一份人格到 `.backup/<时间戳>/`（删除与覆盖共用同一条规则） */
    backup,

    /**
     * 列出来给面板用（不含正文，正文可能很长）。
     *
     * `chars` 是**整份原文**长度，跟 `personas/index.json` 口径一致。
     * 以前用 `body.length`（不含示例和世界书），同一份人格在 her 页和市场页
     * 会显示两个数字。
     */
    list() {
      ensureSeeded();
      return catalog
        .list()
        // tags 拷一份：调用方 push 一下就会污染内存里的 catalog
        .map((m) => ({
          id: m.id,
          // 0.11：label 是显示名；name 保留同值，给还没改的老客户端
          label: m.label || m.name || m.id,
          name: m.label || m.name || m.id,
          tags: [...m.tags],
          chars: m.chars,
          /** 文件 mtime：治理页用它判断「刚装的别急着建议删」 */
          mtimeMs: m.mtimeMs || 0,
        }))
        .sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.id.localeCompare(b.id)));
    },

    read(id) {
      ensureSeeded();
      const clean = safeId(id);
      const item = catalog.get(clean);
      if (!item) return null;
      const raw = readFileSync(join(dir(), item.file), 'utf8');
      return { ...parsePersona(clean, raw), raw };
    },

    /** 存一个人格（面板编辑用）。id 会做安全过滤，防路径穿越 */
    save(id, raw) {
      ensureSeeded();
      const clean = safeId(id);
      // seed 只跑一次之后，`personas/` 被外部删掉就没人重建了——这里自己兜底
      mkdirSync(dir(), { recursive: true });
      const f = join(dir(), `${clean}.md`);
      // 覆盖旧内容前也备份：注释里说「删除/覆盖共用同一条规则」，那就得真共用
      if (existsSync(f)) backup(clean, `${clean}.md`);
      writeFileSync(f, String(raw ?? ''), 'utf8');
      // 用户又写了这个 id，说明他想要它——从墓碑里摘掉
      try {
        const p = prefs.read();
        if (p.deleted.includes(clean)) prefs.patch({ deleted: p.deleted.filter((x) => x !== clean) });
      } catch {}
      catalog.invalidate();
      parsedCache.delete(clean);
      return { id: clean };
    },

    remove(id) {
      const clean = safeId(id);
      if (clean === 'default') throw new Error('默认人格不能删');
      const item = catalog.get(clean);
      const file = item ? item.file : `${clean}.md`;
      const f = join(dir(), file);
      if (existsSync(f)) {
        /**
         * 备份失败就**不删**。
         *
         * 这批改动的卖点就是「删错能捞回」；备份没成还照删，等于把承诺作废。
         * 宁可让用户看到「备份失败，已取消删除」，也不能默默把文件干掉。
         */
        const saved = backup(clean, file);
        if (!saved) throw new Error('备份失败，已取消删除');
      }
      if (existsSync(f)) unlinkSync(f);
      /**
       * 墓碑**无条件写**，不只看「本地包里有没有这份」。
       *
       * 从仓库装进来的人格不在本地 `personas/` 里，但它同样在仓库清单里——
       * 只按本地包判断的话，删掉它不会留墓碑，下次一键更新又装回来
       * （实测：updated=1, deleted=0）。删掉这个动作对那半个集合就不成立。
       */
      try {
        const p = prefs.read();
        prefs.patch({ deleted: [...new Set([...p.deleted, clean])] });
      } catch {}
      catalog.invalidate();
      parsedCache.delete(clean);
      return { id: clean };
    },

    /**
     * 批量删除：**一个批次一个目录 + manifest**。
     *
     * 不能循环调 `remove()`：那样每次 `backup()` 都自己算时间戳，17 份散成 17 个目录，
     * `pruneBackups()` 只留最近 5 个目录，会把自己这一批的一部分先删掉。
     * manifest 是撤销的唯一依据，没有它就只能人工去备份目录里翻。
     */
    removeMany(ids, refs = {}) {
      const list = [...new Set((ids || []).map(safeId))].filter((x) => x !== 'default');
      if (!list.length) return { ok: true, batch: null, removed: [], skipped: [] };

      /**
       * **先 prune 再建目录**：`pruneBackups()` 只留 5 个目录，先建后 prune 的话，
       * 只要 .backup 里已有 5 个更晚的目录（时钟回拨、从别的机器拷来），
       * 刚建的这一批会立刻被自己删掉——文件已 unlink，撤销就永久没了。
       */
      pruneBackups();

      const base = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      /** 同一秒内两次批量删除不能共用一个目录：manifest 会被覆盖，前一批的备份也会被一起删 */
      let ts = base;
      let n = 1;
      while (existsSync(join(dir(), '.backup', ts))) ts = `${base}-${++n}`;
      const bdir = join(dir(), '.backup', ts);
      mkdirSync(bdir, { recursive: true });

      const removed = [];
      const skipped = [];
      const items = [];
      for (const id of list) {
        const item = catalog.get(id);
        const file = item ? item.file : `${id}.md`;
        const f = join(dir(), file);
        try {
          if (!existsSync(f)) {
            /** 不存在的 id 不能算「已删」：撤销时恢复不了，还会留一个无主墓碑 */
            skipped.push({ id, why: '文件不存在' });
            continue;
          }
          writeFileSync(join(bdir, `${safeId(id)}.md`), readFileSync(f, 'utf8'), 'utf8');
          unlinkSync(f);
          items.push({ id, file, deletedAt: Date.now() });
          removed.push(id);
        } catch (e) {
          skipped.push({ id, why: e.message });
        }
      }

      if (!items.length) {
        try { rmSync(bdir, { recursive: true, force: true }); } catch {}
        return { ok: true, batch: null, removed, skipped };
      }

      /** 记下被删人格占用的会话引用，撤销时一起写回（否则「恢复」只恢复文件） */
      const keptRefs = {};
      for (const [chatId, pid] of Object.entries(refs || {})) {
        if (removed.includes(pid)) keptRefs[chatId] = pid;
      }
      writeFileSync(join(bdir, 'manifest.json'), JSON.stringify({ ts, items, byChat: keptRefs }, null, 2), 'utf8');
      try {
        const p = prefs.read();
        prefs.patch({ deleted: [...new Set([...p.deleted, ...removed])] });
      } catch {}
      catalog.invalidate();
      for (const id of removed) parsedCache.delete(id);
      // 不再 prune：开头已经 prune 过，建完再 prune 有把自己删掉的风险
      return { ok: true, batch: ts, removed, skipped };
    },

    /** 撤销一个批次：按 manifest 回拷、清墓碑、删掉批次目录 */
    undoBatch(ts) {
      const name = String(ts || '').trim();
      if (!/^[0-9-]+$/.test(name)) throw new Error('批次号不合法');
      const bdir = join(dir(), '.backup', name);
      const mf = join(bdir, 'manifest.json');
      if (!existsSync(mf)) throw new Error('这一批没有 manifest，没法自动撤销');

      const man = JSON.parse(readFileSync(mf, 'utf8'));
      const restored = [];
      for (const it of man.items || []) {
        const src = join(bdir, `${safeId(it.id)}.md`);
        if (!existsSync(src)) continue;
        /** 撤销会覆盖同名文件（用户可能在这期间又建了一个）——先备份再写 */
        if (existsSync(join(dir(), it.file))) backup(it.id, it.file);
        writeFileSync(join(dir(), it.file), readFileSync(src, 'utf8'), 'utf8');
        restored.push(it.id);
      }
      try {
        const p = prefs.read();
        prefs.patch({ deleted: p.deleted.filter((x) => !restored.includes(x)) });
      } catch {}
      catalog.invalidate();
      for (const id of restored) parsedCache.delete(id);
      try { rmSync(bdir, { recursive: true, force: true }); } catch {}
      return { ok: true, batch: name, restored, byChat: man.byChat || {} };
    },

    /** 最近几个「可撤销」的批次（有 manifest 的），给面板显示撤销按钮 */
    batches() {
      const root = join(dir(), '.backup');
      try {
        return readdirSync(root)
          .sort()
          .reverse()
          .map((ts) => {
            try {
              const man = JSON.parse(readFileSync(join(root, ts, 'manifest.json'), 'utf8'));
              return { ts, count: (man.items || []).length, at: (man.items || [])[0]?.deletedAt || 0 };
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    },

    /**
     * 这个会话该用哪个人格。
     *
     * 优先级：按群指定 > 全局当前 > default。
     * 指定的不存在时**静默回退**——人格文件被删了不该让机器人失声。
     *
     * 一次 scan 拿快照，两次查表都在这份快照上做：`resolve()` 每轮被调两次，
     * 每次都重扫一遍目录没必要。
     *
     * 注意返回的是**解析结果，不含 `raw`**（正文原文只在 `read()` 里给，
     * 免得每轮对话把几 KB 原文也缓存进内存）。宿主只用 body / demos /
     * firstMes / lore / name，不需要原文。
     */
    resolve(chatId, personaCfg = {}) {
      ensureSeeded();
      const items = catalog.scan().items;
      const byChat = personaCfg.byChat ?? {};
      const want = byChat[chatId] || personaCfg.current || 'default';
      const got = parsedOf(items, want) || parsedOf(items, 'default');
      return got || { id: 'default', label: '大肥鱼', name: '大肥鱼', body: '', tags: [] };
    },
  };
}
