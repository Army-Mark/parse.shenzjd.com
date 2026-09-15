#!/usr/bin/env node
/**
 * 本地跟进上游更新（手动路径；云端自动路径见 .github/workflows/selfhost-sync.yml）
 *
 * 背景：本仓库是上游开源项目的 fork。推荐把远端配置为：
 *     origin   = 你自己的 fork（可写，用于发布）
 *     upstream = 作者本人的仓库（只读，上游更新来源）
 * 配好远端后，云端 selfhost-sync.yml 会每天自动跟进；本脚本用**同样的机制**在本地
 * 完成同一件事，便于先本地验证、再一键发布（--push）。
 *
 * 远端配置（一次性）：
 *     git remote set-url origin https://github.com/<你的账号>/parse.shenzjd.com.git
 *     git remote add upstream https://github.com/wu529778790/parse.shenzjd.com.git
 *     git fetch upstream
 *
 * 机制：
 *
 *   ① 记下当前 HEAD 作为回滚锚点（打 tag selfhost-pre-sync）
 *   ② 备份 selfhost/ 叠加层（重置会把它删掉）
 *   ③ fetch 上游最新 → 把工作区重置为上游
 *   ④ 重新贴回叠加层（补丁栈 + 删除清单）
 *   ⑤ 固定 .github/workflows 为同步前的版本（与云端工作流行为一致）
 *   ⑥ 不变量守卫 → 等价性验证 →（可选）安装/测试/构建
 *   ⑦ 全绿才提交到本地分支；默认**不推送**，加 --push 才推送到 origin（你自己的 fork）
 *
 * 用法：
 *   node scripts/sync-upstream.mjs                 # 完整流程
 *   node scripts/sync-upstream.mjs --check-only    # 只 fetch 并报告上游是否有更新
 *   node scripts/sync-upstream.mjs --skip-verify   # 跳过 npm ci / test / build（快，但风险高）
 *   node scripts/sync-upstream.mjs --remote upstream --branch main
 *   node scripts/sync-upstream.mjs --push           # 通过校验后强制推送到 origin（你的 fork）
 *
 * 前置要求：工作区必须**干净**（改动已提交）。原因见下方 ensureClean()。
 * 失败时：打印回滚命令，不会留下半成品状态（提交只在全部步骤通过后发生）。
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

const OWN_WORKFLOW = ".github/workflows/selfhost-sync.yml";
const ANCHOR_TAG = "selfhost-pre-sync";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const FLAG = (n) => process.argv.includes(`--${n}`);

const REMOTE = arg("remote", "upstream");
const BRANCH = arg("branch", "main");
const DRY = FLAG("check-only");
/** 同步成功并通过校验后，是否推送到 origin（你自己的 fork）。默认关闭，避免误推。 */
const PUSH = FLAG("push");
const SKIP_VERIFY = FLAG("skip-verify");

function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: opts.raw ? "buffer" : "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", opts.quiet ? "ignore" : "pipe"],
  });
}
/**
 * 取 NUL 分隔列表。
 * 注意：`-z` 必须紧跟子命令，绝不能写在末尾 —— 一旦命令行里有 `--` pathspec，
 * 末尾的 `-z` 会被 git 当作**路径参数**，导致结果只剩极少数条目（踩过）。
 */
