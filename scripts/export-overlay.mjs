#!/usr/bin/env node
/**
 * 导出自建改造叠加层（overlay）
 *
 * 背景：本仓库是上游开源项目的 fork。自建改造以「补丁栈 + 删除清单」的形式保存，
 * 每日由 .github/workflows/selfhost-sync.yml 重置到上游后重新叠加，从而既保留
 * 上游同步能力，又不会被上游覆盖。
 *
 * 本脚本把「当前工作区相对上游 HEAD 的全部本地改动」导出为：
 *   selfhost/patches/*.patch   修改与新增（不含删除）
 *   selfhost/delete.txt        需要删除的文件清单
 *
 * 为什么把删除单独拆出来：删除用 `git rm -f --ignore-unmatch` 执行，对上游的任何
 * 改动都免疫。若把删除写进 patch，上游只要改了这些文件（例如 CI 工作流几乎天天改），
 * --3way 就会冲突并让整个同步任务失败。
 *
 * 用法：
 *   node scripts/export-overlay.mjs            # 导出
 *   node scripts/export-overlay.mjs --dry-run  # 只看会导出什么，不写文件
 *
 * 何时运行：任何一次本地改动之后（改了源码、改了工作流、加了脚本），
 * 都要重新运行本脚本，否则同步任务用的是旧补丁，你的新改动会被上游重置掉。
 */

import { execFileSync } from "node:child_process";
import { writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBase as resolveBaseShared, fallbackWarning, degradedWarning } from "./lib/selfhost-base.mjs";

const ROOT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const OVERLAY_DIR = path.join(ROOT, "selfhost");
const PATCH_DIR = path.join(OVERLAY_DIR, "patches");
const DELETE_FILE = path.join(OVERLAY_DIR, "delete.txt");

/** 叠加层自身的路径，绝不进入补丁（否则补丁会包含/改写自己） */
const OVERLAY_PATHS = ["selfhost"];

/**
 * 派生产物，不进入补丁。
 *
 * package-lock.json：锁文件是**派生**文件，不该参与合并。两条理由——
 *   ① 上游几乎每次依赖升降级都会重写它，放进补丁会让同步任务在 `--3way` 阶段
 *      频繁冲突，而冲突意味着整次同步中止；
 *   ② 它体量大，仅「移除一个依赖子树」就产生近 1MB 的 diff，而它本身对代码语义
 *      没有增量信息。
 * 正确做法：同步任务在应用补丁后用 `npm install --package-lock-only` 依据
 * package.json 重新生成锁文件（见 .github/workflows/selfhost-sync.yml）。
 */
const DERIVED_PATHS = ["package-lock.json"];

/**
 * 差异基线：相对「上游」而非 HEAD（详见 scripts/lib/selfhost-base.mjs）。
 *
 * 踩过的坑：本脚本原先是 `git diff`（工作区 vs 索引），只在本仓库「HEAD 恰等于上游、
 * 改动全部未提交」时成立。一旦把改造提交掉（同步前置条件要求工作区干净，所以提交
 * 必然发生），`git diff` 什么都不剩 —— 导出会**静默清空叠加层**（补丁缩到几百字节、
 * delete.txt 变成 0 项），下次同步就把上游代码原样贴回，改造全部丢失。
 */
function resolveBase() {
  const explicit =
    (process.argv.includes("--base")
      ? process.argv[process.argv.indexOf("--base") + 1]
      : null) || process.env.SELFHOST_BASE || null;
  return resolveBaseShared(ROOT, { explicit });
}

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * 取一组路径（NUL 分隔）。
 *
 * 必须用 -z：git 默认 core.quotePath=true，会把非 ASCII 路径转义成
 * "\346\224\271..." 这类带引号的字符串；若直接把它回传给 git add / git rm
 * 会因 pathspec 不匹配而失败（本仓库含「改造说明.md」「docs/中文文档.md」）。
 * -z 输出以 NUL 分隔且不做任何转义，可安全还原为字面路径。
 */
