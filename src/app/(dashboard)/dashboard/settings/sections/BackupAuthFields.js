"use client";

import PropTypes from "prop-types";
import Input from "@/shared/components/Input";

export const blankAuth = { password: "", passphrase: "", confirm: "" };

/** Shared password + passphrase fields for every dialog in the backup UI. */
export default function AuthFields({ auth, setAuth, mode, requiredPassphrase = false }) {
  const workspace = mode === "workspaceExport" || mode === "workspaceImport";
  const passphraseRequired = workspace || requiredPassphrase;
  const showConfirm = mode === "workspaceExport" || (mode === "export" && Boolean(auth.passphrase));
  return (
    <div className="space-y-4">
      <Input
        label="Your password"
        type="password"
        autoComplete="current-password"
        required
        value={auth.password}
        onChange={(e) => setAuth((s) => ({ ...s, password: e.target.value }))}
        placeholder="Current password"
        hint={
          mode === "import"
            ? "Re-confirms it is really you before anything is replaced."
            : "Re-confirms it is really you. Users without a password (SSO-only) cannot use backup."
        }
      />
      <Input
        label={passphraseRequired ? "Backup passphrase (required)" : "Backup passphrase (optional)"}
        type="password"
        autoComplete={
          mode?.includes("Import") || mode === "import" ? "current-password" : "new-password"
        }
        required={passphraseRequired}
        value={auth.passphrase}
        onChange={(e) => setAuth((s) => ({ ...s, passphrase: e.target.value }))}
        placeholder="Portable across instances"
        hint={
          passphraseRequired
            ? "Required. Use the passphrase chosen when this backup was created."
            : "With a passphrase, the file restores on a different instance. Without one, it only restores where the same master key already exists."
        }
      />
      {showConfirm && (
        <Input
          label="Repeat passphrase"
          type="password"
          autoComplete="new-password"
          value={auth.confirm}
          onChange={(e) => setAuth((s) => ({ ...s, confirm: e.target.value }))}
          placeholder="Repeat passphrase"
          error={auth.confirm && auth.passphrase !== auth.confirm ? "Entries do not match." : ""}
        />
      )}
    </div>
  );
}

AuthFields.propTypes = {
  auth: PropTypes.shape({
    password: PropTypes.string,
    passphrase: PropTypes.string,
    confirm: PropTypes.string,
  }).isRequired,
  setAuth: PropTypes.func.isRequired,
  mode: PropTypes.oneOf(["export", "import", "workspaceExport", "workspaceImport"]),
  requiredPassphrase: PropTypes.bool,
};
