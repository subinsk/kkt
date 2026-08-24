import type { Metadata } from "next";
import HostConsole from "@/components/host-console";

/**
 * Room codes are minted per show and the rooms live in memory, so an indexed
 * URL here is a dead link within minutes — and, while it is alive, an open seat
 * for a stranger. `app/robots.ts` disallows the path as well; this is the half
 * that survives someone linking straight to it.
 */
export const metadata: Metadata = {
  title: "Host console",
  robots: { index: false, follow: false, nocache: true },
};

/** The hidden panel. Insurance for when something misfires in front of judges. */
export default async function HostPage(props: PageProps<"/host/[code]">) {
  const { code } = await props.params;
  return <HostConsole code={code.toUpperCase()} />;
}
