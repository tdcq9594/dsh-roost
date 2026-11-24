/**
 * 试听任务表
 * ==========
 *
 * 扩展「语音回复」的试听是后台任务 + 每秒轮询：点一下立刻返回，
 * 生成完再取音频，期间可以关掉等待。这里照这个交互落地。
 *
 * 边界说清楚：
 *   · 只保存**内存态**，重启 DSH 就没了——试听本来就不是持久数据；
 *   · 「停止等待」是前端停轮询、丢 Blob URL，**不取消后台合成**
 *     （扩展面板也是这么写的：后台合成可能继续）；
 *   · 任务结果带 base64 音频，TTL 过后自动清，免得长时间开着面板堆内存。
 */

export const PREVIEW_JOB_TTL = 10 * 60_000;

export function createPreviewJobs({ now = Date.now, ttl = PREVIEW_JOB_TTL } = {}) {
  const jobs = new Map();
  let seq = 0;

  const sweep = () => {
    const t = now();
    for (const [id, job] of jobs) {
      if (t - job.updatedAt > ttl && job.status !== 'running') jobs.delete(id);
    }
  };

  const start = (run) => {
    const id = `preview-${++seq}-${now().toString(36)}`;
    const job = {
      id,
      status: 'running',
      phase: '排队中',
      progress: 0,
      startedAt: now(),
      updatedAt: now(),
      result: null,
      error: null,
    };
    jobs.set(id, job);
    const update = (patch) => Object.assign(job, patch, { updatedAt: now() });
    Promise.resolve()
      .then(() => run({ job, update }))
      .then((result) => update({ status: 'done', phase: '完成', progress: 100, result: result || null }))
      .catch((e) => {
        const status = Number(e?.status) || 502;
        const code = String(e?.code || 'tts_failed').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'tts_failed';
        update({
          status: 'error',
          phase: '失败',
          progress: 100,
          error: { status, code, message: String(e?.message || '试听失败') },
        });
      });
    return { ...job };
  };

  const get = (id) => {
    sweep();
    const job = jobs.get(String(id || ''));
    return job ? { ...job } : null;
  };

  const size = () => jobs.size;

  return { start, get, sweep, size };
}
