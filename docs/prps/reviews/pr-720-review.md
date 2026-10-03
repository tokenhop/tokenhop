# Review: PR #720 (YAN-623 guide tools)

Verdict: approve after fixes. 0 critical, 0 high.

| ID  | Severity | Finding                                                                                            | Status                                      |
| --- | -------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| F1  | MEDIUM   | `hasExternalUrl` counted Tunnel/Cloud as enabled even without a URL, unlike `buildEndpointOptions` | Fixed                                       |
| F2  | LOW      | Continue YAML values were unquoted after substitution                                              | Fixed                                       |
| F3  | LOW      | Copy-tone allowlist entry drift                                                                    | Not a bug: the stale-entry test passes      |
| F4  | LOW      | Locale files still hold the removed Amp strings                                                    | Deferred to the next i18n pass (no CI gate) |