function gitPaths(args) {
  // -z 紧跟子命令：若写在末尾且命令行中出现 `--` pathspec，git 会把 -z 当成路径参数
  const out = execFileSync("git", [args[0], "-z", ...args.slice(1)], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/**
 * 内容不变则不落盘（幂等写入）。
 *
 * 为什么必须这样：即使内容逐字节相同，`writeFile` 也会刷新 mtime，使 git 的
 * 索引 stat 缓存失效 —— `git status` 于是报出「内容相同」的伪修改
 * （porcelain v2 里两侧 blob 哈希完全一致，却仍标记 .M）。而
 * scripts/sync-upstream.mjs 的 ensureClean() 以 `git status --porcelain`
 * 为准，会把这种伪修改误判成「工作区不干净」并直接拦截同步。
 * 幂等写入让「导出」成为可反复执行、无副作用的操作。
 */
async function writeIfChanged(target, content) {
  try {
    if (existsSync(target) && readFileSync(target, "utf8") === content) return false;
  } catch {
    /* 读取失败则照常写入 */
  }
  await writeFile(target, content, "utf8");
  return true;
}

async function main() {
  // 0) 前置检查：确认处于 git 仓库且能与上游比较
  try {
    git(["rev-parse", "--git-dir"]);
  } catch {
    throw new Error("当前目录不是 git 仓库");
  }

  // 1) 差异基线：相对「上游」而非 HEAD —— 见 resolveBase() 注释，这是本脚本最容易出错的地方
  const { base, ref: baseRef, fallback, degraded } = resolveBase();
  if (fallback) console.warn(fallbackWarning(ROOT));
  if (degraded) console.warn(degradedWarning(baseRef));

  // 2) 让未跟踪文件进入 diff（-N = intent-to-add，只登记不暂存内容）
  const untracked = gitPaths(["ls-files", "--others", "--exclude-standard"]).filter(
    (p) => !OVERLAY_PATHS.some((o) => p === o || p.startsWith(`${o}/`))
  );

  if (untracked.length) {
    for (const f of untracked) git(["add", "-N", "--", f]);
  }

  // 3) 删除清单：相对基线被删除的已跟踪文件
  const deleted = gitPaths(["diff", "--name-only", "--diff-filter=D", base])
    .filter((p) => !OVERLAY_PATHS.some((o) => p === o || p.startsWith(`${o}/`)))
    .sort();

  // 4) 补丁：修改与新增（显式排除删除，删除交给 delete.txt）
  const excludeArgs = [
    ...OVERLAY_PATHS.flatMap((p) => [`: (exclude)${p}`, `:(exclude)${p}/**`]),
    ...DERIVED_PATHS.map((p) => `:(exclude)${p}`),
  ];
  const patch = git([
    "diff",
    base,
    "--diff-filter=d", // 小写 d = 排除 Deleted
    "--binary",
    "--no-color",
    "--",
    ".",
    ...excludeArgs,
  ]);

  const bytes = Buffer.byteLength(patch, "utf8");
  const crlf = (patch.match(/\r\n/g) || []).length;
  const patchFiles = (patch.match(/^diff --git /gm) || []).length;
  console.log(`仓库根目录: ${ROOT}`);
  console.log(`差异基线: ${baseRef} → ${base.slice(0, 10)}`);
  console.log(`待删除文件: ${deleted.length} 个`);
  console.log(`派生产物(不进补丁): ${DERIVED_PATHS.join(", ") || "无"}`);
  console.log(`补丁字节数: ${bytes}（覆盖 ${patchFiles} 个文件）`);
  if (crlf > 0) {
    // git diff 正常产出 LF；出现 CR 说明过滤/配置异常，补丁在 git apply 时会大面积失败
    console.warn(
      `⚠ 补丁含 ${crlf} 处 CRLF —— git apply 对行尾敏感，会导致「patch does not apply」。\n` +
        `  请确认 .gitattributes 含 \`*.patch -text\`（禁止对补丁做行尾转换）。`
    );
  }
  console.log("-".repeat(60));
  if (deleted.length) {
    for (const f of deleted) console.log(`  D ${f}`);
  }

  // 5) 空补丁保护：绝不允许用一个空叠加层覆盖已有叠加层。
  //    触发条件：改造已提交但基线取错（最典型的是「相对于 HEAD」）、或远端未抓取。
  //    静默覆盖的后果是下次同步把上游代码原样贴回，改造全部丢失 —— 必须硬拦。
  if (patchFiles === 0 && !force) {
    console.error(
      "\n✗ 拒绝导出：算出的补丁覆盖 0 个文件，写入会清空叠加层。\n" +
        `  实际使用基线：${baseRef} → ${base.slice(0, 10)}\n` +
        "  排查：① 上游远端是否已抓取（git fetch upstream）；② 是否需要用 --base 显式指定上游提交。\n" +
        "  确认无误仍要写入请加 --force。"
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n--dry-run：未写入任何文件。");
    return;
  }

  await mkdir(PATCH_DIR, { recursive: true });

  // 清掉「非本次目标」的过期补丁切片，避免被同步任务一起应用。
  // 必须保留目标文件名本身：否则下面的幂等写入会因文件刚被删掉而必然重写，
  // 幂等性（以及由此带来的「无伪修改」）就失效了。
  const PATCH_NAME = "0001-selfhost-overlay.patch";
  const patchPath = path.join(PATCH_DIR, PATCH_NAME);
  if (existsSync(PATCH_DIR)) {
    for (const f of await readdir(PATCH_DIR)) {
      if (f.endsWith(".patch") && f !== PATCH_NAME) await rm(path.join(PATCH_DIR, f));
    }
  }

  const wrotePatch = await writeIfChanged(patchPath, patch);
  const deleteContent = deleted.length
    ? `# 每次同步时无条件删除的路径（相对仓库根），按行分隔，# 开头为注释\n${deleted.join("\n")}\n`
    : "# 无待删除文件\n";
  const wroteDelete = await writeIfChanged(DELETE_FILE, deleteContent);

  console.log("-".repeat(60));
  console.log(`${wrotePatch ? "已写入" : "未变化"} ${toPosix(path.relative(ROOT, patchPath))}`);
  console.log(`${wroteDelete ? "已写入" : "未变化"} ${toPosix(path.relative(ROOT, DELETE_FILE))}`);
  console.log("\n记得把 selfhost/ 一起提交，同步任务才能拿到最新叠加层。");
}

main().catch((err) => {
  console.error(`错误: ${err.message}`);
  process.exit(1);
});
