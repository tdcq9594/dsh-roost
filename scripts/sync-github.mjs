#!/usr/bin/env node
/**
 * 把本地 HEAD 完整同步到 GitHub（用 Git Data API，绕开 git push 连不上）。
 *
 * 为什么要有这个：之前用 `%TEMP%/api-push.mjs` 手动列文件，**靠人记**——
 * 结果 `test/ai-chat-vision.mjs` 加了却忘了列，GitHub 一直缺这个文件。
 * 于是 Gitee（整仓 push）和 GitHub 的树不一样，
 * CI 的「内容指纹」校验每次都红，而且看不出为什么。
 *
 * 现在的做法：**递归对比本地树和远端树，自动算差异**，
 * 新增/修改/删除全推，推完再回读校验一遍。
 *
 * 用法：
 *   GH_TOKEN=xxx node scripts/sync-github.mjs [owner/repo] [branch]
 *
 * 退出码：0 = 已一致；1 = 失败（会把差异打出来）
 */

import { execFileSync } from 'node:child_process';

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('缺 GH_TOKEN');
  process.exit(1);
}

const REPO = process.argv[2];
const BRANCH = process.argv[3] || 'main';
if (!REPO) {
  console.error('用法: GH_TOKEN=xxx node scripts/sync-github.mjs owner/repo [branch]');
  process.exit(1);
}

const API = `https://api.github.com/repos/${REPO}`;
const H = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
  'user-agent': 'roost-sync',
};

const git = (args, opts = {}) => execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024, ...opts });

async function gh(path, init = {}) {
  const r = await fetch(`${API}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await r.text();
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} → ${r.status} ${j?.message || text.slice(0, 200)}`);
  return j;
}

/** 本地 HEAD 的完整文件表：path → {mode, sha} */
function localTree() {
  const out = git(['ls-tree', '-r', '-z', 'HEAD']);
  const map = new Map();
  for (const rec of out.toString('utf8').split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [mode, type, sha] = rec.slice(0, tab).split(' ');
    const path = rec.slice(tab + 1);
    if (type === 'blob') map.set(path, { mode, sha });
  }
  return map;
}

/** 远端树（递归）：path → sha */
async function remoteTree(commitSha) {
  const c = await gh(`/git/commits/${commitSha}`);
  const t = await gh(`/git/trees/${c.tree.sha}?recursive=1`);
  const map = new Map();
  for (const e of t.tree || []) {
    if (e.type === 'blob') map.set(e.path, e.sha);
  }
  return { treeSha: c.tree.sha, files: map, commit: c };
}

async function main() {
  const local = localTree();
  const head = git(['rev-parse', `refs/heads/${BRANCH}`]).toString().trim();

  let ref;
  try {
    ref = await gh(`/git/ref/heads/${BRANCH}`);
  } catch (e) {
    console.error(`读不到分支 ${BRANCH}：${e.message}`);
    process.exit(1);
  }
  const remote = await remoteTree(ref.object.sha);

  /* ---- 算差异 ---- */
  const changed = [];
  for (const [path, info] of local) {
    if (remote.files.get(path) !== info.sha) changed.push({ path, ...info });
  }
  const deleted = [];
  for (const path of remote.files.keys()) {
    if (!local.has(path)) deleted.push(path);
  }

  console.log(`远端 ${BRANCH} @ ${ref.object.sha.slice(0, 8)}，本地 HEAD ${head.slice(0, 8)}`);
  console.log(`差异：改/增 ${changed.length} 个，删 ${deleted.length} 个`);

  if (!changed.length && !deleted.length) {
    console.log('✓ 已经一致，不用推');
    return;
  }
  for (const c of changed.slice(0, 20)) console.log(`  M ${c.path}`);
  if (changed.length > 20) console.log(`  …还有 ${changed.length - 20} 个`);
  for (const d of deleted.slice(0, 10)) console.log(`  D ${d}`);

  /* ---- 建 blob（内容必须取自 git 对象，不能读工作区——行尾归一化会改字节） ---- */
  const entries = [];
  for (const c of changed) {
    const buf = git(['cat-file', 'blob', c.sha]);
    const blob = await gh('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
    });
    entries.push({ path: c.path, mode: c.mode, type: 'blob', sha: blob.sha });
  }
  // 删除：sha 传 null
  for (const d of deleted) entries.push({ path: d, mode: '100644', type: 'blob', sha: null });

  const tree = await gh('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: remote.treeSha, tree: entries }),
  });

  const commit = await gh('/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: process.env.SYNC_MESSAGE || `sync: 从本地 ${head.slice(0, 8)} 同步`,
      tree: tree.sha,
      parents: [ref.object.sha],
    }),
  });

  await gh(`/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });

  /* ---- 回读校验：新树必须和本地一模一样 ---- */
  const after = await remoteTree(commit.sha);
  const missing = [];
  const wrong = [];
  for (const [path, info] of local) {
    const got = after.files.get(path);
    if (!got) missing.push(path);
    else if (got !== info.sha) wrong.push(path);
  }
  const extra = [...after.files.keys()].filter((p) => !local.has(p));

  if (missing.length || wrong.length || extra.length) {
    console.error('✗ 推完还是不一致：');
    if (missing.length) console.error('  缺:', missing.slice(0, 10).join(', '));
    if (wrong.length) console.error('  内容不对:', wrong.slice(0, 10).join(', '));
    if (extra.length) console.error('  多出来:', extra.slice(0, 10).join(', '));
    process.exit(1);
  }

  console.log(`✓ ${BRANCH} → ${commit.sha.slice(0, 8)}，回读校验一致（${local.size} 个文件）`);
  console.log('  （commit SHA 与本地不同是正常的：Git Data API 建的 commit 对象字节不同，树一样）');
}

main().catch((e) => {
  console.error('同步失败：', e.message);
  process.exit(1);
});
