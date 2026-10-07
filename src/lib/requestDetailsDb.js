// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  saveRequestDetailUnscoped,
  getRequestDetails,
  getRequestDetailById,
  getDistinctProviders,
} from "@/lib/db/index.js";
