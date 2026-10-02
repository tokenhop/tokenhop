# Review: YAN-638 single-model card settings

Local review of `feat/yan-638-single-model-card-settings` before the PR.

| ID  | Severity | File                                                                | Finding                                                                                                                                                | Status                                               |
| --- | -------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| F1  | MEDIUM   | `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js` | The saved endpoint is the resolved URL, so a changed tunnel/Tailscale URL keeps the old one until re-picked. Same trade-off as the Claude card (#543). | Fixed (documented with `ponytail:`; follow-up filed) |
| F2  | LOW      | `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js` | A deleted saved key falls back to the first key silently. Same as Claude.                                                                              | Accepted                                             |
| F3  | LOW      | `JcodeToolCard.js`, `DeepSeekTuiToolCard.js`                        | Apply is enabled at once because the default model is prefilled. Intended (issue asks for `tool.defaultModels` as the starting value).                 | Accepted                                             |
| F4  | LOW      | `useSetupSettings`                                                  | No direct test for the raw-key and mount-endpoint rules.                                                                                               | Fixed (`tests/unit/cli-setup-settings.test.js`)      |

No CRITICAL or HIGH findings.
