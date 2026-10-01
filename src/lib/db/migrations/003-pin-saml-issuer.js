// Existing installs received the issuer through mergeWithDefaults; changing that
// default without pinning it would silently break their IdP trust.
import { LEGACY } from "@/shared/brand";

export default {
  version: 3,
  name: "pin-saml-issuer",
  up(db) {
    const row = db.get("SELECT data FROM settings WHERE id = 1");
    if (!row) return;
    let data;
    try {
      data = JSON.parse(row.data);
    } catch {
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    if (typeof data.samlIssuer === "string" && data.samlIssuer.trim()) return;
    db.run("UPDATE settings SET data = ? WHERE id = 1", [
      JSON.stringify({ ...data, samlIssuer: LEGACY.samlIssuerDefault }),
    ]);
  },
};
