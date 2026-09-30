# Branching and releases

These rules decide where every change goes and how versions ship. They apply to
humans and agents alike, on every task, without being restated in prompts.

The core idea: **a change's target release is decided before work starts, and the
target decides the base branch.** A release is a tag on a branch — never a set of
commits picked from somewhere else after the fact.

## Current state

Keep this table up to date; it is the only part of this file that changes often.

| Role                        | Branch            | Notes                                                   |
| --------------------------- | ----------------- | ------------------------------------------------------- |
| Trunk (next release)        | `re-design`       | Until v0.5.0 ships. Becomes `master` after the cut-over |
| Maintenance (shipped minor) | —                 | 0.4.x ships from `re-design`; no separate branch        |
| Frozen                      | `master`          | Only the final `re-design` merge and process changes    |
| Next minor after that       | `master` → v0.6.0 | Rebrand and new features                                |

Dependabot targets `re-design` while `master` is frozen (`target-branch` in
`.github/dependabot.yml`), so nothing lands on `master` that would need syncing.

## Rules

1. **Know the target before you branch.** Every issue carries a target release
   (see [Planning](#planning-linear)). No target: a bug in a shipped version is
   a patch; everything else goes to the next minor.
2. **Branch off the trunk and PR back into it.** Topic branches are short-lived
   (days, not weeks) and named `<area-or-type>/<issue-id>-<slug>`, e.g.
   `fix/yan-512-quota-card`. If one falls behind, rebase it.
3. **Never "sync" one long-lived branch into another.** No `sync master into …`
   PRs, and no merging `release/X.Y` into the trunk or the other way round. Code
   moves between them only by cherry-pick (backport).
4. **Fix on the trunk first, then backport.** A fix that must reach the shipped
   minor lands on the trunk, gets the `backport:X.Y` label, and is cherry-picked
   to `release/X.Y` in its own PR. Only when the trunk has already rewritten the
   broken code does the fix go straight to `release/X.Y`; say so in the PR.
5. **No new long-lived branches.** Large work (rebrand, users & teams) lands on
   the trunk in small PRs. See [Unfinished work](#unfinished-work).
6. **The trunk is always releasable.** CI green, and nothing half-built reachable
   by users.
7. **Only maintainers cut releases**, following [Releasing](#releasing). Agents
   never tag, and never tag from a topic branch.

## Where does my change go?

| Change                                    | Target     | PR into       | Backport            |
| ----------------------------------------- | ---------- | ------------- | ------------------- |
| Bug users hit in the shipped version      | Patch      | Trunk         | Yes, `backport:X.Y` |
| Security fix                              | Patch      | Trunk         | Yes, `backport:X.Y` |
| Bug only in unreleased trunk code         | Next minor | Trunk         | No                  |
| Feature, refactor, perf, docs, tests      | Next minor | Trunk         | No                  |
| Bug in code the trunk has since rewritten | Patch      | `release/X.Y` | n/a — explain in PR |
| Dependency bump (Dependabot)              | Next minor | Trunk         | Only security bumps |

## Unfinished work

Big features merge incrementally instead of living on a side branch. Anything a
user could reach before it is finished stays hidden: behind a setting or env var
that defaults to off, or simply not wired into navigation/routes until the last
PR. When a change cannot be hidden (a rename, a data-dir move), prepare
everything behind the scenes first and make the switch in one final PR shortly
before the release.

## Backporting

After the trunk PR is squash-merged:

```bash
git fetch origin
git switch -c backport/X.Y/<slug> origin/release/X.Y
git cherry-pick -x <squash-commit-sha-on-trunk>
```

Open the PR into `release/X.Y` with the original title, `Backport of #N` in the
body, and squash-merge it. Resolve conflicts minimally; if the fix needs real
rework for the older code, write it as its own PR against `release/X.Y`.

## Releasing

The Docker workflow (`docker-publish.yml`) runs on every `v*` tag and only moves
`:latest` when the tag is the highest stable version, so tagging an older patch
line is safe. It also publishes floating `:X.Y` tags.

### Minor release (vX.Y.0) — from the trunk

1. On the trunk, commit `chore(release): vX.Y.0`: CHANGELOG.md entry plus the
   root and `cli/` package.json versions.
2. Push an annotated tag `vX.Y.0`; wait for the image on GHCR.
3. `gh release create vX.Y.0 --verify-tag` with the notes.
4. Create the maintenance branch and its backport label:

   ```bash
   git push origin vX.Y.0^{commit}:refs/heads/release/X.Y
   gh label create "backport:X.Y" --color "fbca04" --description "Cherry-pick to release/X.Y"
   ```

5. Freeze the previous `release/X.(Y-1)` (security fixes only, at maintainer
   discretion) and update [Current state](#current-state).

Pre-releases of the next minor are tagged `vX.Y.0-beta.N` from the trunk.

### Patch release (vX.Y.Z) — from `release/X.Y`

1. On `release/X.Y`, commit `chore(release): vX.Y.Z` (CHANGELOG.md, root and
   `cli/` versions).
2. Push an annotated tag `vX.Y.Z`; wait for the image on GHCR.
3. `gh release create vX.Y.Z --verify-tag` with the notes.
4. Carry the CHANGELOG entry (not the version bump) to the trunk in a
   `chore(release): record vX.Y.Z in changelog` PR, so the trunk's CHANGELOG
   stays complete.

Only the latest minor gets patch releases.

## Cut-over: `re-design` → `master` at v0.5.0 (one time)

1. Finish the re-design work on `re-design`. `master` stays frozen, so no sync
   is needed.
2. Merge `re-design` into `master` with a **merge commit** (never squash — that
   would flatten 100+ commits of history).
3. Release v0.5.0 from `master` as a [minor release](#minor-release-vxy0--from-the-trunk),
   which also creates `release/0.5` and `backport:0.5`.
4. Remove `target-branch` from `.github/dependabot.yml`.
5. Update [Current state](#current-state): trunk = `master`, maintenance =
   `release/0.5`. Rebase any open `redesign/*` branches onto `master`, then
   delete `re-design`.

## Planning (Linear)

- **Projects** are bodies of work (Re-design, Rebrand, Users & Teams). Each
  project has a target release.
- **Every issue gets a target release at triage**: the patch line (`v0.5.x`) or
  the next minor (`v0.6.0`), as a Linear release or milestone. For bugs, triage
  also decides whether the fix needs a backport.
- Agents take issues by target. The target tells them the base branch and
  whether to add `backport:X.Y`; nobody sorts commits into releases afterwards.
