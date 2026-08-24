import type { Metadata } from "next";
import StageView from "@/components/stage-view";

/**
 * Room codes are minted per show and the rooms live in memory, so an indexed
 * URL here is a dead link within minutes — and, while it is alive, an open seat
 * for a stranger. `app/robots.ts` disallows the path as well; this is the half
 * that survives someone linking straight to it.
 */
export const metadata: Metadata = {
  title: "Projector",
  robots: { index: false, follow: false, nocache: true },
};

/** The projector. Everything real happens client-side — WebGL and WebRTC both. */
export default async function StagePage(props: PageProps<"/stage/[code]">) {
  const { code } = await props.params;
  return <StageView code={code.toUpperCase()} />;
}
