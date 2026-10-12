import { notFound } from "next/navigation";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch";
import InviteClient from "./InviteClient";

export const dynamic = "force-dynamic";

export default async function InvitePage() {
  if (!(await isMultiUserEnabled())) notFound();
  return <InviteClient />;
}
