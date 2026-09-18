import { queryStats } from "@/lib/analytics";
import { getCorsHeaders } from "@/lib/api-utils";

export const runtime = "nodejs";

/**
 * 解析行为统计接口（只读）。
 *
 * 【改造说明】原鉴权复用第三方微信登录态（wxauth-token + 远程 userinfo 的 isAdmin），
 * 随认证模块一并移除。现改为站点自有密钥鉴权：请求头携带
 * `Authorization: Bearer <STATS_API_KEY>`。未配置 STATS_API_KEY 时本接口关闭（503），
 * 与「统计库未配置则记录功能自动禁用」的口径一致。
 *
 * 返回：按平台 / 按天（近 14 天）聚合 + 总量 / 独立访客（IP 匿名哈希）/ 独立链接数。
 */
export async function GET(request) {
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");

  const expectedKey = process.env.STATS_API_KEY;
  if (!expectedKey) {
    return Response.json(
      { code: 503, msg: "统计接口未启用（未配置 STATS_API_KEY）" },
      { status: 503, headers: corsHeaders }
    );
  }

  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^\s*bearer\s+(.+)$/i);
  const providedKey = match ? match[1].trim() : "";

  if (!providedKey || !timingSafeEqual(providedKey, expectedKey)) {
    return Response.json(
      { code: 401, msg: "鉴权失败，请携带有效的 Authorization: Bearer <STATS_API_KEY>" },
      { status: 401, headers: corsHeaders }
    );
  }

  const stats = await queryStats();
  if (!stats) {
    return Response.json(
      { code: 500, msg: "统计数据库未配置或查询失败" },
      { status: 500, headers: corsHeaders }
    );
  }

  return Response.json({ code: 200, msg: "ok", data: stats }, { headers: corsHeaders });
}

/**
 * 定长比较，避免逐字符短路比较泄漏密钥前缀信息。
 * 长度不同时仍走完整轮次，仅返回 false。
 */
function timingSafeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
