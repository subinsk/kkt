import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

/**
 * Sitemap.
 *
 * One entry, because there is one indexable page. Room routes are per-show and
 * gone by the time a crawler would return to them — see `app/robots.ts`.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl(),
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
