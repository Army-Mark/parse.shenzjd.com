/**
 * 自建叠加层的「差异基线」解析（被 export-overlay / verify-overlay 共用）
 *
 * 为什么需要它：叠加层保存的是「相对**上游**的差异」。基线必须是上游那个提交，
 * 而不是 HEAD。用 HEAD 当基线只在本仓库「HEAD 恰好等于上游、改动全部未提交」时成立；
 * 一旦改造被提交（同步前置条件就要求工作区干净，所以提交是必然的），
 * 以 HEAD 为基线算出的差异会变成空 —— 叠加层被静默清空，下次同步即丢失全部改造。
 *
 * 因此统一取 `merge-base HEAD <上游分支>`：
 *   · 未提交时：HEAD == 上游 → 共同祖先即 HEAD（与旧行为一致）
 *   · 已提交时：共同祖先 = 上游提交 → 差异正好是全部改造
 *
 * 远端分支候选顺序（未显式指定时）：upstream/main > origin/main > 降级为 HEAD（并告警）。
 *
 * ⚠️ fork 模式（origin = 你自己的仓库，upstream = 原作者仓库）下，origin/main 是**你
 *    自己的改造线**，不能当上游基线。因此首选必须是 upstream/main；一旦退到 origin/main，
 *    返回 degraded=true，调用方必须告警 —— 否则「origin/main + 少量未提交改动」会算出一个
 *    很短的非空补丁，绕过「空补丁保护」把叠加层覆盖掉。
 */

import { execFileSync } from "node:child_process";

export const UPSTREAM_REF_CANDIDATES = ["upstream/main", "origin/main"];

export function resolveBase(ROOT, { explicit = null } = {}) {
  const candidates = explicit ? [explicit, ...UPSTREAM_REF_CANDIDATES] : UPSTREAM_REF_CANDIDATES;
  for (const ref of candidates) {
    if (!ref) continue;
    try {
      const base = execFileSync("git", ["merge-base", "HEAD", ref], {
        cwd: ROOT,
        encoding: "utf8",
        // 静默 stderr：探测未抓取的远端会打印 "fatal: Not a valid object name"，
        // 属于正常探测失败，不该吓到使用者
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (base) {
        // 非显式指定、且未采用首选候选（upstream/main）→ 标记为「降级引用」。
        const degraded = !explicit && ref !== UPSTREAM_REF_CANDIDATES[0];
        return { base, ref, fallback: false, degraded };
      }
    } catch {
      /* 该远端不存在或未抓取，试下一个 */
    }
  }
  return { base: "HEAD", ref: "(降级:HEAD)", fallback: true, degraded: false };
}

/** 全部候选都不可用（退化为相对 HEAD）时的统一提示文案 */
export function fallbackWarning(ROOT) {
  return (
    "⚠ 未能确定上游基线（upstream/main 与 origin/main 均不可用）→ 退化为「相对 HEAD」。\n" +
    "  若改造已提交，这会导致叠加层被算成空。请先配置并抓取上游远端：\n" +
    "    git remote add upstream https://github.com/<作者>/<仓库>.git && git fetch upstream\n" +
    "  或显式指定基线：--base <上游提交>"
  );
}

/** 退用了非首选基线（通常是 origin/main）时的提示：fork 模式下这很危险 */
export function degradedWarning(ref) {
  return (
    `⚠ 未找到 upstream/main，改用 ${ref} 作为差异基线。\n` +
    "  fork 模式下 origin 指向「你自己的仓库」，其 main 可能已包含改造 —— 以它为基线会把改造算成空。\n" +
    "  请配置原作者仓库为 upstream 并抓取后重试：\n" +
    "    git remote add upstream https://github.com/<作者>/<仓库>.git && git fetch upstream"
  );
}
