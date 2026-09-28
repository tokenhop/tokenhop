import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components";
import CombosPageClient from "./CombosPageClient";

export const metadata = { title: "Combos" };

export default function CombosPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-4" role="status" aria-label="Loading combos">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      }
    >
      <CombosPageClient />
    </Suspense>
  );
}
