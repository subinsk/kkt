import HostConsole from "@/components/host-console";

/** The hidden panel. Insurance for when something misfires in front of judges. */
export default async function HostPage(props: PageProps<"/host/[code]">) {
  const { code } = await props.params;
  return <HostConsole code={code.toUpperCase()} />;
}
