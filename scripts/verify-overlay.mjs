#!/usr/bin/env node
/**
 * 叠加层等价性验证：证明「重置到上游 + 重放叠加层」能 1:1 重建当前改造结果。
 *
 * 为什么需要它：`.github/workflows/selfhost-sync.yml` 每天都在做这件事，但只有真正
 * 跑到 GitHub 上才会发现叠加层不完整（漏文件、漏删除项）。本地一键验证可以把问题
 * 提前暴露，而不是等同步任务把改造重置掉。
 *
 * 做法（与工作流同序）：
 *   ① 在临时目录建一个指向上游基线的干净 worktree（基线 = merge-base HEAD upstream/main）
 *   ② 取回 selfhost/ 叠加层，`git apply --3way` 应用补丁
 *   ③ 执行 delete.txt 里的删除
 *   ④ 固定 .github/workflows 为「当前版本」（等价于工作流里 LAST = 上一个正常版本）
 *   ⑤ 两侧各算一次 `git write-tree`，比对目录树哈希
 *
 * 用法：node scripts/verify-overlay.mjs
 * 退出码：0 等价；1 不等价（列出差异路径）
 *
 * ⚠️ 两个容易误判的点，脚本已内置处理：
 *   · 派生产物（package-lock.json）**必然不同** —— 它按设计被排除出补丁，
 *     由同步工作流用 `npm install --package-lock-only` 重建。属预期，不算失败。
 *   · 文件模式（可执行位）—— Windows 上 `core.fileMode=false`，若用**全新的空索引**
 *     直接 `git add -A`，git 会从文件系统重新登记权限，把 100755 降成 100644，
 *     产生「1 file changed, 0 insertions, 0 deletions」的伪差异。因此本脚本坚持
 *     「先 `git read-tree <基线>` 再 `git add -A`」。两侧必须用**同一个基线**，
 *     否则「已提交」场景下 HEAD（含改造）与上游基线的文件模式来源不同，会产生伪差异。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { cp, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBase, fallbackWarning, degradedWarning } from "./lib/selfhost-base.mjs";

const ROOT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

/** 与 scripts/export-overlay.mjs 的 DERIVED_PATHS 保持一致 */
const DERIVED_PATHS = ["package-lock.json"];

/** 本叠加层自有的工作流，不参与「固定上游工作流」步骤 */
const OWN_WORKFLOW = ".github/workflows/selfhost-sync.yml";

function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: opts.cwd || ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
  });
}

