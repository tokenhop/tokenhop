// Audit log of security and administrative events (YAN-367).
// Append-only; instance-read, admin-only. before/after arrive as JSON strings
// (or null) — serialization and redaction live in the Lane B helper, not here.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

export async function insert(event) {
  const db = await getAdapter();
  const row = {
    id: uuidv4(),
    ts: event?.ts || new Date().toISOString(),
    actorUserId: event?.actorUserId ?? null,
    actorApiKeyId: event?.actorApiKeyId ?? null,
    via: event?.via ?? null,
    ip: event?.ip ?? null,
    workspaceId: event?.workspaceId ?? null,
    action: event?.action,
    targetType: event?.targetType ?? null,
    targetId: event?.targetId ?? null,
    before: event?.before ?? null,
    after: event?.after ?? null,
    result: event?.result ?? null,
  };
  db.run(
    `INSERT INTO auditEvents(id, ts, actorUserId, actorApiKeyId, via, ip, workspaceId, action, targetType, targetId, before, after, result) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.ts,
      row.actorUserId,
      row.actorApiKeyId,
      row.via,
      row.ip,
      row.workspaceId,
      row.action,
      row.targetType,
      row.targetId,
      row.before,
      row.after,
      row.result,
    ],
  );
  return row;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function list(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.workspaceId !== undefined && filter.workspaceId !== null) {
    conds.push("workspaceId = ?");
    params.push(filter.workspaceId);
  }
  if (filter.actorUserId !== undefined && filter.actorUserId !== null) {
    conds.push("actorUserId = ?");
    params.push(filter.actorUserId);
  }
  if (filter.action) {
    conds.push("action LIKE ? ESCAPE '\\'");
    params.push(`${escapeLike(filter.action)}%`);
  }
  if (filter.targetType) {
    conds.push("targetType = ?");
    params.push(filter.targetType);
  }
  if (filter.targetId) {
    conds.push("targetId = ?");
    params.push(filter.targetId);
  }
  if (filter.fromTs) {
    conds.push("ts >= ?");
    params.push(filter.fromTs);
  }
  if (filter.toTs) {
    conds.push("ts <= ?");
    params.push(filter.toTs);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM auditEvents ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = Math.max(1, Math.floor(filter.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(filter.pageSize) || 50));
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const events = db.all(
    `SELECT * FROM auditEvents ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return {
    events,
    pagination: { page, pageSize, totalItems, totalPages },
  };
}

export async function pruneOlderThan(days) {
  const db = await getAdapter();
  const ms = Date.now() - Number(days) * 86400000;
  // Garbage `days` (user-reachable setting) must no-op, never throw before pruning.
  if (!Number.isFinite(ms)) return 0;
  const cutoff = new Date(ms).toISOString();
  const { changes } = db.run(`DELETE FROM auditEvents WHERE ts < ?`, [cutoff]);
  return changes;
}
