#!/usr/bin/env node
/**
 * 自建改造不变量守卫（self-host invariant guard）
 *
 * 用途：上游同步任务在推送前运行本脚本。若上游的改动把「已剥离的第三方认证 /
 * 作者前端资源」重新带回来，或把自建改造的关键点删掉，本脚本立即失败，阻止推送。
 *
 * 为什么需要它：补丁栈只保证「我们改过的地方」被重放。上游若在别处新增了对第三方
 * 认证的引用（新文件、新的 import），补丁不会冲突，构建也可能通过，问题会静默上线。
 * 本脚本把这些不变量显式断言出来，让同步任务以「失败」而不是「静默退化」结束。
 *
 * 用法：node scripts/selfhost-guard.mjs
 * 退出码：0 全部通过；1 存在违规（输出逐条说明）
 *
 * 说明：检查前会剥离注释，避免命中「说明文字里提到 wx-auth」这类误报。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

/** 代码级标记的扫描范围（含测试：测试里若出现旧守卫的引用，同样是回归信号） */
const CODE_SCAN_DIRS = ["src", "tests"];
/** 第三方资源域名的扫描范围（不含 tests：测试夹具会刻意使用无关外链 URL） */
const ASSET_SCAN_DIRS = ["src", "public"];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".open-next", ".wrangler", "coverage"]);
const SOURCE_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".css", ".json", ".html", ".svg", ".webmanifest"]);

/** 必须不存在的文件（相对仓库根） */
const FORBIDDEN_FILES = [
  "src/lib/wx-auth-client.ts",
  "src/lib/wx-auth-guard.ts",
  "src/lib/floating-unlock-client.ts",
  "src/config/floating-unlock.ts",
  "src/types/custom-elements.d.ts",
  "public/robots.txt",
  "public/sitemap.xml",
  ".github/workflows/sync-upstream.yml",
  // 自建版部署目标已收敛为 Docker / 服务器，Cloudflare 专用件不应出现
  "wrangler.toml",
  "open-next.config.ts",
];

/** 必须不存在于代码（已剥离注释）：这些标识只可能来自被剥离的认证/广告模块 */
const FORBIDDEN_CODE = [
  "AUTH_REQUIRED_ROUTES",
  "checkWxAuthToken",
  "getWxAuthToken",
  "getWxAuthUser",
  "showWxAuth",
  "unlockByAd",
  "window.WxAuth",
  "wx-auth-guard",
  "wx-auth-client",
  "opennextjs", // Cloudflare 适配器：自建版部署目标为 Docker / 服务器
];

/** 必须不存在于前端资源与运行时代码：第三方作者域名与外链脚本 */
const FORBIDDEN_ASSETS = [
  "@wu529778790",
  "cdn.jsdmirror.com",
  "img.shenzjd.com",
  "wx-auth.shenzjd.com",
  "unpkg.com",
];

/** 必须不存在于指定文件的字符串（防止上游把已剥离的平台专用件重新写回配置）
 *  注意：只断言「有实质影响」的项。像 .gitignore 里的构建产物忽略规则这类纯装饰性
 *  内容不在此列 —— 上游恢复它无害，不该因此让整次同步失败（避免误报阻断）。 */
const FORBIDDEN_IN_FILE = [
  { file: "package.json", needle: "@opennextjs/cloudflare", why: "Cloudflare 部署专用依赖，自建版已移除" },
  { file: "package.json", needle: "build:cf", why: "Cloudflare 专用构建脚本，自建版已移除" },
];

