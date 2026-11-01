#!/usr/bin/env node
/**
 * 生成 / 校验人格库索引
 * =========================
 *
 *   node scripts/build-persona-index.mjs            # 重算并写回 personas/index.json
 *   node scripts/build-persona-index.mjs --check    # 只校验，不写；不一致退出码 1
 *
 * 为什么人格也要一份索引：
 *   1. **一键更新要能判断「哪些变了」**。面板不能每次都把八份人格重下一遍，
 *      得先拿一个几十字节的 index.json 比 sha256，只下不一样的那几份。
 *   2. **要能防篡改**。人格正文是直接进系统提示词的——等于一段能被远程
 *      改写的最高优先级指令。下载后必须逐份核对 sha256，对不上就不落地。
 *   3. **要能带版本门槛**。新格式人格（比如多一段 `## 世界书`）老版本读不懂，
 *      `minVersion` 让老版本安静跳过，而不是装进去一个半残的人格。
 *
 * 索引里**不放时间戳**：`--check` 要靠逐字节比对，任何每次生成都会变的字段
 * 都会让 CI 永远报红。
 *
 * 元信息（name / tags）直接调 `src/personas.js` 的 `parsePersona` 解析，
 * 不在这里另写一套正则——两套解析规则迟早会不一致，索引里写的名字
 * 和面板里显示的名字就会对不上。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePersona } from '../src/personas.js';
// 哈希规则只能有一个定义处（见 catalog.js）：这里算出来的 sha256 要和
// persona-repo 校验时用的完全一致，否则 Windows 检出会被判成「改过」。
import { hashText } from '../src/catalog.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'personas');
const TARGET = path.join(DIR, 'index.json');

/**
 * 这批人格要求的最低 dsh-roost 版本。
 *
 * 0.10.7 是「人格搬成文件」的第一个版本——更老的版本读的是 `persona.text`
 * 旧字段，装了这批文件也不会用上。写死成常量而不是从 package.json 读，
 * 是因为 index.json 是要被**别的版本**读的：跟着 package.json 走会变成
 * 「自己校验自己」，每次发版都要重算一遍索引。
 */
const MIN_VERSION = '0.10.7';

/**
 * pack 数量，**永久固定 16**。
 *
 * 不能「随总量调整」：N 一变，所有 id 的归属全部重算，等于全量重排，
 * 增量同步和客户端缓存全部失效。分片用 `hash(id) % 16`，插入新人格只影响它自己那片。
 */
const PACK_N = 16;

/** 索引上限 512 KB（老版本 getText 的硬上限）；超过就要在生成端报错 */
const INDEX_MAX_BYTES = 512 * 1024;

const packOf = (id) => parseInt(hashText(id).slice(0, 8), 16) % PACK_N;

const checkOnly = process.argv.includes('--check');

async function build() {
  const names = (await fs.readdir(DIR)).filter((n) => n.endsWith('.md')).sort();

  const personas = [];
  const buckets = Array.from({ length: PACK_N }, () => []);
  for (const file of names) {
    const raw = await fs.readFile(path.join(DIR, file), 'utf8');
    const id = file.slice(0, -3);
    const p = parsePersona(id, raw);
    if (/^\s*name\s*:/m.test(raw)) {
      console.warn(`  ⚠ ${file} 还在用 name:，0.11 起请改成 label:（name 只作兼容别名）`);
    }
    const pack = packOf(id);
    buckets[pack].push({ id, text: raw });
    personas.push({
      id,
      // 0.11：label 是显示名；name 保留同值，给还没改的老客户端
      label: p.label || p.name,
      name: p.label || p.name,
      tags: p.tags,
      file,
      // 面板上显示「439 字」。用整份原文的长度，不是 body 的长度——
      // body 不含示例和世界书，报出来的数会明显偏小。
      // 和 catalog 一样先归一 CRLF：否则 Windows 检出会让同一个文件多出「行数」个字。
      chars: raw.replace(/\r\n/g, '\n').length,
      // 按字节算哈希，不按字符：CRLF / 尾随空格 / BOM 都算内容差异，
      // 差一个字节就该重下，而不是「反正显示一样」。
      sha256: hashText(raw),
      pack,
    });
  }

  /** 只写非空分片；内容按 id 排序，保证同输入生成同字节 */
  const packs = [];
  const packFiles = new Map();
  for (let n = 0; n < PACK_N; n += 1) {
    if (!buckets[n].length) continue;
    // 按码点排，不用 localeCompare：后者依赖 ICU/locale，不同机器生成字节可能不同
    buckets[n].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const body = buckets[n].map((x) => JSON.stringify(x)).join('\n') + '\n';
    const file = `packs/p${n}.jsonl`;
    packFiles.set(file, body);
    packs.push({ n, file, count: buckets[n].length, bytes: Buffer.byteLength(body, 'utf8') });
  }

  return {
    packFiles,
    index: {
    schema: 3,
    // 只是给面板显示「仓库 tdcq9594/dsh-roost · personas/」用的，
    // 真正拉取的地址由 sources 决定（可换源）。
    repo: 'tdcq9594/dsh-roost',
    branch: 'main',
    minVersion: MIN_VERSION,
    packs,
    personas,
    },
  };
}

