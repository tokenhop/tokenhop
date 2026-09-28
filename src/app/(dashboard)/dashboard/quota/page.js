import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import QuotaPageClient from "./QuotaPageClient";

export default function QuotaPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <QuotaPageClient />
    </Suspense>
  );
}
