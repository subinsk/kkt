import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

/**
 * robots.txt.
 *
 * Everything except the landing page is disallowed, and that is not caution —
 * rooms live in memory and their codes are minted per show. A crawler that
 * indexed `/join/7QK2` would be publishing a URL that is dead within minutes
 * and, while it is alive, is an invitation for a stranger to take a seat.
 *
 * `/api/` is closed for the same reason plus one more: `/api/health` reports
 * which environment variables are set.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/join/", "/host/", "/stage/"],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
