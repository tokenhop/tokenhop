import { getMachineId } from "@/shared/utils/machine";
import CLIToolsPageClient from "./CLIToolsPageClient";

export default async function CLIToolsPage({ searchParams }) {
  const machineId = await getMachineId();
  const params = await searchParams;
  const initialTool = params?.tool || "claude";
  return <CLIToolsPageClient machineId={machineId} initialTool={initialTool} />;
}
