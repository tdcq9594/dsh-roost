/**
 * GPT-SoVITS 的一键启动。
 *
 * 用户在面板里填一个安装目录，剩下的事这里做：
 *   · 认目录（有没有 api_v2.py / api.py、有没有 runtime\python.exe）
 *   · 从 `tts_infer.yaml` 读出当前加载的是哪个角色，顺带找参考音频
 *   · 挑一个**真的能绑**的端口，把服务拉起来
 *   · 把 baseUrl / endpointPath / apiVersion 算好交给面板去填
 *
 * 为什么端口要自己挑：Windows 有一批端口被系统保留（Hyper-V 之类），
 * 绑上去是 `WinError 10013`，而 9880 正好落在保留段 9861–9960 里。
 * 用户照着网上教程填 9880，起来就失败，还看不出为什么。这里试绑一次
 * 就知道，失败就换下一个。
 *
 * 安全边界：只执行 `<目录>/runtime/python.exe` 和 `<目录>/api_v2.py`，
 * 路径全部由 probe 拼出来，**不接受任何来自请求的命令字符串**。
 * 端口固定绑 127.0.0.1，不对外。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, extname, join } from 'node:path';

/** 起服务的默认端口。9880 是官方默认，但大概率被系统保留，所以从 17860 试起 */
const PORT_FROM = 17860;
const PORT_TRIES = 40;

/** 等模型加载完最多多久。角色A v2ProPlus 实测 110 秒，给一倍余量 */
const READY_TIMEOUT_MS = 240_000;

/** 日志只留最近这些行——启动失败时要看的就是最后几十行 */
const LOG_KEEP = 80;

/** YAML 里的字符串可能带 `\uXXXX` 转义（`"\u89D2\u8272A-e15.ckpt"` 就是「角色A-e15.ckpt」） */
function unescapeYaml(s) {
  return String(s ?? '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * 从 tts_infer.yaml 里读 `custom:` 段。
 *
 * 不引 YAML 库：这个文件是固定格式（两空格缩进的 key: value），
 * 为它加一个依赖不值得。读不出来就当没有，不影响启动。
 */
export function readCustomSection(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out = {};
  let inCustom = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\S/.test(raw)) {
      inCustom = /^custom\s*:/.test(raw);
      continue;
    }
    if (!inCustom) continue;
    const m = raw.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = unescapeYaml(v);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 从权重路径里猜角色名。
 *
 * `GPT_weights_v2ProPlus/角色A-e15.ckpt` → `角色A`
 * `SoVITS_weights_v2ProPlus/角色A_e8_s200.pth` → `角色A`
 *
 * 猜不出来就返回空串——宁可让用户手填参考音频，也不要拿 `s2G488k` 这种
 * 预训练底模的名字去匹配，那会匹配到一堆无关文件。
 */
export function guessCharacter(weightsPath) {
  const base = basename(String(weightsPath || ''), extname(String(weightsPath || '')));
  if (!base) return '';
  const cut = base
    .replace(/[-_](e|s)\d+.*$/i, '') // -e15 / _e8_s200
    .replace(/[-_]\d+$/, '')
    .trim();
  if (!cut || /^(s1|s2|g|d|gsv|s2g|s1bert)/i.test(cut)) return '';
  return cut;
}

/** 在目录里找参考音频候选：文件名含角色名、扩展名是 wav。限深限数，别把整个盘扫一遍 */
export function findRefAudio(dir, character, { maxDepth = 3, maxFiles = 400 } = {}) {
  if (!character) return [];
  const hits = [];
  let seen = 0;
  const walk = (cur, depth) => {
    if (depth > maxDepth || seen > maxFiles) return;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      seen += 1;
      if (seen > maxFiles) return;
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        /**
         * 跳过一堆没意义还有坑的目录：
         *   · `TEMP` / `tmp` —— Gradio 上传的临时副本，随时会被清掉，
         *     填进配置就是「今天能用，明天 404」
         *   · `runtime` / `pretrained_models` —— 几十 GB，扫进去纯浪费
         */
        if (/^(\.|node_modules|runtime|pretrained_models|temp|tmp|__pycache__)/i.test(e.name)) continue;
        walk(p, depth + 1);
      } else if (/\.wav$/i.test(e.name) && e.name.includes(character)) {
        try {
          if (statSync(p).size > 1024) hits.push(p);
        } catch {}
      }
    }
  };
  walk(dir, 0);
  return hits.slice(0, 8);
}

