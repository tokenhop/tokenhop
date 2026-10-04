// YAN-363: explicit migration seam. No driver/barrel import or request-time DDL.
// Call initGatewayVideoJobsSync(db) inside the hashed-key activation transaction.
export const GATEWAY_VIDEO_JOBS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS gatewayVideoJobs (
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  jobId TEXT NOT NULL,
  provider TEXT NOT NULL,
  connectionId TEXT NOT NULL,
  modelId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, provider, jobId)
)`;

export function initGatewayVideoJobsSync(db) {
  db.exec(GATEWAY_VIDEO_JOBS_TABLE_SQL);
}

// Fail before a billable submission when activation omitted the job table.
export function requireGatewayVideoJobsSync(db) {
  const table = db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gatewayVideoJobs'",
  );
  if (!table) {
    const err = new Error("Gateway video job store not installed");
    err.code = "GATEWAY_VIDEO_JOBS_MISSING";
    throw err;
  }
}

export function getGatewayVideoJobsSync(db, workspaceId, jobId) {
  return db.all("SELECT * FROM gatewayVideoJobs WHERE workspaceId = ? AND jobId = ?", [
    workspaceId,
    jobId,
  ]);
}

// Trusted provenance only: accepted upstream creation, or owner-confirmed
// backfill by an internal caller. Never call with HTTP poll/body assertions.
// Immutable mapping: a reused upstream id cannot silently change authority.
export function recordGatewayVideoJobSync(db, row) {
  for (const field of ["workspaceId", "jobId", "provider", "connectionId", "modelId"]) {
    if (typeof row?.[field] !== "string" || !row[field] || row[field].length > 2048) {
      throw new Error(`Invalid video job ${field}`);
    }
  }
  if (!row.modelId.startsWith(`${row.provider}/`) || row.modelId === `${row.provider}/`) {
    throw new Error("Invalid video job canonical model");
  }
  db.transaction(() => {
    const previous = db.get(
      "SELECT * FROM gatewayVideoJobs WHERE workspaceId = ? AND provider = ? AND jobId = ?",
      [row.workspaceId, row.provider, row.jobId],
    );
    if (previous) {
      if (previous.connectionId !== row.connectionId || previous.modelId !== row.modelId) {
        throw new Error("Conflicting video job provenance");
      }
      return;
    }
    db.run(
      `INSERT INTO gatewayVideoJobs(workspaceId, jobId, provider, connectionId, modelId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        row.workspaceId,
        row.jobId,
        row.provider,
        row.connectionId,
        row.modelId,
        new Date().toISOString(),
      ],
    );
  });
}
