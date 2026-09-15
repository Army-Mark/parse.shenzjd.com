#!/usr/bin/env node
/**
 * 品牌 / 域名批量替换工具
 *
 * 用途：本项目由上游开源仓库 fork 而来，源码与文档中散布着原作者品牌名、
 * 域名与邮箱。本脚本把它们替换成自建者自己的信息。
 *
 * 用法（默认 dry-run，只报告不写盘）：
 *   node scripts/rebrand.mjs --name "口袋时光" --domain 113826.xyz \
 *        --url https://parse.113826.xyz
 *   node scripts/rebrand.mjs ... --write      # 确认无误后加 --write 真正写入
 *
 * 可选：
 *   --repo <owner/name>   你的 GitHub 仓库，用于替换 README 里的部署按钮与镜像地址
 *   --email <addr>        联系邮箱。**不传则视为「去掉作者邮箱」**：脚本不会写入任何
 *                         邮箱，并把 siteConfig 中的邮箱默认值改为空。
 *   --dir <path>          目标根目录（默认脚本所在仓库根目录）
 *
 * 保留原样（KEEP_ORIGINAL）：SEO 文案、品牌 SVG、README 等按需求保持上游原文，
 * 不做替换。见下方常量，可按需注释掉某一项以恢复替换。
 *
 * 行级豁免：任何一行只要包含 `rebrand-keep`，该行就不参与替换。用于代码注释中
 * 需要引用「上游原样信息」的场合（例如「原本只允许 *.shenzjd.com」），避免语义
 * 被反转，同时保证脚本可重复运行（幂等）。
 *
 * 替换顺序经过设计：先替换完整 URL，再替换裸域名，避免出现协议残留。
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 保持上游原文、不参与替换的路径（相对仓库根；目录写法末尾带 /，按前缀匹配） */
const KEEP_ORIGINAL = [
  "README.md",
  "src/config/seo-platforms.ts",
  "src/app/page.tsx",
  "src/app/platform/",
  "public/brand/",
  "改造说明.md",
  "selfhost/",
  "scripts/rebrand.mjs",
];

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", ".open-next", ".wrangler", ".turbo",
  "dist", "build", "coverage",
]);

const SKIP_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx",
  ".css", ".html", ".svg", ".txt", ".xml", ".yml", ".yaml", ".toml",
  ".webmanifest", ".example", ".sh", "",
]);

const SELF_FILE = fileURLToPath(import.meta.url);

/** 行级豁免标记：任何一行包含该字符串即跳过替换（用于需引用上游原样信息的注释） */
const KEEP_MARKER = "rebrand-keep";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") { args.write = true; continue; }
    if (a.startsWith("--")) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`参数 ${a} 缺少值`);
      }
      args[a.slice(2)] = val;
      i++;
    }
  }
  return args;
}

function requireArg(args, key, label) {
  if (!args[key]) throw new Error(`缺少必填参数 --${key}（${label}）`);
  return String(args[key]);
}

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, out);
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name)) continue;
      if (path.resolve(full) === path.resolve(SELF_FILE)) continue;
      if (!TEXT_EXT.has(path.extname(e.name))) continue;
      out.push(full);
    }
  }
  return out;
}

function isKept(relPath) {
  const p = relPath.split(path.sep).join("/");
  return KEEP_ORIGINAL.some((k) => p === k || p.startsWith(k));
}

