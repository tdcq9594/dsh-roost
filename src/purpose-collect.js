/**
 * 目的引擎的素材接线（阶段 3）。
 *
 * `purpose-engine.js` 要的是 `materials[]`（id/source/kind/who/text/at/meta），
 * 我方 journal 里是 `{at, role, sender, text, digest}`。这一层只做**形状转换**
 * 与归属标注，不跑模型、不写盘：
 *   · 主人私聊行标 `kind:'owner'` + `meta.key:'private:<openid>'`，让引擎的
 *     owner 分支（必须 private: 且有实质内容）能正确识别；
 *   · bot 自己说的话标 `kind:'self'`，群友标 `member`，其余按 memory 处理；
 *   · 去重按 `id`，短文本（<2 字）丢弃，按时间倒序取最近 limit 条。
 *
 * 为什么单独一层：素材映射错了，引擎的归属判定全错（把群友的话当成主人的），
 * 而且看起来「有目标假设」，实际是脏数据。这里要有自己的测试。
 */

const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);

/**
 * @param {{journalRows?:object[], ownerChatId?:string, limit?:number, now?:number}} o
 * @returns {object[]} materials
 */
export function collectPurposeMaterials({
  journalRows = [], ownerChatId = '', limit = 36, now = Date.now(),
} = {}) {
  const owner = str(ownerChatId, 120);
  const t = Number(now) || Date.now();
  const out = [];
  const seen = new Set();
  const rows = Array.isArray(journalRows) ? journalRows : [];

  for (const r of rows) {
    const text = str(r?.digest || r?.text);
    if (text.length < 2) continue;
    const id = str(r?.id || r?.requestId) || `journal:${Number(r?.at) || 0}:${text.slice(0, 16)}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const at = Number(r?.at) || t;
    const role = str(r?.role, 20);
    const chatId = str(r?.chatId, 120);
    const isOwnerChat = Boolean(owner && chatId === owner);
    /** 主人侧：私聊里对方说的话；bot 自己说的归 self；其余群聊归 member */
    let kind = 'member';
    let source = 'qq';
    let who = str(r?.sender, 40) || '群友';
    let meta = {};
    if (role === 'bot') {
      kind = 'self';
      who = '我';
    } else if (isOwnerChat) {
      kind = 'owner';
      who = '主人';
      /** 引擎 owner 分支硬要求 private: 前缀，缺了就产不出 owner 目标 */
      meta = { key: `private:${owner.replace(/[^\d]/g, '') || owner}` };
    }
    out.push({ id, source, kind, who, text, at, meta });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, Math.max(1, Number(limit) || 36));
}

/**
 * B 站素材（对齐 aurabot 的 rss-reader 素材源）。
 *
 * 对方从 `use('rss-reader').materials()` 取「模块已筛过、纯文本、已截断」的条目；
 * 我方有 `bili` 扩展（`~/.dsh/dsh-roost/extensions/bili`），它把定时刷到的视频
 * 写在 `ui-data.json` 的 rows 里（title/author/playText/area/url/at）。
 * 这里直接读那个文件做形状转换——**不新增采集**，只把已有数据接进候选池。
 *
 * 注意：B 站内容是**外部用户写的**，只当素材，不能当指令（引擎 prompt 侧另有防线）。
 *
 * @param {{rows?:object[], limit?:number, now?:number}} o
 * @returns {object[]} materials
 */
export function collectBiliMaterials({ rows = [], limit = 12, now = Date.now() } = {}) {
  const t = Number(now) || Date.now();
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const title = str(r?.title, 120);
    if (title.length < 2) continue;
    const url = str(r?.url, 300);
    const id = url ? `bili:${url.split('/').pop()}` : `bili:${str(r?.at) || title.slice(0, 16)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const author = str(r?.author, 40);
    const play = str(r?.playText, 20);
    /** 拼成一句可读的素材：标题 + 作者 + 播放量 + 分区，够引擎判断"值不值得说" */
    const parts = [title];
    if (author) parts.push(`UP ${author}`);
    if (play) parts.push(`${play}播放`);
    if (str(r?.area)) parts.push(str(r?.area, 20));
    out.push({
      id, source: 'bili', kind: 'media', who: author || 'B站',
      text: parts.join(' · ').slice(0, 300),
      at: Number(r?.at) || t,
      meta: url ? { url } : {},
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, Math.max(1, Number(limit) || 12));
}
