import { redirect } from "next/navigation";
import { VISIBLE_MEDIA_KINDS } from "@/shared/constants/navigation";

/**
 * Minimal media providers root (YAN-279 shell).
 * Redirects to the first visible kind (embedding).
 * YAN-305 will redesign this page with kind tabs content.
 */
export default function MediaProvidersPage() {
  redirect(`/dashboard/media-providers/${VISIBLE_MEDIA_KINDS[0]}`);
}
