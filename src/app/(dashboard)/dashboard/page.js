import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components";
import HomePageClient from "./home/HomePageClient";

export default function DashboardPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <HomePageClient />
    </Suspense>
  );
}
