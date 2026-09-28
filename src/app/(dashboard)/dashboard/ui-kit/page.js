import { notFound } from "next/navigation";
import KitClient from "./KitClient";

/** Dev-only Signal kit page. Hidden in production and never linked in nav. */
export default function UiKitPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <KitClient />;
}
