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