function buildRules(args) {
  const name = requireArg(args, "name", "你的品牌名");
  const domain = requireArg(args, "domain", "你的域名，如 113826.xyz");
  const url = requireArg(args, "url", "你的站点完整地址").replace(/\/+$/, "");

  let host = url;
  try { host = new URL(url).host; } catch { /* 允许非标准 url */ }

  const rules = [
    // 1) 完整 URL（含协议）必须最先替换，否则会被裸域名规则切碎
    { label: "站点 URL", from: /https:\/\/parse\.shenzjd\.com/g, to: url },
    { label: "站点 host", from: /parse\.shenzjd\.com/g, to: host },
    // 2) 裸域名（含子域与注释中的后缀说明）
    { label: "域名", from: /shenzjd\.com/g, to: domain },
    // 3) 品牌名
    { label: "品牌名", from: /神族九帝/g, to: name },
    // 4) Cloudflare Worker 名（只允许小写字母数字与连字符）
    {
      label: "Worker 名称",
      from: /parse-shenzjd-com/g,
      to: `parse-${domain.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    },
  ];

  // 作者邮箱：默认「去掉」——置空而不是替换
  if (args.email) {
    rules.push({ label: "作者邮箱", from: /shenzujiudi@gmail\.com/g, to: String(args.email) });
  } else {
    rules.push({ label: "作者邮箱(去除)", from: /shenzujiudi@gmail\.com/g, to: "" });
  }

  if (args.repo) {
    const repo = String(args.repo).replace(/^\/+|\/+$/g, "");
    const repoName = repo.split("/").pop();
    rules.push(
      { label: "镜像地址", from: /(ghcr\.io|docker\.io)\/wu529778790\/parse\.shenzjd\.com/g, to: `$1/${repo}` },
      { label: "仓库引用", from: /wu529778790\/parse\.shenzjd\.com/g, to: repo },
      { label: "仓库短名", from: /repository-name=parse\.shenzjd\.com/g, to: `repository-name=${repoName}` }
    );
  }

  return { rules, name, domain, url };
}

function applyRules(text, rules, stats) {
  // 行级豁免：含 rebrand-keep 标记的行不参与替换。
  // 用途：代码注释里常需引用「上游原样」的品牌/域名（例如「原本只允许 *.shenzjd.com」），
  // 若被一并替换会造成语义反转；且重复运行会反复改写。加上标记即可长期豁免。
  if (text.includes(KEEP_MARKER)) {
    const out = [];
    for (const line of text.split("\n")) {
      if (line.includes(KEEP_MARKER)) {
        out.push(line);
        continue;
      }
      let l = line;
      for (const r of rules) {
        const m = l.match(r.from);
        if (!m) continue;
        stats.set(r.label, (stats.get(r.label) || 0) + m.length);
        l = l.replace(r.from, r.to);
      }
      out.push(l);
    }
    return out.join("\n");
  }

  let out = text;
  for (const r of rules) {
    const matches = out.match(r.from);
    if (!matches) continue;
    stats.set(r.label, (stats.get(r.label) || 0) + matches.length);
    out = out.replace(r.from, r.to);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(await readFile(fileURLToPath(import.meta.url), "utf8"));
    return;
  }

  const root = path.resolve(
    args.dir || path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
  );
  if (!existsSync(root)) throw new Error(`目录不存在: ${root}`);

  const { rules, name, domain, url } = buildRules(args);

  console.log(`目标目录: ${root}`);
  console.log(`品牌名  : ${name}`);
  console.log(`域名    : ${domain}`);
  console.log(`站点地址: ${url}`);
  console.log(`邮箱    : ${args.email ? args.email : "（去掉作者邮箱，不写入任何地址）"}`);
  console.log(`模式    : ${args.write ? "写入（--write）" : "预演（dry-run，不修改文件）"}`);
  console.log(`保留原样: ${KEEP_ORIGINAL.join(", ")}`);
  console.log("-".repeat(60));

  const files = await walk(root);
  const stats = new Map();
  const changed = [];
  const skipped = [];

  for (const file of files) {
    const rel = path.relative(root, file);
    let text;
    try { text = await readFile(file, "utf8"); } catch { continue; }

    if (isKept(rel)) {
      if (rules.some((r) => text.match(r.from))) skipped.push(rel);
      continue;
    }

    const next = applyRules(text, rules, stats);
    if (next !== text) {
      changed.push(rel);
      if (args.write) await writeFile(file, next, "utf8");
    }
  }

  console.log(`扫描文本文件: ${files.length}`);
  console.log(`命中替换的文件: ${changed.length}`);
  console.log("-".repeat(60));
  for (const [label, count] of [...stats.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label.padEnd(14)} ${count} 处`);
  }
  console.log("-".repeat(60));
  for (const f of changed.slice(0, 60)) console.log(`  ${f}`);
  if (changed.length > 60) console.log(`  ... 其余 ${changed.length - 60} 个文件`);

  if (skipped.length) {
    console.log("-".repeat(60));
    console.log(`按 KEEP_ORIGINAL 保留原文（含原作者品牌字样的）文件 ${skipped.length} 个：`);
    for (const f of skipped.slice(0, 40)) console.log(`  ${f}`);
    if (skipped.length > 40) console.log(`  ... 其余 ${skipped.length - 40} 个文件`);
    console.log("注意：这些文件对外仍会显示原作者品牌，如需要替换请从 KEEP_ORIGINAL 中移除对应项。");
  }

  if (!args.write) {
    console.log("\n以上为预演结果。确认无误后加上 --write 重新执行以写入。");
  } else {
    console.log("\n替换完成。请重新构建（npm run build）使 NEXT_PUBLIC_* 与文案生效。");
  }
}

main().catch((err) => {
  console.error(`错误: ${err.message}`);
  process.exit(1);
});
