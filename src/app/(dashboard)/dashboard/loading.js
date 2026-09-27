import { CardSkeleton, SkeletonText } from "@/shared/components/Loading";

/** Dashboard navigation skeleton while route content streams in. */
export default function DashboardLoading() {
  return (
    <div role="status" aria-label="Loading dashboard" className="flex flex-col gap-6">
      <SkeletonText lines={2} />
      <div className="grid gap-4 md:grid-cols-3">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    </div>
  );
}
