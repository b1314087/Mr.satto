import type { MetadataRoute } from "next";
import { tools } from "@/lib/tools/data";
import { siteConfig } from "@/lib/config/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: siteConfig.url, changeFrequency: "weekly", priority: 1 },
    { url: `${siteConfig.url}/tools`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${siteConfig.url}/pricing`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${siteConfig.url}/login`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${siteConfig.url}/signup`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${siteConfig.url}/about`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${siteConfig.url}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${siteConfig.url}/terms`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${siteConfig.url}/contact`, changeFrequency: "yearly", priority: 0.3 },
  ];

  const toolRoutes: MetadataRoute.Sitemap = tools.map((tool) => ({
    url: `${siteConfig.url}/tools/${tool.id}`,
    changeFrequency: "monthly",
    priority: tool.status === "available" ? 0.8 : 0.5,
  }));

  return [...staticRoutes, ...toolRoutes];
}
