// Typed errors for the identity and tenancy repos (YAN-353). Callers branch on
// `code`, never on SQLite's message text.
export class TenancyError extends Error {
  /**
   * @param {"INVALID"|"NOT_FOUND"|"EMAIL_TAKEN"|"USERNAME_TAKEN"|"IDENTITY_TAKEN"|"MEMBERSHIP_EXISTS"|"OWNER_EXISTS"|"OWNER_IMMUTABLE"|"LAST_MANAGER"|"PERSONAL_WORKSPACE"|"SINGLE_USER_MODE"|"PREFIX_TAKEN"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "TenancyError";
    this.code = code;
  }
}

// "UNIQUE constraint failed: <table>.<col>[, ...]" reads the same on every driver.
const UNIQUE_CODES = [
  ["users.email", "EMAIL_TAKEN", "Email is already in use"],
  ["users.username", "USERNAME_TAKEN", "Username is already in use"],
  ["users.instanceRole", "OWNER_EXISTS", "The instance already has an owner"],
  ["identities.provider", "IDENTITY_TAKEN", "Identity is already linked to a user"],
  ["memberships.workspaceId", "MEMBERSHIP_EXISTS", "User is already a member"],
  ["workspaces.createdBy", "PERSONAL_WORKSPACE", "User already has a personal workspace"],
  [
    "connectionGrants.connectionId",
    "GRANT_EXISTS",
    "An active grant already exists for this grantee",
  ],
];

/** Run `fn`, turning SQLite UNIQUE/CHECK failures into TenancyError. */
export function mapConstraintErrors(fn) {
  try {
    return fn();
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("UNIQUE constraint failed")) {
      const hit = UNIQUE_CODES.find(([col]) => msg.includes(col));
      if (hit) throw new TenancyError(hit[1], hit[2]);
    }
    if (msg.includes("FOREIGN KEY constraint failed")) {
      throw new TenancyError("NOT_FOUND", "Referenced user or workspace not found");
    }
    if (msg.includes("CHECK constraint failed") || msg.includes("NOT NULL constraint failed")) {
      throw new TenancyError("INVALID", "Invalid value");
    }
    throw err;
  }
}

/** Scoped repo functions need a principal with a userId. */
export function assertCtx(ctx) {
  if (!ctx || typeof ctx.userId !== "string" || !ctx.userId) {
    throw new TenancyError("INVALID", "A principal (ctx) with userId is required");
  }
}
