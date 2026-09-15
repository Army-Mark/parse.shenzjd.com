// 蜜罐响应：命中黑名单的爬虫/脚本不再收到 403，而是收到 200 + 结构化数据，
// 让脚本误以为抓取成功（继续消费），避免其退出后换 IP / 换 UA 重试。
// 设计：
// - 状态码 200，符合爬虫"成功"预期；
// - code: 200 与正常解析一致，兼容统一入口 /api/parse 的转发逻辑；
// - data 为全量空值 + 一条占位条目，字段命名与真实平台一致，
//   前端若误渲染也能兜底（url 指向本站，不会外链挟持）；
// - msg 为中性提示文案，日志侧仍可辨识这是蜜罐（honeypot: true）。
//
// 【改造说明】原实现的 msg / author 文案用于把爬虫流量引流到作者的公众号，
// 属于站外营销依赖，已改为中性文案；占位 url 与品牌名统一取自本站配置。
import { siteConfig } from "@/config/site";

export const HONEYPOT_MSG =
  `${siteConfig.name}提示：该分享链接当前无法解析出原画直链，请稍后重试或更换链接。`;

const HONEYPOT_LEAD_URL = `${siteConfig.url}/`;

export function honeypotResponse(route = "unknown") {
  return {
    code: 200,
    msg: HONEYPOT_MSG,
    platform: route,
    data: {
      title: HONEYPOT_MSG,
      desc: "",
      author: siteConfig.name,
      avatar: "",
      cover: "",
      // 关键：url 指向本站（避免外链挟持、防爬虫拿到第三方直链），
      // 结构上与真实平台 data 一致，前端可安全渲染。
      url: HONEYPOT_LEAD_URL,
      videos: [
        {
          title: HONEYPOT_MSG,
          url: HONEYPOT_LEAD_URL,
          duration: 0,
        },
      ],
      honeypot: true,
    },
  };
}
