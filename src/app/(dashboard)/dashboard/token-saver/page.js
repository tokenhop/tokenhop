import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components";
import TokenSaverPageClient from "./TokenSaverPageClient";

export default function TokenSaverPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <TokenSaverPageClient />
    </Suspense>
  );
}
