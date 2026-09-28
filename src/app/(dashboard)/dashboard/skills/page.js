import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import SkillsPageClient from "./SkillsPageClient";

/**
 * Skills page shell: suspense boundary around the client page.
 * @returns {React.JSX.Element} The skills page.
 */
export default function SkillsPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <SkillsPageClient />
    </Suspense>
  );
}
