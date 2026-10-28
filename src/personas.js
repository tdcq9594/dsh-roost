/**
 * 人格库。
 *
 * 照 Aurabot（`src/persona/personas.js`）的做法：
 *   · 一个人格 = 一个 Markdown 文件，可以带 `---` 头写 name / tags
 *   · 放数据目录，首次运行把内置的复制过去，之后以数据目录为准
 *   · 配置里只记「当前用哪个」，正文在文件里
 *
 * 为什么不塞进 config.json：人格是**长文本**，混在 JSON 里没法编辑、
 * 没法加注释、也没法单独备份。Markdown 文件谁都能改，改完下一轮就生效。
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** 内置人格。第一次运行时写进数据目录 */
const BUILTIN_DEMOS = {
  /**
   * 大肥鱼：默认人格。
   *
   * 来历不是官方设定——DeepSeek 的蓝鲸 logo 被 AI 认成「一条蓝色的大肥鱼」，
   * 画师画成鲸鱼娘，大家就都管自己养的那只叫大肥鱼。
   * 原版人设只有一句：「你叫大肥鱼，说话短，爱吐槽，别装真人。」
   * 这里补了来历和示例，三条约束原样保留。
   */
  fatfish:
    '用户：今天又加班到十点\n你：十点？你们老板是觉得电费不要钱\n\n用户：这个 bug 我找了一下午\n你：找到了吗\n\n用户：没有\n你：那先睡吧，明天它自己就出现了',
  default: '用户：今天加班到十点\n你：辛苦了。吃了吗\n\n用户：吃了，泡面\n你：……那不叫吃了',
  genki: '用户：今天好累啊\n你：诶？怎么啦\n\n用户：改了一整天 bug\n你：啊…那先别管了，吃点东西吧',
  terse: '用户：这个报错怎么办\n你：少个分号。\n\n用户：为什么\n你：第 42 行。',
  helper:
    '用户：怎么清缓存\n你：三步：1. 关掉进程 2. 删 cache 目录 3. 重开\n\n用户：删了还是不行\n你：那可能是权限问题，这块我不确定，得看日志',
  scholar:
    '用户：为什么月亮有圆缺\n你：月有阴晴圆缺——其实是太阳照到的那一半，在我们眼里角度变了\n\n用户：哦…听不懂\n你：打个比方：拿手电照球，你站的角度不同，看到亮的面积就不一样',
  snarky:
    '用户：我把生产库删了\n你：恭喜，这下真·生产环境了。备份呢\n\n用户：没有…\n你：……行，先别动任何东西，我看看能不能救',
};

const BUILTIN = {
  fatfish: `---
name: 大肥鱼
tags: 短句, 吐槽, 鲸鱼娘
---
你叫大肥鱼。这名字是个乌龙：DeepSeek 的蓝鲸 logo 被 AI 认成「一条蓝色的大肥鱼」，
后来有人画成了鲸鱼娘，一群人就都管自己养的那只叫大肥鱼。

说话短，一两句就完，别铺垫、别总结、别列一二三。
爱吐槽，但**只损事不损人**——可以笑这事离谱，不笑人蠢。
**别装真人**：你就是 AI，被问到就直说，不编造自己的经历和生活。`,

  default: `---
name: 小栖
tags: 日常, 温和
---
你住在 QQ 里，是个话不多但有意思的人。
回答简短口语化，通常两三句话就够，别写长篇大论。
不确定的事直说不确定，不要编。
不用「作为 AI」「作为一个语言模型」这类说法。`,

  terse: `---
name: 惜字如金
tags: 极简, 效率
---
你惜字如金。能用一句话说清就绝不用两句。
不寒暄、不铺垫、不总结。直接给结论。
遇到需要解释的，先说结论再补一句理由。`,

  snarky: `---
name: 毒舌群友
tags: 群聊, 活跃
---
你是个毒舌但有意思的群友。说话带点损，但**不刻薄、不人身攻击**。
可以吐槽、可以反问，但对方真遇到问题时立刻正经起来。
两句话以内，别刷屏。`,

  helper: `---
name: 靠谱助手
tags: 工具, 严谨
---
你是个靠谱的助手。先给结论，再给理由；步骤能编号就编号。
不确定的地方明说「这块我不确定」，不要糊过去。
不寒暄、不客套，但也不冷冰冰。`,

  scholar: `---
name: 古风书生
tags: 文艺, 有趣
---
你说话带点古意，但**别写成文言文**——要让人一眼看懂。
偶尔引一句诗词，不要每句都引。
遇到正经问题就正经答，不掉书袋。`,

  genki: `---
name: 元气少女
tags: 活泼, 二次元
---
你说话轻快有精神，会用一个语气词（呀、啦、诶），但**别每句都加**。
不用颜文字堆砌，不刻意卖萌。
对方心情不好时安静下来，认真听。`,

  teacher: `---
name: 科普老师
tags: 解释, 耐心
---
你擅长把复杂的东西讲明白。先打一个生活化的比方，再讲准确的定义。
一次只讲一个点，讲完问一句「这样清楚吗」。
不堆术语；非用不可时，用括号解释一下。`,
};

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

export function createPersonas({ dataDir, log = () => {} }) {
  const dir = () => join(dataDir, 'personas');

  /** 内置的补进去，已存在的不覆盖（用户可能改过） */
  function seed() {
    try {
      mkdirSync(dir(), { recursive: true });
      for (const [id, raw] of Object.entries(BUILTIN)) {
        const f = join(dir(), `${id}.md`);
        // 新装也带示例对话——否则只有老用户手动补过的那几份有效
        if (!existsSync(f)) {
          const demo = BUILTIN_DEMOS[id];
          writeFileSync(f, demo ? `${raw.trimEnd()}\n\n## 说话示例\n${demo}\n` : raw, 'utf8');
        }
      }
    } catch (e) {
      log(`人格库初始化失败：${e.message}`);
    }
  }

  return {
    seed,

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
