/**
 * 超大入站图片的按需压缩。
 *
 * 零常驻依赖：只在真遇到「超过模型图片上限」时才去拿「功能包 → 媒体」里
 * 已经装好的 ffmpeg（宿主自己的可选依赖），用 spawn 传参数组，不走 shell。
 * 没装 ffmpeg / 压缩失败就返回 null，让调用方如实告诉模型「图太大」，
 * 不能因为优化失败把这一轮聊天弄挂。
 *
 * 取 exe 必须用 `resolveFfmpeg()` 而不是 `ffmpegBinary()`：后者只看本插件
 * 装到依赖目录里的那份，用户选「用系统那份 ffmpeg」（apt / brew / PATH）
 * 时它是空的，压缩会静默失效。
 *
 * 不动 gif：压成 jpeg 会丢动画，那种图宁可请对方重发。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFfmpeg } from './shared-deps.js';

/** 从小到大试几档：先尽量保清晰度，实在放不下再降分辨率 / 提压缩比 */
const STEPS = [
  { width: 1600, q: 5 },
  { width: 1200, q: 7 },
  { width: 900, q: 9 },
];
const TIMEOUT_MS = 15_000;

function run(exe, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (b) => { err += String(b).slice(0, 2000); });
    const timer = setTimeout(() => p.kill(), TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err.trim().slice(-200) || `ffmpeg 退出码 ${code}`));
    });
  });
}

/**
 * @param {object} o
 * @param {Buffer} o.buf 原始图片字节
 * @param {string} [o.mime] 声明的类型（gif 不压）
 * @param {number} [o.maxBytes] 目标上限
 * @param {() => string} [o.ffmpeg] 注入口（测试用；默认 managed → 系统 PATH）
 * @returns {Promise<{buf:Buffer, mediaType:string, shrunk:true, fromBytes:number}|null>}
 */
export async function shrinkImage({
  buf, mime = '', maxBytes = 5 * 1024 * 1024,
  ffmpeg = () => resolveFfmpeg().path,
} = {}) {
  if (!Buffer.isBuffer(buf) || buf.length <= maxBytes) return null;
  if (/gif/i.test(String(mime))) return null;

  const exe = typeof ffmpeg === 'function' ? ffmpeg() : ffmpeg;
  if (!exe) return null;

  const dir = mkdtempSync(join(tmpdir(), 'roost-img-'));
  const input = join(dir, 'in.img');
  try {
    writeFileSync(input, buf);
    for (const { width, q } of STEPS) {
      const output = join(dir, `out-${width}.jpg`);
      try {
        await run(exe, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', input,
          '-vf', `scale='min(${width},iw)':-2`,
          '-q:v', String(q), '-frames:v', '1', output,
        ]);
        const out = readFileSync(output);
        if (out.length && out.length <= maxBytes) {
          return {
            buf: out,
            mediaType: 'image/jpeg',
            shrunk: true,
            fromBytes: buf.length,
          };
        }
      } catch {
        /* 这一档失败就试下一档；全失败交给调用方报「图太大」 */
      }
    }
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响这一轮 */ }
  }
}
