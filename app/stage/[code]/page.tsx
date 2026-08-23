import StageView from "@/components/stage-view";

/** The projector. Everything real happens client-side — WebGL and WebRTC both. */
export default async function StagePage(props: PageProps<"/stage/[code]">) {
  const { code } = await props.params;
  return <StageView code={code.toUpperCase()} />;
}
