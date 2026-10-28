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
import { createHash } from 'node:crypto';
import { parsePersona } from '../src/personas.js';

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

const checkOnly = process.argv.includes('--check');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 算哈希前把 CRLF 归一成 LF。
 *
 * 和 `src/persona-repo.js` 里的 `hashText` 必须是同一套规则——两边不一致，
 * 用户下载完校验就会永远失败。原因：同一个文件在 Windows 检出是 CRLF、
 * 在 GitHub 上是 LF，字节不同但内容一样。
 */
const hashText = (text) => sha256(Buffer.from(String(text ?? '').replace(/\r\n/g, '\n'), 'utf8'));

async function build() {
  const names = (await fs.readdir(DIR)).filter((n) => n.endsWith('.md')).sort();

  const personas = [];
  for (const file of names) {
    const raw = await fs.readFile(path.join(DIR, file), 'utf8');
    const id = file.slice(0, -3);
    const p = parsePersona(id, raw);
    personas.push({
      id,
      name: p.name,
      tags: p.tags,
      file,
      // 面板上显示「439 字」。用整份原文的长度，不是 body 的长度——
      // body 不含示例和世界书，报出来的数会明显偏小。
      chars: raw.length,
      // 按字节算哈希，不按字符：CRLF / 尾随空格 / BOM 都算内容差异，
      // 差一个字节就该重下，而不是「反正显示一样」。
      sha256: hashText(raw),
    });
  }

  return {
    schema: 1,
    // 只是给面板显示「仓库 tdcq9594/dsh-roost · personas/」用的，
    // 真正拉取的地址由 sources 决定（可换源）。
    repo: 'tdcq9594/dsh-roost',
    branch: 'main',
    minVersion: MIN_VERSION,
    personas,
  };
}

const next = await build();
const text = JSON.stringify(next, null, 2) + '\n';

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
  console.log(`personas/index.json 校验通过（${next.personas.length} 份）`);
} else {
  await fs.writeFile(TARGET, text, 'utf8');
  console.log(`已写入 personas/index.json（${next.personas.length} 份，minVersion ${MIN_VERSION}）`);
  for (const p of next.personas) console.log(`  ${p.id.padEnd(10)} ${String(p.chars).padStart(5)}字  ${p.name}`);
}