function gitZ(args) {
  const withZ = [args[0], "-z", ...args.slice(1)];
  return execFileSync("git", withZ, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}
function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function npmRun(args) {
  return execFileSync(NPM, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function log(s) {
  process.stdout.write(`${s}\n`);
}
function step(s) {
  log(`\n▸ ${s}`);
}

function die(msg, hint) {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(hint);
  process.exit(1);
}

/** 回滚指引：改动尚未提交，锚点 tag 保留着同步前的完整状态 */
function printRollback(note) {
  console.error(
    [
      "",
      "── 如何回滚到同步前 ──",
      `  git reset --hard ${ANCHOR_TAG}     # 恢复同步前的代码状态`,
      "  git clean -fd                  # 清掉同步过程中新增的未跟踪文件",
      "",
      `  （${note}）`,
      `  锚点 tag ${ANCHOR_TAG} 会一直保留，确认无问题后可删除：git tag -d ${ANCHOR_TAG}`,
    ].join("\n")
  );
}

/** 前置：工作区必须干净 */
function ensureClean() {
  const dirty = git(["status", "--porcelain"]).trim();
  if (!dirty) return;
  const lines = dirty.split("\n");
  die(
    `工作区不干净，无法安全同步（有 ${lines.length} 项未提交改动）。`,
    [
      "",
      "为什么要拦：同步的第一步是 `git checkout -B <分支> <上游>`，它要求工作区干净；",
      "若强行进行，未提交的改动会被上游版本覆盖。请先提交：",
      "",
      "  npm run selfhost:export        # 确保叠加层是最新的（关键！）",
      "  npm run selfhost:guard         # 自查",
      "  git add -A && git commit -m \"chore(selfhost): snapshot before upstream sync\"",
      "",
      "然后再跑本脚本。",
      "",
      "当前未提交项（前 10 条）：",
      ...lines.slice(0, 10).map((l) => `  ${l}`),
    ].join("\n")
  );
}

function ensureRemote() {
  const remotes = git(["remote"]).split("\n").map((s) => s.trim()).filter(Boolean);
  if (!remotes.includes(REMOTE)) {
    die(
      `未配置远端「${REMOTE}」。`,
      [
        "",
        'origin 通常指向作者本人的仓库（你无写权限），建议另加一个 upstream 指向它：',
        "",
        `  git remote add ${REMOTE} https://github.com/wu529778790/parse.shenzjd.com.git`,
        "",
        `当前已有远端：${remotes.join(", ") || "(无)"}`,
      ].join("\n")
    );
  }
}

function main() {
  log(`仓库：${ROOT}`);

  step("检查前置条件");
  ensureClean();
  ensureRemote();
  const patchDir = path.join(ROOT, "selfhost", "patches");
  if (!existsSync(patchDir)) die("缺少 selfhost/patches，请先运行 npm run selfhost:export");
  const patches = existsSync(patchDir)
    ? readdirSync(patchDir).filter((f) => f.endsWith(".patch")).sort()
    : [];
  if (!patches.length) die("selfhost/patches 下没有补丁，无法重建自建改造");
  if (!existsSync(path.join(ROOT, "selfhost", "delete.txt"))) die("缺少 selfhost/delete.txt");
  log(`  ✓ 工作区干净 · 远端 ${REMOTE} · 补丁 ${patches.join(", ")}`);

  step(`拉取上游 ${REMOTE}/${BRANCH}`);
  git(["fetch", "--prune", REMOTE, BRANCH], { quiet: true });
  const upstreamRef = `${REMOTE}/${BRANCH}`;
  const upstreamSha = git(["rev-parse", upstreamRef]).trim();
  const localSha = git(["rev-parse", "HEAD"]).trim();
  const baseSha = git(["merge-base", "HEAD", upstreamRef]).trim();

  log(`  本地 HEAD   : ${localSha.slice(0, 10)}`);
  log(`  上游 HEAD   : ${upstreamSha.slice(0, 10)}`);
  if (upstreamSha === localSha) {
    log("\n✓ 上游没有新提交，无需同步。");
    process.exit(0);
  }
  const newCount = git(["rev-list", "--count", `${localSha}..${upstreamSha}`]).trim();
  log(`  上游新增提交: ${newCount} 个（共同祖先 ${baseSha.slice(0, 10)}）`);

  if (DRY) {
    log("\n--check-only：仅检查，未做任何改动。上游有更新，去掉 --check-only 即可执行同步。");
    process.exit(0);
  }

  step(`打回滚锚点 tag ${ANCHOR_TAG}`);
  git(["tag", "-f", ANCHOR_TAG, "HEAD"]);
  log(`  ✓ ${ANCHOR_TAG} → ${localSha.slice(0, 10)}`);

  // 叠加层必须在重置前取出来 —— 重置到上游会把 selfhost/ 一并清掉
  step("备份叠加层");
  const overlayBackup = mkdtempSync(path.join(os.tmpdir(), "selfhost-overlay-"));
  cpSync(path.join(ROOT, "selfhost"), path.join(overlayBackup, "selfhost"), { recursive: true });
  log(`  ✓ 已备份到 ${overlayBackup}`);

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();

  step(`重置工作区到上游（${branch} → ${upstreamRef}）`);
  try {
    git(["checkout", "-B", branch, upstreamRef]);
  } catch (e) {
    die("重置失败。", `${e.stderr?.toString() || e.message}\n`);
  }
  log(`  ✓ 现为 ${git(["rev-parse", "--short", "HEAD"]).trim()}`);

  step("贴回叠加层");
  cpSync(path.join(overlayBackup, "selfhost"), path.join(ROOT, "selfhost"), { recursive: true });
  const patchTmp = mkdtempSync(path.join(os.tmpdir(), "selfhost-patch-"));
  for (const p of patches) {
    try {
      // 应用前必须剥掉 CR：Windows 上 core.autocrlf=true 会把检出的 .patch 转成 CRLF，
      // 而 git apply 对行尾敏感 —— 会以「patch failed / does not apply」大面积失败，
      // 且现象极具误导性（工作区明明是纯净上游）。.gitattributes 的 `*.patch -text`
      // 已从源头避免，这里是防御性兜底，兼容在该文件加入之前就已存在的检出。
      const src = path.join(ROOT, "selfhost", "patches", p);
      const normalized = path.join(patchTmp, p.replace(/[\\/]/g, "_"));
      const raw = readFileSync(src, "utf8");
      const crCount = (raw.match(/\r/g) || []).length;
      if (crCount) log(`  · ${p} 检出为 CRLF（${crCount} 处 CR），已自动归一化为 LF`);
      writeFileSync(normalized, raw.replace(/\r\n/g, "\n"), "utf8");
      git(["apply", "--3way", "--whitespace=nowarn", normalized]);
      log(`  ✓ 应用 ${p}`);
    } catch (e) {
      const detail = (e.stderr?.toString?.() || e.message || "").trim();
      console.error(`\n✗ 补丁应用失败：${p}\n${detail}\n`);
      try {
        const conflicts = git(["diff", "--name-only", "--diff-filter=U"]).trim();
        if (conflicts) {
          console.error("冲突文件：");
          for (const f of conflicts.split("\n")) console.error(`  ${f}`);
          console.error(
            "\n这通常意味着：上游改动了你也在改的同一段代码。处理方式——\n" +
              "  1) 保持当前状态，手工解决冲突（文件里已写入 <<<<<<< ======= >>>>>>> 标记）\n" +
              "  2) 解决后运行：npm run selfhost:guard && npm run selfhost:verify\n" +
              "  3) 通过后：npm run selfhost:export && git add -A && git commit\n" +
              "  4) 不想折腾就按下面的命令整树回滚"
          );
        }
      } catch {
        /* 忽略 */
      }
      printRollback("本次未产生任何提交");
      process.exit(1);
    }
  }

  step("执行删除清单");
  const delLines = readFileSync(path.join(ROOT, "selfhost", "delete.txt"), "utf8").split(/\r?\n/);
  let removed = 0;
  for (const raw of delLines) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    try {
      git(["rm", "-rf", "-q", "-f", "--ignore-unmatch", "--", l]);
      removed++;
    } catch {
      /* 上游可能已删除 */
    }
  }
  log(`  ✓ 处理 ${removed} 项`);

  step("固定 .github/workflows 为同步前版本");
  const pinFiles = gitZ(["ls-tree", "-r", "--name-only", ANCHOR_TAG, "--", ".github/workflows"]);
  for (const f of pinFiles) {
    if (f === OWN_WORKFLOW) continue;
    writeFileSync(path.join(ROOT, f), git(["show", `${ANCHOR_TAG}:${f}`], { raw: true }));
  }
  for (const f of gitZ(["ls-tree", "-r", "--name-only", "HEAD", "--", ".github/workflows"])) {
    if (f === OWN_WORKFLOW) continue;
    if (!pinFiles.includes(f)) {
      rmSync(path.join(ROOT, f), { force: true });
      log(`  · 移除上游新增工作流 ${f}`);
    }
  }
  log(`  ✓ 已固定 ${pinFiles.length - 1} 个文件`);

  step("不变量守卫");
  try {
    process.stdout.write(run(process.execPath, ["scripts/selfhost-guard.mjs"]));
  } catch (e) {
    console.error(e.stdout?.toString() || "");
    console.error(e.stderr?.toString() || "");
    console.error(
      "\n✗ 守卫未通过：上游很可能在别处重新引入了被剥离的第三方依赖/认证。\n" +
        "  处理：按上面的违规项定位并清理，或放弃本次同步。"
    );
    printRollback("本次未产生任何提交");
    process.exit(1);
  }

  step("等价性验证");
  try {
    process.stdout.write(run(process.execPath, ["scripts/verify-overlay.mjs"]));
  } catch (e) {
    console.error(e.stdout?.toString() || "");
    console.error(e.stderr?.toString() || "");
    console.error("\n✗ 等价性验证未通过：叠加层无法完整重建改造结果（通常是补丁漏收录文件）。");
    printRollback("本次未产生任何提交");
    process.exit(1);
  }

  if (!SKIP_VERIFY) {
    step("重生成锁文件（package.json 已改动，锁文件是派生产物不进补丁）");
    run(NPM, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);

    step("安装依赖并测试、构建（耗时较长）");
    try {
      npmRun(["ci"]);
      npmRun(["test"]);
      npmRun(["run", "build"]);
    } catch {
      console.error("\n✗ 安装/测试/构建失败：上游改动与自建改造不兼容。");
      printRollback("本次未产生任何提交");
      process.exit(1);
    }
  } else {
    log("\n（--skip-verify：已跳过 npm ci / test / build）");
  }

  step("提交");
  git(["add", "-A"]);
  let changed = true;
  try {
    git(["diff", "--cached", "--quiet"]);
    changed = false;
  } catch {
    changed = true;
  }
  if (!changed) {
    log("  与上游无差异，无需提交。");
  } else {
    const short = upstreamSha.slice(0, 7);
    git(["commit", "-q", "-m", `chore(selfhost): reapply overlay on upstream ${short}`]);
    log(`  ✓ 已提交 ${git(["rev-parse", "--short", "HEAD"]).trim()}`);
  }

  rmSync(overlayBackup, { recursive: true, force: true });
  rmSync(patchTmp, { recursive: true, force: true });

  // 可选：推送回 origin（你自己的 fork）。
  // 同步会重写分支历史（= 上游 + 重放叠加层），与远端旧线不构成快进，
  // 因此用 --force-with-lease：若远端在你同步期间被推过，它会拒绝覆盖而非误伤。
  if (PUSH) {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    log(`\n  → 推送到 origin（${branch}，--force-with-lease）…`);
    try {
      git(["push", "--force-with-lease", "origin", `HEAD:${branch}`]);
      log("  ✓ 已推送到 origin（你的 fork）");
    } catch (e) {
      log("  ✗ 推送失败：");
      log(String(e.stderr || e.message).trim());
      log("    提示：远端若在你同步期间有新提交，--force-with-lease 会拒绝覆盖；请重新拉取后再试。");
      log("    另：若远端凭据走 Git for Windows 的 helper-selector 卡住，可临时加");
      log("        git -c credential.helper= -c credential.helper=store push ...");
      process.exitCode = 1;
    }
  }

  const followUps = [
    "  · 确认无问题后可删锚点：git tag -d " + ANCHOR_TAG,
    "  · 交给 GitHub Actions 自动同步更省心：.github/workflows/selfhost-sync.yml（每天 03:00 UTC）",
    "  · 部署更新：按 改造说明.md 第 8 章（Docker 或 systemd）",
  ];
  if (!PUSH) {
    followUps.unshift(
      "  · 想发布到你的 fork（origin）：",
      "      node scripts/sync-upstream.mjs --push",
      "      或：git push --force-with-lease origin HEAD:main"
    );
  }

  log(
    [
      "",
      "────────────────────────────────────────────",
      PUSH ? "✓ 同步完成，已推送到 origin（你的 fork）" : "✓ 同步完成（仅提交到本地分支，未推送）",
      "",
      "后续：",
      ...followUps,
    ].join("\n")
  );
}

main();
