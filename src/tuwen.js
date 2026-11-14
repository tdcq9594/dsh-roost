/**
 * 官方图文卡片（`msg_type=8`）的字段规则与标记解析。
 * ==================================================
 *
 * 卡片有两个入口，规则必须是同一份：
 *   · 扩展走 `POST /v1/send { card: {...} }`（`ext-api-hooks.js`）
 *   · 模型在回复里写 `<<card: 标题|描述|链接|图>>`（`outbound-actions.js`）
 *
 * 以前 `tuwenProblem()` 只住在 `ext-api-hooks.js` 里。标记层想复用的话，
 * 得把那个模块整个拉进来（它 import 了 speakup / inbound，还碰 fs），
 * 为一条纯校验付这种代价不值；复制一份更糟——平台侧对不合格卡片只回
 * 一个笼统的 `304061`，两边校验一漂移，排查就得猜是哪份规则在生效。
 *
 * 所以把**纯函数**单独放这里：不 import 任何东西，两边都能直接引。
 */

/**
 * 卡片参数是否合格。
 *
 * 平台侧对不合格只会回一句笼统的 `304061`，从错误码看不出是标题超了
 * 还是链接不是 https。所以在这里逐条挡，把具体原因回给调用方——
 * 扩展作者 / 模型看到「title 最多 50 字」才知道怎么改。
 *
 * 四个字段全必填是官方口径（`msg.replyTuwen` 的注释也写着），少一个
 * 发出去就是一条空白卡片，比不发更糟。
 *
 * @param {object} card `{title, description, url, picUrl}`
 * @returns {string} 空串 = 没问题
 */
export function tuwenProblem(card) {
  const t = String(card?.title ?? '').trim();
  const d = String(card?.description ?? '').trim();
  const u = String(card?.url ?? '').trim();
  /** `picUrl` 是扩展写的，`pic_url` 是官方字段名，两个都认 */
  const p = String(card?.picUrl ?? card?.pic_url ?? '').trim();
  if (!t) return '缺 title';
  if (!d) return '缺 description';
  if (!u) return '缺 url';
  if (!p) return '缺 picUrl';
  if ([...t].length > 50) return `title 最多 50 字（现在 ${[...t].length} 字）`;
  if ([...d].length > 200) return `description 最多 200 字（现在 ${[...d].length} 字）`;
  for (const [name, v] of [['url', u], ['picUrl', p]]) {
    if (!/^https:\/\//i.test(v)) return `${name} 必须是 https 地址`;
    if (v.length > 1024) return `${name} 最多 1024 字符`;
  }
  return '';
}

/**
 * `<<card: 标题|描述|https://链接|https://图片>>` → `{title, description, url, picUrl}`。
 *
 * 半角 `|` 和全角 `｜` 都认（中文输入法下后者很常见）。
 *
 * **从右往左认后两段**：链接和图片地址是形状最确定的两段，描述里出现竖线
 * 的概率比 URL 高得多（「猫｜在窗台｜打盹」这种随手写的分隔符）。
 * 中间多出来的段并回 description，不丢内容也不让字段整体错位。
 *
 * 只切形状，不判字段是否合格——合格与否交给 `tuwenProblem()`，
 * 调用方拿到具体原因才能记日志 / 提示模型。
 *
 * @param {string} value 标记里的值
 * @returns {{title:string, description:string, url:string, picUrl:string}|null}
 */
export function parseCardValue(value) {
  const parts = String(value ?? '').trim().split(/\s*[|｜]\s*/).map((s) => s.trim());
  if (parts.length < 4) return null;
  return {
    title: parts[0],
    description: parts.slice(1, -2).join(' | ').trim(),
    url: parts[parts.length - 2],
    picUrl: parts[parts.length - 1],
  };
}
