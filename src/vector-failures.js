/**
 * 向量失败上报（跟进 aurabot beta #527）。
 *
 * 我方 embed / local-embed 过去失败只 `log(...)` 后 return null，面板上看不到——
 * 开关开着却静默回落关键词，用户只能反复怀疑自己没装对。这里补一条**最近失败**
 * 的落盘记录，host 的 vectorStatus 读出来展示。
 *
 * 只记最近一次：不做历史账本（那是日志的事），不记向量内容（隐私），只记
 * 时间 / 短消息 / 来源。写盘失败吞掉——诊断旁路不该让向量调用崩掉。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';
import { writeJsonAtomic } from './atomic.js';

export const FAILURE_FILE = 'vector-failures.json';
const MAX_MSG = 200;

const file = () => join(dataDir(), FAILURE_FILE);

/** 记一次失败。source='remote'|'local'，message 截断脱敏由调用方保证 */
export function recordVectorFailure(source, message) {
  const row = {
    at: Date.now(),
    source: String(source || '').slice(0, 20),
    message: String(message ?? '').slice(0, MAX_MSG),
  };
  try {
    writeJsonAtomic(file(), row, { newline: true });
  } catch {
    // 诊断旁路：写不下去也不影响向量回落
  }
  return row;
}

/** 读最近一次失败；坏文件 / 没有文件都当「没失败过」 */
export function lastVectorFailure() {
  try {
    const r = JSON.parse(readFileSync(file(), 'utf8'));
    if (!r || typeof r !== 'object') return null;
    return {
      at: Number(r.at) || 0,
      source: String(r.source || '').slice(0, 20),
      message: String(r.message || '').slice(0, MAX_MSG),
    };
  } catch {
    return null;
  }
}
