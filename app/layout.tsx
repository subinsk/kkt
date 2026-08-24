import type { Metadata, Viewport } from "next";
import { Archivo, Barlow_Condensed } from "next/font/google";
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_TITLE,
  siteUrl,
} from "@/lib/seo";
import "./globals.css";

/**
 * Barlow Condensed for anything large or numeric. It is a broadcast face —
 * narrow enough that a six-minute clock fits at projector scale, and heavy
 * enough to hold up against a hot studio background.
 */
const display = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-display",
  display: "swap",
});

/** Archivo for interface text. Slightly mechanical, which suits the panels. */
const ui = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

/**
 * Page metadata.
 *
 * The icons, the web manifest and both social images are *not* listed here —
 * Next discovers `app/favicon.ico`, `app/icon.png`, `app/apple-icon.png`,
 * `app/manifest.ts`, `app/opengraph-image.png` and `app/twitter-image.png` by
 * filename and writes the tags itself. Naming them again here would emit a
 * second, competing set. Regenerate them with `npm run render:brand`.
 */
export const metadata: Metadata = {
  // Absolute URLs for og:image and the canonical link are built from this.
  metadataBase: new URL(siteUrl()),
  title: {
    default: SITE_TITLE,
    // Room routes are noindex, so this is mostly for the browser tab.
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  category: "games",
  keywords: [
    "Hinglish quiz game",
    "Hindi English party game",
    "voice AI game show",
    "quiz show party game",
    "riddle game for groups",
    "phone a friend game",
    "three player phone game",
    "paheli game",
    "wire cutting game",
    "Kaun Katega Taarpati",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: "en_IN",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      // The wordmark is the whole preview. A thumbnail-sized crop of it is
      // unreadable, so ask for the full-width treatment.
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  appleWebApp: {
    capable: true,
    // Short enough to survive under a home-screen icon without an ellipsis.
    title: "Taarpati",
    statusBarStyle: "black-translucent",
  },
  /**
   * iOS otherwise finds "numbers" in the game UI and turns them into tel:
   * links — a room code, a wire count, a countdown. A contestant who taps one
   * mid-round gets the dialler instead of an answer.
   */
  formatDetection: { telephone: false, address: false, email: false },
};

/**
 * Structured data.
 *
 * Lives in the layout rather than the landing page because the landing page is
 * a client component, and this is one of the few things Google reads that no
 * amount of good copy substitutes for.
 */
const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "VideoGame",
  name: SITE_NAME,
  alternateName: "KKT",
  description: SITE_DESCRIPTION,
  slogan: SITE_TAGLINE,
  url: siteUrl(),
  image: `${siteUrl()}/opengraph-image.png`,
  genre: ["Quiz", "Party", "Trivia"],
  gamePlatform: ["Web browser", "Mobile web"],
  playMode: "CoOp",
  numberOfPlayers: { "@type": "QuantitativeValue", minValue: 1, maxValue: 3 },
  inLanguage: ["hi-IN", "en-IN"],
  applicationCategory: "GameApplication",
  operatingSystem: "Any",
  offers: { "@type": "Offer", price: "0", priceCurrency: "INR" },
};

export const viewport: Viewport = {
  themeColor: "#0a0806",
  // Contestants hold these phones one-handed under time pressure. A stray
  // double-tap zooming the layout mid-round would be its own small disaster.
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // Browser extensions stamp their own attributes onto <html> before React
    // hydrates (crxemulator, Grammarly, and friends), which React reports as a
    // hydration mismatch we cannot fix from here. This suppresses the warning
    // for this element's own attributes only — one level deep, so a genuine
    // mismatch anywhere inside the tree still shows up.
    <html lang="en-IN" suppressHydrationWarning>
      <body className={`${display.variable} ${ui.variable} antialiased`}>
        {children}
        <script
          type="application/ld+json"
          // Serialised, not JSX children, because React would escape the
          // quotes and hand crawlers a string instead of JSON.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
        />
      </body>
    </html>
  );
}
