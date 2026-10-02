import { ACTIVE } from "@/shared/brand";

export default function manifest() {
  return {
    name: `${ACTIVE.name} - AI infrastructure management`,
    short_name: ACTIVE.name,
    description:
      "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    orientation: "portrait-primary",
    icons: [
      {
        src: ACTIVE.appIcon192,
        sizes: "192x192",
        type: "image/svg+xml",
      },
      {
        src: ACTIVE.appIcon512,
        sizes: "512x512",
        type: "image/svg+xml",
      },
      {
        src: ACTIVE.appIcon512,
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