/** 必须存在于指定文件中的字符串（自建改造关键点） */
const REQUIRED = [
  { file: "src/lib/api-utils.js", needle: "ALLOWED_ORIGINS", why: "CORS 放行名单须由环境变量控制" },
  { file: "src/app/api/stats/route.js", needle: "STATS_API_KEY", why: "/api/stats 须用自有密钥鉴权" },
  { file: "src/config/site.ts", needle: "NEXT_PUBLIC_SITE_URL", why: "站点身份须可由环境变量覆盖" },
  { file: "src/lib/result-cache.js", needle: "NEXT_PUBLIC_SITE_URL", why: "缓存 key 须按本站地址派生" },
  { file: "src/config/site.ts", needle: "NEXT_PUBLIC_CONTACT_EMAIL", why: "邮箱须可配置（默认留空）" },
  { file: ".github/workflows/selfhost-sync.yml", needle: "selfhost", why: "自建同步工作流须存在" },
];

/** 必须存在的文件 */
const REQUIRED_FILES = [
  "selfhost/delete.txt",
  "改造说明.md",
];

/**
 * 运行时引擎下限（package.json → engines）。
 *
 * 为什么必须断言：`undici@8` 的 engines 声明为 `node >= 22.19.0`，它内部的
 * webidl 层会把 `node:worker_threads` 的 `markAsUncloneable` 挂到 Headers/Request
 * 等构造器上（`webidl.util.markAsUncloneable(this)`）。该 API 在 Node 20 上不存在，
 * 于是被赋值为 `undefined`，构造第一个 Headers 时即抛
 * `TypeError: ... markAsUncloneable is not a function` → B 站解析 HTTP 500。
 *
 * 这类问题的危险之处：**构建、类型检查、`npm test` 全都不会失败**，只有真实请求
 * 打到 undici 链路（本仓库中即 B 站）才暴露。因此必须由守卫在同步阶段提前拦下，
 * 而不是等它在生产环境以一个 500 的形式出现。
 */
const ENGINE_FLOOR = {
  file: "package.json",
  field: "node",
  min: "22.19.0",
  why: "undici@8 要求 node >= 22.19.0；低于此版本构造 Headers 时 markAsUncloneable 为 undefined，B 站解析运行时 500",
};

