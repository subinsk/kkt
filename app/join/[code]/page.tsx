import PhoneConsole from "@/components/phone-console";

/**
 * What a QR code points at. Everything real happens in the client component —
 * this exists to unwrap the route param.
 */
export default async function JoinPage(props: PageProps<"/join/[code]">) {
  const { code } = await props.params;
  return <PhoneConsole code={code.toUpperCase()} />;
}
