import { DEFAULT_MAX_KEPT_BYTES } from "@/shared/utils/snapshotJsonSplitter.js";

// Largest single section row (serialized) a snapshot may carry. Shared by the
// export writer (EXPORT_ROW_TOO_LARGE) and the stream importer (splitter
// element cap) so every file this build writes can be read back. Matches what
// the whole-document import accepted before (64 MiB).
export const MAX_SNAPSHOT_ROW_BYTES = DEFAULT_MAX_KEPT_BYTES;
