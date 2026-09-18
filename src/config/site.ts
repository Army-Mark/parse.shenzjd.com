// 站点级配置：集中管理品牌名、域名、联系邮箱等信息
// 修改品牌名/邮箱/域名时只需改这一处（或通过环境变量注入），
// 所有页面、页脚、法律页面、蜜罐文案会同步更新。
//
// 【改造说明】上游把品牌名与域名硬编码为原作者信息（神族九帝 / shenzjd.com），[rebrand-keep]
// 自建部署后会导致整站对外仍显示原作者的品牌与域名，故改为「环境变量优先 +
// 默认值指向本部署」：未配置时直接使用下方默认值，无需额外 .env 即可正确显示。
// 注意：NEXT_PUBLIC_* 在构建期注入，需在 build 前设置好。
export const siteConfig = {
  /** 品牌名（页面标题、页脚、结构化数据、蜜罐文案） */
  name: process.env.NEXT_PUBLIC_SITE_NAME || "口袋时光",

  /** 站点主域名（用于展示，如 footer 版权行） */
  domain: process.env.NEXT_PUBLIC_SITE_DOMAIN || "113826.xyz",

  /** 站点完整地址，需带协议；影响 metadataBase / canonical / sitemap / 分享链接 */
  url: process.env.NEXT_PUBLIC_SITE_URL || "https://parse.113826.xyz",

  // 版权 / 权利通知专用邮箱
  // 【改造说明】原作者的邮箱已去除，默认留空。留空时法律页不渲染邮箱，改为中性提示文案。
  // 如需展示，配置 NEXT_PUBLIC_COPYRIGHT_EMAIL 即可（构建期注入，改后需重新构建）。
  copyrightEmail: process.env.NEXT_PUBLIC_COPYRIGHT_EMAIL || "",

  // 通用联系邮箱（同上，留空即不展示）
  contactEmail: process.env.NEXT_PUBLIC_CONTACT_EMAIL || "",
} as const;
