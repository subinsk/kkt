import type { Metadata, Viewport } from "next";
import { Archivo, Barlow_Condensed } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Kaun Katega Taarpati",
  description: "Paanch taar. Chhe minute. Lock kiya jaye?",
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
    <html lang="en-IN">
      <body className={`${display.variable} ${ui.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