/** 提取形如 ">=22.19.0" / "^22" / "22.19.0" 中的数字版本 */
function parseVersion(spec) {
  const m = String(spec).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** actual 是否 >= min（比较主/次/补丁三段） */
function versionAtLeast(actual, min) {
  const a = parseVersion(actual);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** 剥离注释：行注释、块注释、HTML 注释。避免「说明文字里提到」造成误报 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

async function main() {
  const failures = [];
  const notes = [];

  // 1) 禁止文件
  for (const rel of FORBIDDEN_FILES) {
    if (existsSync(path.join(ROOT, rel))) {
      failures.push(`禁止文件仍然存在：${rel}（上游可能把已剥离的模块带回来了）`);
    }
  }

  // 2) 必须文件
  for (const rel of REQUIRED_FILES) {
    if (!existsSync(path.join(ROOT, rel))) {
      failures.push(`缺少必要文件：${rel}（叠加层可能未完整应用）`);
    }
  }

  // 3) 必须存在的字符串
  for (const { file, needle, why } of REQUIRED) {
    const full = path.join(ROOT, file);
    if (!existsSync(full)) {
      failures.push(`缺少必要文件：${file}（${why}）`);
      continue;
    }
    const text = await readFile(full, "utf8");
    if (!text.includes(needle)) {
      failures.push(`${file} 中未找到 ${needle}：${why}`);
    }
  }

  // 3.5) 指定文件中必须不出现的字符串
  for (const { file, needle, why } of FORBIDDEN_IN_FILE) {
    const full = path.join(ROOT, file);
    if (!existsSync(full)) continue;
    const text = await readFile(full, "utf8");
    if (text.includes(needle)) {
      failures.push(`${file} 中重新出现「${needle}」：${why}`);
    }
  }

  // 3.6) 运行时引擎下限（见 ENGINE_FLOOR 注释：低于下限时 B 站解析运行时 500）
  {
    const full = path.join(ROOT, ENGINE_FLOOR.file);
    if (!existsSync(full)) {
      failures.push(`缺少必要文件：${ENGINE_FLOOR.file}`);
    } else {
      let engines = {};
      try {
        engines = JSON.parse(await readFile(full, "utf8")).engines || {};
      } catch (e) {
        failures.push(`${ENGINE_FLOOR.file} 无法解析为 JSON：${e.message}`);
      }
      const declared = engines[ENGINE_FLOOR.field];
      if (!declared) {
        failures.push(
          `${ENGINE_FLOOR.file} 未声明 engines.${ENGINE_FLOOR.field}：${ENGINE_FLOOR.why}`
        );
      } else if (!versionAtLeast(declared, ENGINE_FLOOR.min)) {
        failures.push(
          `${ENGINE_FLOOR.file} 的 engines.${ENGINE_FLOOR.field} = "${declared}" 低于下限 ${ENGINE_FLOOR.min}：${ENGINE_FLOOR.why}`
        );
      }
    }
  }

  // 4) 禁止标记（剥离注释后匹配），代码级与资源级分开扫描
  async function scan(dirs) {
    const files = (await Promise.all(dirs.map((d) => walk(path.join(ROOT, d))))).flat();
    const out = [];
    for (const full of files) {
      if (!SOURCE_EXT.has(path.extname(full))) continue;
      let text;
      try {
        text = await readFile(full, "utf8");
      } catch {
        continue;
      }
      out.push({
        rel: path.relative(ROOT, full).split(path.sep).join("/"),
        code: stripComments(text),
      });
    }
    return out;
  }

  const codeFiles = await scan(CODE_SCAN_DIRS);
  const assetFiles = await scan(ASSET_SCAN_DIRS);

  for (const { rel, code } of codeFiles) {
    for (const needle of FORBIDDEN_CODE) {
      if (code.includes(needle)) {
        failures.push(`${rel} 中出现被剥离的认证/广告模块标记「${needle}」`);
      }
    }
  }
  for (const { rel, code } of assetFiles) {
    for (const needle of FORBIDDEN_ASSETS) {
      if (code.includes(needle)) {
        failures.push(`${rel} 中出现第三方作者资源「${needle}」`);
      }
    }
  }

  // 5) 补丁栈非空
  const patchDir = path.join(ROOT, "selfhost", "patches");
  let patchCount = 0;
  if (existsSync(patchDir)) {
    patchCount = (await readdir(patchDir)).filter((f) => f.endsWith(".patch")).length;
  }
  if (patchCount === 0) {
    failures.push("selfhost/patches 下没有任何补丁，同步任务将无法重建自建改造");
  } else {
    notes.push(`补丁栈：${patchCount} 个补丁`);
  }

  notes.push(`扫描文件：代码 ${codeFiles.length} 个 / 资源 ${assetFiles.length} 个`);
  notes.push(`检查项：禁止文件 ${FORBIDDEN_FILES.length} · 代码标记 ${FORBIDDEN_CODE.length} · 资源域名 ${FORBIDDEN_ASSETS.length} · 禁止写入 ${FORBIDDEN_IN_FILE.length} · 必需项 ${REQUIRED.length} · 引擎下限 >=${ENGINE_FLOOR.min}`);

  console.log("自建改造不变量检查");
  console.log("-".repeat(60));
  for (const n of notes) console.log(`  · ${n}`);
  console.log("-".repeat(60));

  if (failures.length) {
    console.error(`✗ 未通过：发现 ${failures.length} 项违规\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(
      "\n处理建议：上游很可能已改动相关代码。请合并上游最新代码到本地，" +
        "确认自建改造仍然成立，然后重新运行 `npm run selfhost:export` 导出补丁并提交。\n" +
        "本次同步不会推送，线上仍运行上一个正常版本。"
    );
    process.exit(1);
  }

  console.log("✓ 通过：自建改造关键不变量全部成立");
}

main().catch((err) => {
  console.error(`守卫脚本自身出错: ${err.stack || err.message}`);
  process.exit(1);
});