/** 取路径列表（NUL 分隔）：避免 core.quotePath=true 把非 ASCII 路径转义 */
function gitPaths(args, cwd) {
  const out = execFileSync("git", [...args, "-z"], {
    cwd: cwd || ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

/**
 * 用「临时索引」计算某个工作树的目录树哈希。
 * 关键：必须先 read-tree 载入**基线**的索引内容（携带正确的文件模式），再 add -A。
 * 若省掉 read-tree（或用一个全新的空索引），Windows 上会丢失可执行位。
 *
 * 同时返回 `normalized`：把派生产物（锁文件）从索引里摘掉后重新 write-tree 得到的哈希。
 * 拿它去比对，等价性就是一个可直接引用的单一数值，而不是「两个哈希不同、但只差一个
 * 已解释的文件」。
 */
function treeHash({ repo, indexPath, base }) {
  if (existsSync(indexPath)) rmSync(indexPath, { force: true });
  const env = { GIT_INDEX_FILE: indexPath };
  git(["read-tree", base], { cwd: repo, env });
  git(["add", "-A"], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
  let normalized;
  try {
    git(["rm", "--cached", "-q", "--force", "--ignore-unmatch", "--", ...DERIVED_PATHS], {
      cwd: repo,
      env,
    });
    normalized = git(["write-tree"], { cwd: repo, env }).trim();
  } catch {
    normalized = null;
  }
  // 摘掉派生产物后再取完整树哈希，避免影响后续 diff
  git(["read-tree", base], { cwd: repo, env });
  git(["add", "-A"], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
  const tree = git(["write-tree"], { cwd: repo, env }).trim();
  rmSync(indexPath, { force: true });
  return { tree, normalized };
}

/** 列出目录树里 path -> blob 哈希（忽略 mode，用于内容级比对） */
function blobIndex(tree, cwd) {
  const out = git(["ls-tree", "-r", tree], { cwd });
  const map = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // <mode> <type> <hash>\t<path>
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    map.set(line.slice(tab + 1), { mode: meta[0], hash: meta[2] });
  }
  return map;
}

async function main() {
  const tmpRoot = os.tmpdir();
  const sim = await mkdtemp(path.join(tmpRoot, "verify-overlay-"));
  const idxMain = path.join(tmpRoot, `verify-idx-${process.pid}.main`);
  const idxSim = path.join(tmpRoot, `verify-idx-${process.pid}.sim`);
  let worktreeAdded = false;

  try {
    // ---- 0) 前置：解析上游基线，且叠加层存在 ----
    const patchDir = path.join(ROOT, "selfhost", "patches");
    if (!existsSync(patchDir)) throw new Error("缺少 selfhost/patches，请先运行 npm run selfhost:export");
    const patchFiles = readdirSync(patchDir)
      .filter((f) => f.endsWith(".patch"))
      .sort();
    if (!patchFiles.length) throw new Error("selfhost/patches 下没有补丁");

    // ---- 0.5) 补丁可移植性 ----
    // 判据是**仓库里的 blob** 必须为纯 LF —— CI 在 Linux 上检出并 `git apply`，
    // CRLF 会让上下文匹配失败。本地工作区可能是 CRLF：Windows 的 core.autocrlf=true
    // 会转换检出内容；.gitattributes 的 `*.patch -text` 已禁止该转换，若尚未生效
    // （在加入该文件之前克隆的仓库），应用前会自动归一化，不影响正确性，故只提示不失败。
    for (const p of patchFiles) {
      const rel = `selfhost/patches/${p}`;
      let blob = null;
      try {
        blob = git(["show", `HEAD:${rel}`]);
      } catch {
        blob = null; // 尚未提交
      }
      const probe = blob ?? readFileSync(path.join(patchDir, p), "utf8");
      const crlf = (probe.match(/\r\n/g) || []).length;
      if (crlf > 0 && blob) {
        console.error(
          `✗ ${rel} 的仓库 blob 含 ${crlf} 处 CRLF：CI 上 git apply 会失败或写出 CRLF 文件。\n` +
            `  修复：确认 .gitattributes 含 \`*.patch -text\`，然后重新提交该补丁。`
        );
        return 1;
      }
      if (crlf > 0) {
        console.log(`  · ${p} 工作区为 CRLF（${crlf} 行，尚未提交），应用前会自动归一化为 LF`);
      } else {
        console.log(`  ✓ ${p} 为纯 LF（${blob ? "仓库 blob" : "工作区文件"}）`);
      }
    }

    const deleteFile = path.join(ROOT, "selfhost", "delete.txt");
    if (!existsSync(deleteFile)) throw new Error("缺少 selfhost/delete.txt");

    console.log(`补丁: ${patchFiles.join(", ")}`);

    // 差异基线 = 上游提交（不是 HEAD）：补丁是「相对上游」生成的，
    // 临时工作树必须建立在同一基线上，否则「新增文件」会被重复添加而冲突。
    const { base, ref: baseRef, fallback, degraded } = resolveBase(ROOT);
    if (fallback) console.warn(fallbackWarning(ROOT));
    if (degraded) console.warn(degradedWarning(baseRef));
    console.log(`差异基线: ${baseRef} → ${base.slice(0, 10)}`);

    // ---- 1) 建干净 worktree（基于上游基线）----
    rmSync(sim, { recursive: true, force: true });
    git(["worktree", "add", "--detach", "--force", sim, base], { stdio: ["ignore", "pipe", "pipe"] });
    worktreeAdded = true;

    // ---- 2) 取回叠加层并应用补丁 ----
    await cp(path.join(ROOT, "selfhost"), path.join(sim, "selfhost"), { recursive: true });
    // 应用前剥离 CR：Windows 上 core.autocrlf=true 会把检出的 .patch 转成 CRLF，
    // git apply 对行尾敏感 → 会误报「patch does not apply」。.gitattributes 的
    // `*.patch -text` 从源头避免，这里是兜底（兼容既有检出）。
    // 归一化后的副本写在临时目录，绝不能写进 sim 工作树 —— 那会多出一个未跟踪文件，
    // 破坏随后的目录树比对。
    const patchTmp = await mkdtemp(path.join(os.tmpdir(), "verify-patch-"));
    for (const p of patchFiles) {
      const raw = readFileSync(path.join(patchDir, p), "utf8");
      const crCount = (raw.match(/\r/g) || []).length;
      const normalized = path.join(patchTmp, p);
      writeFileSync(normalized, raw.replace(/\r\n/g, "\n"), "utf8");
      git(["apply", "--3way", "--whitespace=nowarn", normalized], {
        cwd: sim,
        stdio: ["ignore", "pipe", "pipe"],
      });
      console.log(`  ✓ 应用 ${p}${crCount ? `（检出为 CRLF，已自动归一化为 LF）` : ""}`);
    }
    rmSync(patchTmp, { recursive: true, force: true });

    // ---- 3) 执行删除清单 ----
    const lines = readFileSync(deleteFile, "utf8").split(/\r?\n/);
    let removed = 0;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l || l.startsWith("#")) continue;
      try {
        git(["rm", "-rf", "-q", "-f", "--ignore-unmatch", "--", l], { cwd: sim });
        removed++;
      } catch {
        /* 上游可能已删除该路径，忽略 */
      }
    }
    console.log(`  ✓ 删除 ${removed} 项`);

    // ---- 4) 固定 .github/workflows 为「当前版本」----
    // 枚举集合 = sim 现有工作流 ∪ 本仓库工作区现有工作流。
    // 取「本仓库工作区」而非 `ls-tree HEAD`：改造尚未提交时 HEAD 仍指向上游，
    // 会漏掉新增工作流；工作区枚举在「已提交 / 未提交」两种场景下都成立。
    const wfDir = path.join(ROOT, ".github", "workflows");
    const ownWf = existsSync(wfDir)
      ? readdirSync(wfDir).map((f) => `.github/workflows/${f}`)
      : [];
    const wfFiles = gitPaths(["ls-files", ".github/workflows"], sim).concat(ownWf);
    for (const f of new Set(wfFiles)) {
      if (f === OWN_WORKFLOW) continue;
      const src = path.join(ROOT, f);
      if (existsSync(src)) {
        await cp(src, path.join(sim, f));
      } else {
        rmSync(path.join(sim, f), { force: true });
        try {
          git(["rm", "-q", "-f", "--ignore-unmatch", "--", f], { cwd: sim });
        } catch {
          /* 不存在则跳过 */
        }
      }
    }

    // ---- 5) 两侧树哈希（同一基线，保证文件模式来源一致）----
    const simT = treeHash({ repo: sim, indexPath: idxSim, base: base });
    const wtT = treeHash({ repo: ROOT, indexPath: idxMain, base: base });
    const treeSim = simT.tree;
    const treeWt = wtT.tree;
    console.log(`\n改造后工作区 tree: ${treeWt}`);
    console.log(`叠加层重放 tree  : ${treeSim}`);
    console.log(`归一化（排除 ${DERIVED_PATHS.join(", ")}）:`);
    console.log(`  工作区: ${wtT.normalized}`);
    console.log(`  重放  : ${simT.normalized}`);

    // ---- 6) 判定 ----
    const diffPaths = git(["diff", "--name-only", treeWt, treeSim]).split("\n").filter(Boolean);
    const unexpected = diffPaths.filter((p) => !DERIVED_PATHS.some((d) => p === d || p.startsWith(`${d}/`)));

    const a = blobIndex(treeWt, ROOT);
    const b = blobIndex(treeSim, ROOT);
    const onlyA = [...a.keys()].filter((k) => !b.has(k));
    const onlyB = [...b.keys()].filter((k) => !a.has(k));
    let contentDiff = 0;
    let modeDiff = 0;
    for (const [p, x] of a) {
      const y = b.get(p);
      if (!y) continue;
      if (x.hash !== y.hash) contentDiff++;
      if (x.mode !== y.mode) modeDiff++;
    }

    console.log(`\n文件数: 工作区 ${a.size} / 重放 ${b.size}`);
    console.log(`仅工作区独有: ${onlyA.length} | 仅重放独有: ${onlyB.length}`);
    console.log(`内容不同: ${contentDiff}（期望恰为派生产物 ${DERIVED_PATHS.length} 个）| 仅模式不同: ${modeDiff}`);

    const ok =
      unexpected.length === 0 &&
      onlyA.length === 0 &&
      onlyB.length === 0 &&
      modeDiff === 0 &&
      simT.normalized !== null &&
      simT.normalized === wtT.normalized;
    if (ok) {
      console.log(
        `\n✓ 等价：叠加层可 1:1 重建改造结果\n` +
          `  归一化 tree 哈希（两侧一致）: ${wtT.normalized}\n` +
          `  唯一差异为派生产物 ${DERIVED_PATHS.join(", ")}，由同步工作流用 npm install --package-lock-only 重建`
      );
      return 0;
    }
    console.error("\n✗ 不等价，叠加层无法完整重建改造结果：");
    if (onlyA.length) console.error(`  · 仅工作区存在（补丁漏收录？）: ${onlyA.slice(0, 20).join(", ")}`);
    if (onlyB.length) console.error(`  · 仅重放存在（多余收录？）: ${onlyB.slice(0, 20).join(", ")}`);
    if (unexpected.length) console.error(`  · 非派生文件内容/模式不同: ${unexpected.slice(0, 20).join(", ")}`);
    if (modeDiff) console.error(`  · 文件模式不同: ${modeDiff} 个（Windows 上常见，CI 为 Linux 时不复现）`);
    console.error("\n处理：确认改动已提交前运行 `npm run selfhost:export` 重新导出叠加层。");
    return 1;
  } finally {
    rmSync(idxMain, { force: true });
    rmSync(idxSim, { force: true });
    if (worktreeAdded) {
      try {
        git(["worktree", "remove", "--force", sim], { stdio: ["ignore", "ignore", "ignore"] });
      } catch {
        /* 已不存在 */
      }
      try {
        git(["worktree", "prune"], { stdio: ["ignore", "ignore", "ignore"] });
      } catch {
        /* 忽略 */
      }
    }
    rmSync(sim, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`验证脚本出错: ${err.stdout?.toString?.() || err.message}`);
    process.exit(2);
  });
