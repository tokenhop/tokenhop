import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import { getMachineId } from "@/shared/utils/machine";
import EndpointPageClient from "./EndpointPageClient";

export default async function EndpointPage() {
  const machineId = await getMachineId();
  return (
    <Suspense fallback={<CardSkeleton />}>
      <EndpointPageClient machineId={machineId} />
    </Suspense>
  );
}
