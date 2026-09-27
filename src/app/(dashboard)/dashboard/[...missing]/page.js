import { notFound } from "next/navigation";

/** Unmatched dashboard URLs render the Signal not-found view inside the shell. */
export default function MissingDashboardPage() {
  notFound();
}
