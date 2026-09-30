# Branching and releases

These rules decide where every change goes and how versions ship. They apply to
humans and agents alike, on every task, without being restated in prompts.

The core idea: **a change's target release is decided before work starts, and the
target decides the base branch.** A release is a tag on a branch — never a set of
commits picked from somewhere else after the fact.

## Current state

The block below is read by the ycc skills (`/ycc:git-workflow`, `/ycc:releaser`,
`/ycc:backport`, …); the table is generated from it. Change both with
`release-state-update.sh` (or `/ycc:release-model`), never by hand.

<!-- ycc-release-state
model: release-branches
trunk: master
maintenance: release/0.5
support: latest-minor
backport_label: backport:{X.Y}
tracker: linear-labels
tracker_ref: tokenhop release
-->

<!-- ycc-release-state:table:begin -->

Model: **release-branches**. Support window: latest-minor.

| Role        | Branch        | Notes                       |
| ----------- | ------------- | --------------------------- |
| Trunk       | `master`      | Next minor or major release |
| Maintenance | `release/0.5` | Patches via `backport:0.5`  |

<!-- ycc-release-state:table:end -->

`master` has been the trunk since v0.5.0 (2026-09-30). Planned releases, both from
`master`:

- **v0.6.0** — new features.
- **v1.0.0** — the tokenhop rebrand, on `master` behind the brand switch.

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

Two switches are planned for the large projects: the **brand switch** (the
tokenhop rebrand; defaults to `9router` until the v1.0.0 release PR flips it)
and the **Users & teams switch** (defaults to off). CI builds both states of
each, so the hidden side stays green. The project handbooks list which issues
ship anytime, which go behind the switch, and which wait for release day.

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
   discretion) with `release-state-update.sh --add-maintenance release/X.Y`, which also
   re-renders [Current state](#current-state).

Pre-releases of the next minor are tagged `vX.Y.0-beta.N` from the trunk.

### Patch release (vX.Y.Z) — from `release/X.Y`

0. **No pending backports.** Every trunk PR with the `backport:X.Y` label must
   already have a merged `release/X.Y` backport PR. Check before tagging:

   ```bash
   gh pr list --state merged --label backport:X.Y --limit 100
   # each PR in that list needs a matching merged PR whose body says "Backport of #N"
   ```

   If any are missing, backport them first (`/backport --pending`) or decide
   they wait for the next patch. Never tag around a labeled-but-unbackported
   fix — that is how v0.5.2 shipped without #386.

1. On `release/X.Y`, commit `chore(release): vX.Y.Z` (CHANGELOG.md, root and
   `cli/` versions).
2. Push an annotated tag `vX.Y.Z`; wait for the image on GHCR.
3. `gh release create vX.Y.Z --verify-tag` with the notes.
4. Carry the CHANGELOG entry (not the version bump) to the trunk in a
   `chore(release): record vX.Y.Z in changelog` PR, so the trunk's CHANGELOG
   stays complete.

Only the latest minor gets patch releases.

## Cut-over: `re-design` → `master` (done)

Completed with v0.5.0 on 2026-09-30 (#370, #372). `master` is the trunk, and
`release/0.5` is the maintenance branch. The redesign landed on `master` as a
single squash commit; its individual commits are kept under the
`archive/re-design` tag.

## Planning (Linear)

- **Projects** are bodies of work (Re-design, Rebrand, Users & Teams). Each
  project has a target release.
- **Every issue gets a target release at triage**, as a label from the
  single-select **tokenhop release** label group: the patch line (`v0.5.x`),
  the next minor (`v0.6.0`) or a planned major (`v1.0.0`). Add a label to the
  group when a new version is planned. For bugs, triage also decides whether
  the fix needs a backport. (Linear's Releases feature needs a Business plan,
  so labels stand in for it.)
- Agents take issues by target. The target tells them the base branch and
  whether to add `backport:X.Y`; nobody sorts commits into releases afterwards.
