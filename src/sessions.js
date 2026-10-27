/**
 * chatId → DSH 会话 的映射。
 *
 * 为什么一个 QQ 会话对应一个 DSH 会话：上下文天然隔离。
 * 张三在群里说的话不该出现在李四的私聊里，两个群的氛围也不一样。
 *
 * 存盘是必要的：DSH 重启后会话还在，映射丢了就等于所有人的上下文都断了。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createSessions({ dataDir, log = () => {} }) {
  const file = join(dataDir, 'sessions.json');

  let map = { chats: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.chats) map = raw;
  } catch {
    // 没有就用空的，不是错误
  }

  function save() {
    try {
      writeFileSync(file, JSON.stringify(map, null, 2), 'utf8');
    } catch (e) {
      log(`会话映射写盘失败：${e.message}`);
    }
  }

  return {
    /** 取这个会话的 DSH 会话 id；没有就返回空串 */
    get(chatId) {
      const e = map.chats[chatId];
      return e?.sessionId ?? '';
    },

    /**
     * 记下来。
     *
     * `kind` 是群/私聊（'group' / 'c2c'）。**必须有它**——
     * QQ 官方事件里群名是空的（只有 openid），ai-chat 那边取不到群名就
     * 回退成发消息那个人的昵称。结果群和私聊的 title 长得一模一样，
     * 面板上的会话下拉两行显示同一个名字，用户根本分不出哪个是群。
     * 存了 kind，前端就能标出「群」「私聊」，至少能分开。
     */
    set(chatId, sessionId, { preset = '', title = '', kind = '' } = {}) {
      map.chats[chatId] = { sessionId: String(sessionId), preset, title, kind, at: Date.now() };
      save();
    },

    /** 丢掉映射（下一轮会新建会话）。DSH 那边的会话不会被删，只是不再关联 */
    remove(chatId) {
      delete map.chats[chatId];
      save();
    },

    /**
     * 只补字段，不动 sessionId。
     *
     * 为什么需要：早期版本 `set()` 没传 `title`，那些老映射的标题一直是空的，
     * 面板上就显示成一串 openid 短码（私聊尤其明显，因为群还有个群名兜着）。
     * 每次收到消息时顺手补一次，不用等用户手动清映射。
     */
    patch(chatId, fields = {}) {
      const e = map.chats[chatId];
      if (!e) return false;
      let dirty = false;
      for (const k of ['title', 'kind', 'preset']) {
        const v = fields[k];
        if (v && !e[k]) {
          e[k] = String(v);
          dirty = true;
        }
      }
      if (dirty) save();
      return dirty;
    },

    /** 取一条完整记录（没有就返回 null） */
    getEntry(chatId) {
      const e = map.chats[chatId];
      return e ? { chatId, ...e } : null;
    },

    /** 清掉映射里所有指向某个会话的记录（会话被删/失效时用） */
    forgetSession(sessionId) {
      let n = 0;
      for (const [chatId, e] of Object.entries(map.chats)) {
        if (e.sessionId === sessionId) {
          delete map.chats[chatId];
          n += 1;
        }
      }
      if (n) save();
      return n;
    },

    get size() {
      return Object.keys(map.chats).length;
    },

    /** 给面板看 */
    list() {
      return Object.entries(map.chats).map(([chatId, e]) => ({ chatId, ...e }));
    },
  };
}
