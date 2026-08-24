import type { Metadata } from "next";
import PhoneConsole from "@/components/phone-console";

/**
 * Room codes are minted per show and the rooms live in memory, so an indexed
 * URL here is a dead link within minutes — and, while it is alive, an open seat
 * for a stranger. `app/robots.ts` disallows the path as well; this is the half
 * that survives someone linking straight to it.
 */
export const metadata: Metadata = {
  title: "Join the show",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * What a QR code points at. Everything real happens in the client component —
 * this exists to unwrap the route param.
 */
export default async function JoinPage(props: PageProps<"/join/[code]">) {
  const { code } = await props.params;
  return <PhoneConsole code={code.toUpperCase()} />;
}