const { index, packFiles } = await build();
const next = index;
const text = JSON.stringify(next, null, 2) + '\n';

/** 索引体积在生成端卡死：老版本 getText 上限 512 KB，超了会静默停在旧清单 */
const bytes = Buffer.byteLength(text, 'utf8');
if (bytes > INDEX_MAX_BYTES) {
  console.error(`personas/index.json 有 ${bytes} 字节，超过 ${INDEX_MAX_BYTES}（老版本读不了）`);
  process.exit(1);
}

if (checkOnly) {
  let cur = '';
  try {
    cur = await fs.readFile(TARGET, 'utf8');
  } catch {
    console.error('personas/index.json 不存在，请先跑 node scripts/build-persona-index.mjs');
    process.exit(1);
  }
  if (cur !== text) {
    console.error('personas/index.json 与 personas/*.md 不一致，请重跑 node scripts/build-persona-index.mjs');
    // 指出具体差在哪，别让人对着两份 JSON 肉眼比
    let old = {};
    try {
      old = JSON.parse(cur);
    } catch {}
    const oldMap = new Map((old.personas ?? []).map((p) => [p.id, p.sha256]));
    for (const p of next.personas) {
      if (!oldMap.has(p.id)) console.error(`  + 新增 ${p.id}.md`);
      else if (oldMap.get(p.id) !== p.sha256) console.error(`  ~ 内容变了 ${p.id}.md`);
      oldMap.delete(p.id);
    }
    for (const id of oldMap.keys()) console.error(`  - 已删除 ${id}.md`);
    process.exit(1);
  }

  /** pack 也要校验：只对索引不对分片，改完人格忘了重跑会发出旧分片 */
  for (const [file, body] of packFiles) {
    let got = null;
    try {
      got = await fs.readFile(path.join(DIR, file), 'utf8');
    } catch {}
    if (got === null) {
      console.error(`  - 缺分片 ${file}，请重跑 node scripts/build-persona-index.mjs`);
      process.exit(1);
    }
    if (got !== body) {
      console.error(`  ~ ${file} 与人格不一致，请重跑 node scripts/build-persona-index.mjs`);
      process.exit(1);
    }
  }
  /** 多出来的分片（空桶不再生成）也算不一致，否则会跟着发出去 */
  let present = [];
  try {
    present = await fs.readdir(path.join(DIR, 'packs'));
  } catch {}
  for (const f of present) {
    if (!packFiles.has(`packs/${f}`)) {
      console.error(`  - 多余的分片 packs/${f}，请重跑 node scripts/build-persona-index.mjs`);
      process.exit(1);
    }
  }
  console.log(`personas/index.json 校验通过（${next.personas.length} 份，${bytes} 字节，${packFiles.size} 个分片）`);
} else {
  const PACKS_DIR = path.join(DIR, 'packs');
  await fs.mkdir(PACKS_DIR, { recursive: true });
  /** 先清掉旧分片：空桶不生成文件，不清的话会留下过期的 pN.jsonl */
  for (const old of await fs.readdir(PACKS_DIR)) {
    if (!packFiles.has(`packs/${old}`)) await fs.rm(path.join(PACKS_DIR, old), { force: true });
  }
  for (const [file, body] of packFiles) {
    await fs.writeFile(path.join(DIR, file), body, 'utf8');
  }
  await fs.writeFile(TARGET, text, 'utf8');
  console.log(`已写入 personas/index.json（${next.personas.length} 份，${bytes} 字节，${packFiles.size} 个分片，minVersion ${MIN_VERSION}）`);
  for (const p of next.personas) console.log(`  ${p.id.padEnd(10)} ${String(p.chars).padStart(5)}字  ${p.label || p.name}`);
}
