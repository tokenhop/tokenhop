import Button from "@/shared/components/Button";
import EmptyState from "@/shared/components/EmptyState";

/** Dashboard route fallback with a clear way back home. */
export default function DashboardNotFound() {
  return (
    <section className="rounded-[20px] border border-line bg-panel shadow-card">
      <EmptyState
        as="h1"
        icon="search_off"
        title="Page not found"
        body="This dashboard page doesn't exist. Go home or press ⌘K to find a page."
        action={
          <Button href="/dashboard" variant="secondary" iconRight="arrow_forward">
            Back home
          </Button>
        }
      />
    </section>
  );
}