/**
 * 扫出所有「角色」。
 *
 * GPT-SoVITS 里一个角色是**一对**权重：
 *   `GPT_weights_<版本>/<角色>-e<epoch>.ckpt`     —— 语义模型
 *   `SoVITS_weights_<版本>/<角色>_e<epoch>_s<step>.pth` —— 声学模型
 *
 * 按角色名配对，同名多个 epoch 取最新的那个。扫不出来就返回空数组，
 * 面板会退回「用配置文件里的」——不让一个扫描失败挡住整个启动流程。
 *
 * 路径返回**相对安装目录**的形式（和 `tts_infer.yaml` 里一致），
 * 交给 API 的 `/set_*_weights` 用。
 */
export function scanModels(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  /** 角色名 → { gpt, sovits, version } */
  const byName = new Map();

  const epochOf = (name) => {
    const m = name.match(/[-_]e(\d+)/i);
    return m ? Number(m[1]) : 0;
  };

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = e.name.match(/^(GPT_weights|SoVITS_weights)_?([\w.-]*)$/i);
    if (!m) continue;
    const kind = /^gpt/i.test(m[1]) ? 'gpt' : 'sovits';
    const version = m[2] || '';

    let files;
    try {
      files = readdirSync(join(dir, e.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      const ext = extname(f.name).toLowerCase();
      if (kind === 'gpt' && ext !== '.ckpt') continue;
      if (kind === 'sovits' && ext !== '.pth') continue;

      const character = guessCharacter(f.name);
      if (!character) continue;

      const cur = byName.get(character) || { name: character, version };
      const candidate = {
        rel: `${e.name}/${f.name}`,
        epoch: epochOf(f.name),
      };
      const prev = cur[kind];
      if (!prev || candidate.epoch >= prev.epoch) {
        cur[kind] = candidate;
        cur.version = cur.version || version;
      }
      byName.set(character, cur);
    }
  }

  return [...byName.values()]
    .filter((x) => x.gpt || x.sovits)
    .map((x) => ({
      name: x.name,
      version: x.version,
      gpt: x.gpt?.rel || '',
      sovits: x.sovits?.rel || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function probeDir(dir) {
  const root = String(dir || '').trim();
  if (!root) return { ok: false, reason: 'empty', message: '先填 GPT-SoVITS 的安装目录' };
  if (!existsSync(root)) return { ok: false, reason: 'not_found', message: `目录不存在：${root}` };

  /** 认两个脚本里的任意一个，优先 v2（现在主流） */
  const apiV2 = join(root, 'api_v2.py');
  const apiV1 = join(root, 'api.py');
  const hasV2 = existsSync(apiV2);
  const hasV1 = existsSync(apiV1);
  if (!hasV2 && !hasV1) {
    return { ok: false, reason: 'no_api', message: '这个目录里没有 api_v2.py 或 api.py，不像 GPT-SoVITS 的根目录' };
  }

  /**
   * 找 python。
   *
   * 整合包是 `runtime\python.exe`；源码安装是 venv；再不行就退回 PATH 里的
   * python——但**必须存在**，否则起不来还看不出原因。
   */
  const candidates = [
    join(root, 'runtime', 'python.exe'),
    join(root, 'runtime', 'python'),
    join(root, 'venv', 'Scripts', 'python.exe'),
    join(root, '.venv', 'Scripts', 'python.exe'),
    join(root, 'venv', 'bin', 'python'),
  ];
  const python = candidates.find((p) => existsSync(p));
  if (!python) {
    return { ok: false, reason: 'no_python', message: '找不到 runtime\\python.exe（或 venv），没法启动' };
  }

  const configFile = join(root, 'GPT_SoVITS', 'configs', 'tts_infer.yaml');
  const custom = existsSync(configFile) ? readCustomSection(configFile) : null;
  const character = custom ? guessCharacter(custom.t2s_weights_path) : '';
  const refCandidates = character ? findRefAudio(root, character) : [];
  const models = scanModels(root);

  return {
    ok: true,
    dir: root,
    python,
    apiScript: hasV2 ? apiV2 : apiV1,
    /** v1 的接口在 `/`，v2 在 `/tts`；这里给面板直接用的值 */
    apiVersion: hasV2 ? 'v2' : 'v1',
    endpointPath: hasV2 ? '/tts' : '/',
    configFile: existsSync(configFile) ? configFile : '',
    device: custom?.device || '',
    weightVersion: custom?.version || '',
    /** 配置文件里当前加载的角色（面板用来做下拉的默认值） */
    character,
    /** 所有可选角色，面板做成下拉 */
    models,
    refCandidates,
  };
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 依次试端口。绑不上就换下一个——保留段、被占用的都在这一步自然排除 */
async function pickPort() {
  for (let i = 0; i < PORT_TRIES; i += 1) {
    const port = PORT_FROM + i;
    // eslint-disable-next-line no-await-in-loop
    if (await portFree(port)) return port;
  }
  return 0;
}

/**
 * 启动就绪后**要不要**真的切权重。
 *
 * 以前无条件切：v2 要发两个 `/set_*_weights`，每次都重新加载一遍权重
 * （单请求超时给到 180 秒），而模型加载本身实测就要 110 秒。
 * 用户权重一多，「启动卡好久」基本都是白切这一遍造成的。
 *
 * 选的正好是 `tts_infer.yaml` 里已经加载的角色、又没手填路径时，
 * 服务起来就已经是那个模型了，再切一次纯属浪费。
 */
export function decideSwitch({ wanted = '', character = '', hasManual = false } = {}) {
  const w = String(wanted || '').trim();
  const c = String(character || '').trim();
  if (!w && !hasManual) return { needed: false, skip: false };
  if (w && c && w === c && !hasManual) return { needed: true, skip: true };
  return { needed: true, skip: false };
}

/**
 * 拼 `/set_*_weights` 的 URL。
 *
 * **手填路径优先于扫描配对**：`scanModels()` 靠文件名猜角色名，
 * 权重一多（实测有人 15 个）很容易把不同 epoch、不同角色的 GPT 和
 * SoVITS 配错一对——能出声，但音色完全不是自己训的那个。
 */
export function buildWeightUrls(port, name, models = [], opts = {}) {
  const manualGpt = String(opts.gptWeights || '').trim();
  const manualSovits = String(opts.sovitsWeights || '').trim();
  const m = (models || []).find((x) => x.name === name);
  if (!m && !manualGpt && !manualSovits) throw new Error(`目录里没有「${name}」的权重`);
  const gptPath = manualGpt || m?.gpt || '';
  const sovitsPath = manualSovits || m?.sovits || '';
  const base = `http://127.0.0.1:${port}`;
  const urls = [];
  if (gptPath) urls.push(`${base}/set_gpt_weights?weights_path=${encodeURIComponent(gptPath)}`);
  if (sovitsPath) urls.push(`${base}/set_sovits_weights?weights_path=${encodeURIComponent(sovitsPath)}`);
  if (!urls.length) throw new Error('没有可用的权重路径：填一下 GPT / SoVITS 权重，或在下拉里选个角色');
  /**
   * 只填了一个：另一半还是扫描配对的结果。
   *
   * 用户手填路径本来就是为了修「配错对」，只填一个等于把另一半又交回给
   * `guessCharacter()`——可能还是别的 epoch。不挡住（有人就只有一个权重），
   * 但必须把「另一半是猜的」说出来，否则音色不对时完全无从下手。
   */
  const partial = Boolean(manualGpt) !== Boolean(manualSovits);
  return { urls, gptPath, sovitsPath, matched: m || null, partial };
}

export function createGptSovits({ log = () => {}, onReady = () => {}, fetchImpl = (...args) => fetch(...args) } = {}) {
  let child = null;
  let timer = null;
  /**
   * 第几次启动。
   *
   * 用一个自增号代替「取消」布尔量：`start()` 是先返回、再在后台
   * `await pickPort()` 然后 spawn 的，中间有几十毫秒空档。用布尔量的话，
   * 「start → stop → start」里第二次 start 会把它重置回 false，
   * 于是**第一次的异步流程醒来照样 spawn**——留下一个谁都管不到的进程
   * （2026-11-04 二轮审查实测）。
   *
   * 同理，旧进程的 `exit` 回调会拿它和新一次启动比对，不相等就什么都不做，
   * 避免「旧进程退出把新进程的状态打成 error」。
   */
  let runId = 0;
  let state = {
    phase: 'idle', // idle | starting | running | stopped | error
    port: 0,
    pid: 0,
    dir: '',
    error: '',
    startedAt: 0,
    readyAt: 0,
    /**
     * **实际生效**的角色。
     *
     * 和「用户选的角色」是两回事：切换权重失败时服务照样能出声，
     * 只是跑的是 `tts_infer.yaml` 里那个默认模型。以前不记这个，
     * 用户看到「正常输出」却听到别的音色，完全没法从面板上看出原因。
     */
    activeModel: '',
    /** 服务能跑但角色没切过去之类的软故障 */
    warning: '',
  };
  const lines = [];

  function push(line) {
    const text = String(line ?? '').replace(/\s+$/, '');
    if (!text) return;
    lines.push(text);
    if (lines.length > LOG_KEEP) lines.splice(0, lines.length - LOG_KEEP);
  }

  function set(patch) {
    state = { ...state, ...patch };
  }

  function killTree(pid) {
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
      } else {
        process.kill(-pid, 'SIGTERM');
      }
    } catch {}
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    /**
     * 让所有在途的异步流程失效：pickPort 里醒来的那条会看到
     * `myRun !== runId` 而直接返回；旧进程的 exit/error 回调也不会再改状态。
     */
    runId += 1;
    const pid = state.pid || child?.pid || 0;
    if (!pid) {
      set({ phase: 'idle', pid: 0, port: 0 });
      return { ok: true, stopped: false };
    }
    killTree(pid);
    child = null;
    set({ phase: 'stopped', pid: 0, port: 0, error: '' });
    push('—— 已停止 ——');
    log('GPT-SoVITS 已停止');
    return { ok: true, stopped: true };
  }

  /**
   * 运行时切换角色。
   *
   * 用 API 的 `/set_gpt_weights` / `/set_sovits_weights`，**不改**
   * `tts_infer.yaml`——那是用户自己维护的文件，被插件改掉之后他下次
   * 手动开 WebUI 会发现模型莫名换了。
   *
   * `opts.gptWeights` / `opts.sovitsWeights` 是**手动填的路径**，优先于
   * `scanModels()` 按角色名自动配出来的那一对。自动配对从文件名猜角色名，
   * 权重一多（实测有人 15 个）很容易把不同 epoch / 不同角色的 GPT 和
   * SoVITS 配错，表现是「能出声，但音色完全不是我的模型」。
   */
  async function switchModel(port, name, models, opts = {}) {
    const { urls, gptPath, sovitsPath, matched, partial } = buildWeightUrls(port, name, models, opts);
    for (const url of urls) {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`切换权重失败（HTTP ${res.status}）`);
    }
    return {
      name: name || '(手动权重)',
      version: matched?.version || '',
      gptPath,
      sovitsPath,
      partial,
    };
  }

  /**
   * 启动。**立刻返回**，不等模型加载完（实测要 110 秒，HTTP 等不起）。
   * 就绪与否看 `status().phase`，面板轮询。
   *
   * @param {string} dir 安装目录
   * @param {{model?: string}} [opts] `model` = 要切换到的角色名（空 = 用配置文件里的）
   */
  function start(dir, opts = {}) {
    if (state.phase === 'starting' || state.phase === 'running') {
      return { ok: false, reason: 'busy', message: '服务已经在跑了' };
    }
    const p = probeDir(dir);
    if (!p.ok) return p;

    lines.length = 0;
    const myRun = (runId += 1);
    set({
      phase: 'starting',
      dir: p.dir,
      port: 0,
      pid: 0,
      error: '',
      startedAt: Date.now(),
      readyAt: 0,
      activeModel: '',
      warning: '',
    });
    push(`—— 启动 ${p.dir} ——`);

    (async () => {
      const port = await pickPort();
      /** 这几十毫秒里用户可能点了停止，或者又点了一次启动 */
      if (myRun !== runId) return;
      if (!port) throw new Error('连续 40 个端口都绑不上，可能被系统保留或被占用');

      const args = [
        p.apiScript,
        '-a', '127.0.0.1',
        '-p', String(port),
        ...(p.configFile ? ['-c', p.configFile] : []),
      ];
      push(`$ ${basename(p.python)} ${args.join(' ')}`);

      const proc = spawn(p.python, args, {
        cwd: p.dir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        /**
         * 强制 Python 用 UTF-8 写标准输出。
         *
         * 不加的话，Windows 上 Python 往**管道**写时用的是系统代码页（GBK），
         * 而 Node 按 UTF-8 解码 → 中文全变成 `◆◆◆`，面板日志里
         * `角色A-e15.ckpt` 显示成 `◆◆◆◆-e15.ckpt`，看着像文件坏了。
         *
         * 只设 `PYTHONIOENCODING`（只管标准流），不设 `PYTHONUTF8=1`——
         * 后者会把 Python 的默认文件编码也改掉，GPT-SoVITS 里有些库
         * 依赖 locale 读配置文件，改全局编码可能引出别的问题。
         */
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      child = proc;
      set({ port, pid: proc.pid || 0 });
      /** spawn 失败时 pid 是 undefined，别打一句「已起，pid undefined」误导人 */
      if (proc.pid) push(`进程已起，pid ${proc.pid}，端口 ${port}，等模型加载…`);

      const onData = (buf) => {
        for (const line of String(buf).split(/\r?\n/)) push(line);
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      /**
       * **必须监听 `error`，否则整个宿主进程会被带走。**
       *
       * `spawn` 失败（文件存在但不可执行、被杀软拦、probe 之后目录被移走）
       * 时 ChildProcess 会 emit `error`；没人接就是未捕获异常，
       * Node 直接退出——用户点一下「一键启动」，DSH、QQ 机器人、面板全停。
       *
       * 实测：造一个 probe 能认、但实际起不来的目录，未监听时
       * `Error: spawn ... ENOENT` → exit=1；加上监听后正常返回错误。
       */
      proc.once('error', (e) => {
        /** 这是上一次启动留下的进程：它怎么死都不该影响当前状态 */
        if (myRun !== runId) return;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        child = null;
        const msg = `进程起不来：${e?.message || e}`;
        set({ phase: 'error', error: msg, pid: 0, port: 0 });
        push(`—— ${msg} ——`);
        log(`GPT-SoVITS 启动失败：${e?.message || e}`);
      });

      proc.once('exit', (code) => {
        /**
         * **必须比对 runId。**
         *
         * `start → stop → start` 之后，第一个进程被杀时会走到这里；
         * 不比对的话它会把**新进程**的状态打成 error（日志里还带着新进程的
         * 输出，看着像新进程挂了，其实它好好的）。用户再点一次就多起一个。
         */
        if (myRun !== runId) return;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        if (state.phase === 'starting' || state.phase === 'running') {
          const tail = lines.filter(Boolean).slice(-3).join(' | ');
          set({ phase: 'error', error: `进程退出（code ${code}）${tail ? `：${tail}` : ''}`, pid: 0, port: 0 });
          log(`GPT-SoVITS 进程退出：code ${code}`);
        }
        child = null;
      });

      /** 轮询「端口有人监听了没有」。能绑 = 还没起；绑不上 = 起来了 */
      const deadline = Date.now() + READY_TIMEOUT_MS;
      timer = setInterval(async () => {
        /** 被新一次启动接管了：这个轮询器作废，别再改状态 */
        if (myRun !== runId) {
          clearInterval(timer);
          timer = null;
          return;
        }
        if (state.phase !== 'starting') {
          clearInterval(timer);
          timer = null;
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          timer = null;
          push(`—— 等了 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒还没就绪，放弃 ——`);
          killTree(state.pid);
          set({ phase: 'error', error: '启动超时（模型加载太慢或显存不够）', pid: 0, port: 0 });
          return;
        }
        /** 还能绑上 = 还没监听 = 还在加载 */
        const stillFree = await portFree(port);
        if (stillFree) return;
        clearInterval(timer);
        timer = null;
        set({ phase: 'running', readyAt: Date.now(), activeModel: p.character || '' });
        push(`—— 就绪：http://127.0.0.1:${port} ——`);
        log(`GPT-SoVITS 已就绪：127.0.0.1:${port}`);

        /**
         * 用户在下拉里选了别的角色（或手填了权重路径）：就绪后切过去，不动配置文件。
         */
        const wanted = String(opts.model || '').trim();
        const manualGpt = String(opts.gptWeights || '').trim();
        const manualSovits = String(opts.sovitsWeights || '').trim();
        const hasManual = Boolean(manualGpt || manualSovits);

        const decision = decideSwitch({ wanted, character: p.character, hasManual });

        if (decision.needed) {
          /** 选的就是配置文件里已加载的那个角色 → 跳过，省掉一次完整的权重加载 */
          if (decision.skip) {
            push(`角色「${wanted}」就是配置文件里已加载的，跳过切换`);
            set({ activeModel: wanted });
          } else {
            push(hasManual ? `按手填路径切换权重…` : `切换角色到「${wanted}」…`);
            try {
              const m = await switchModel(port, wanted, p.models || [], {
                gptWeights: manualGpt,
                sovitsWeights: manualSovits,
              });
              push(`权重已切到「${m.name}」（${m.version || m.gptPath || '手动路径'}）`);
              if (m.partial) {
                const auto = m.gptPath && !String(opts.gptWeights || '').trim() ? 'GPT' : 'SoVITS';
                const autoPath = auto === 'GPT' ? m.gptPath : m.sovitsPath;
                push(`注意：只填了一个权重路径，${auto} 还是按角色名自动配对的（${autoPath || '未找到'}）`);
                set({
                  activeModel: m.name,
                  warning: `只填了一个权重路径，${auto} 仍在自动配对（${autoPath || '未找到'}）。`
                    + '音色不对的话两个都手填。',
                });
              } else {
                set({ activeModel: m.name, warning: '' });
              }
              log(`GPT-SoVITS 已切换权重：${m.name}`);
            } catch (e) {
              const why = e?.message || e;
              push(`切换权重失败：${why}`);
              /**
               * **不能只 set({ error }) 就算了。**
               *
               * 以前切换失败时 `phase` 仍是 `running`，`onReady` 照样把地址填好，
               * 面板显示「正常输出」——但跑的是 `tts_infer.yaml` 里那个默认权重。
               * 用户听到的是另一个模型的声音，界面上却一点异常都没有
               * （截图里那句「输出的语音和我的语音模型声音完全不同」）。
               *
               * 现在把「实际生效的是谁」和警告一起摆出来，让用户当场能看出来。
               */
              const warning = `权重没切过去（${why}）。现在跑的是配置文件里的`
                + (p.character ? `「${p.character}」` : '默认模型')
                + `，音色会和你选的不一样`;
              set({ activeModel: p.character || '', warning });
              log(`GPT-SoVITS 切换权重失败：${why}`);
            }
          }
        }

        /** 就绪后通知宿主把配置填好（baseUrl / 路由 / 版本），用户不用再手抄端口 */
        try {
          onReady({ port, dir: p.dir, warning: state.warning });
        } catch (e) {
          log(`就绪回调失败：${e?.message || e}`);
        }
      }, 800);
      timer.unref?.();
    })().catch((e) => {
      set({ phase: 'error', error: String(e?.message || e), pid: 0 });
      push(`—— 启动失败：${e?.message || e} ——`);
      log(`GPT-SoVITS 启动失败：${e?.message || e}`);
    });

    return { ok: true, starting: true, dir: p.dir };
  }

  function status() {
    return {
      ...state,
      baseUrl: state.port ? `http://127.0.0.1:${state.port}/` : '',
      logs: lines.slice(-20),
    };
  }

  /** 宿主退出时把子进程带走，别留个占显存的孤儿 */
  function dispose() {
    /** 让在途的异步流程作废，并把状态收拾干净（否则重载后 start 会被 busy 挡住） */
    runId += 1;
    if (state.pid) killTree(state.pid);
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    child = null;
    set({ phase: 'stopped', pid: 0, port: 0 });
  }

  return { probe: probeDir, start, stop, status, dispose };
}
