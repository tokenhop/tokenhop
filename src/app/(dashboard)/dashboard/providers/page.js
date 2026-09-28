import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components";
import ProvidersListShell from "./ProvidersListShell";

export const metadata = { title: "Providers" };

export default async function ProvidersPage({ searchParams }) {
  const params = (await searchParams) || {};
  const initialProviderId =
    typeof params.provider === "string" && params.provider ? params.provider : null;
  return (
    <Suspense
      fallback={
        <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      }
    >
      <ProvidersListShell initialProviderId={initialProviderId} />
    </Suspense>
  );
}
