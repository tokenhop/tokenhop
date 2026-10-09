import { expect, it } from "vitest";
import { appendUsageFilters } from "@/app/(dashboard)/dashboard/usage/lib/filterParams";

it("keeps unscoped URLs unchanged and encodes identity filters", () => {
  expect(appendUsageFilters("/api/usage/stats", null)).toBe("/api/usage/stats");
  expect(appendUsageFilters("/api/usage/stats?period=24h", {})).toBe("/api/usage/stats?period=24h");
  expect(
    appendUsageFilters("/api/usage/stats?period=24h", {
      workspaceId: "w 1",
      view: "me",
      apiKeyId: "k+1",
      userId: "",
    }),
  ).toBe("/api/usage/stats?period=24h&workspaceId=w+1&view=me&apiKeyId=k%2B1");
});
