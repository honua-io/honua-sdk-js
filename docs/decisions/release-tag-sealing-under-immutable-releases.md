# Release tag sealing under immutable releases

Issues [#1337](https://github.com/honua-io/honua-sdk-js/issues/1337) and
[#1350](https://github.com/honua-io/honua-sdk-js/issues/1350). Three consecutive
JS SDK releases produced GitHub Releases that never published to npm, and the
release log said only `Process completed with exit code 1`. This records what
actually happened, what the pipeline now does about it, and the disposition of
the two versions left stranded.

## What the release tag has to satisfy

`release-seal check` requires a release tag to name a commit whose derived
sample artifacts are sealed to that commit and stamp that release's version.
Release Please's version-bump commit can never satisfy that: it edits
`package.json` and the version-stamped fixtures listed in
`release-please-config.json`, all inside the evidence-neutral source digest, so
a pristine checkout of it fails `samples:verify` with a gate-receipt digest
mismatch, and the sample artifacts it carries still self-report the previous
version.

`regenerate-derived-artifacts.yml` produces a generated-only descendant that
*is* sealed. `release-please.yml` waits for that reseal and puts the `js-sdk-*`
tag on it before anything publishes. Two checks make tagging the descendant
honest: the merge base of the descendant must be the release commit, and every
changed path must be on the generated-output allowlist, so only regenerated
bytes can differ and the tag still names exactly this release's source.

## What went wrong

The three failures below had different mechanisms and one shared symptom — no
diagnostic naming the tag. A fourth version, `0.1.8-beta.0`, was stranded later
under the *new* ordering by a different mechanism and with the opposite symptom;
it is recorded in [Reseal supersession](#reseal-supersession-1532) rather than
here.

| Release | Release Please run | Mechanism |
| --- | --- | --- |
| `js-sdk-v0.1.5-beta.0` | `31732034723` | The awaited reseal run failed. `gh run watch --exit-status` aborted the step upstream of the tag move, which therefore never executed. |
| `js-sdk-v0.1.6-beta.0` | `31732155436` | Same as above: the reseal run failed and the step aborted before the tag move. |
| `js-sdk-v0.1.7-beta.0` | `31748631384` | The tag move executed and was **rejected**: `gh: Repository rule violations found / Cannot update this protected ref. (HTTP 422)`. |

The third is the structural one. Org-enforced immutable releases protect any
tag that already carries a published release, and Release Please publishes the
release on the version-bump commit. From that moment the tag cannot be moved,
so the "cut the release, then seal the tag" ordering cannot complete. This is
the same class of defect as the frozen rolling `sample-bundles-latest` release
in [#1325](https://github.com/honua-io/honua-sdk-js/issues/1325): a mutate-later
pattern invalidated retroactively by immutable releases.

Also worth recording, because it wasted diagnosis time: `git push --force
--dry-run` reported the tag move would succeed. Dry-run pushes do not evaluate
ruleset or immutability rules, so a green dry run is not evidence that a push
will land.

## What the pipeline does now

Two changes, in the order they were made. The first was loudness, because a
release step that silently does not fire is worse than one that fails. The
second was the ordering itself, because loudness only converts an unrecoverable
release into a blocked one.

### Loudness (#1349)

- The `Dispatch package publish workflows` step runs under `set -Eeuo pipefail`
  and routes every abort through a `fail()` helper that emits a
  `::error title=Release blocked for <tag>::` annotation and writes the reason
  to the job summary, with an `ERR` trap as the backstop for the aborts errexit
  would otherwise report bare. No release path can now end in a bare exit code.
- The reseal wait, the ancestry check, the generated-path allowlist and the tag
  placement each say which tag was affected and that nothing was published.
- A **post-condition** re-reads the tag and requires it to name the resealed
  commit before the publish workflows are dispatched.

### Ordering (#1350)

The tag is now cut on a commit that is *already* sealed, instead of being
sealed after the fact:

1. Release Please cuts the JS SDK release as a **draft**
   (`"draft": true` on the `"."` package in `release-please-config.json`).
   GitHub does not create a Git tag for a draft release, and immutability does
   not attach until a release is published — so at this point there is no tag
   and nothing is protected.
2. The release step dispatches the reseal and waits for its generated-only
   descendant to land on trunk, exactly as before.
3. It **creates** `refs/tags/js-sdk-<version>` on that resealed commit —
   `POST /git/refs`, never `PATCH`. Creating a tag is not something immutable
   releases restrict; moving one is.
4. It re-reads the tag (the #1349 post-condition), and only if the tag names
   the resealed commit does it publish the draft with
   `PATCH /releases/<id> -F draft=false`.
5. It re-reads the tag **again** after publication. This is not a duplicate
   check: GitHub creates the tag itself, at the release's `target_commitish` —
   the unsealed bump commit — when a draft is published while its tag does not
   exist. Publication is therefore the last operation that can still misplace a
   release.

Nothing in the path writes to an existing ref or edits a published release, so
nothing in it can be rejected by immutable releases. This is also the flow
GitHub recommends for immutable releases in its own documentation — "create
releases as drafts first, attach all assets, and then publish" — applied to the
tag's commit rather than to release assets.

The verified GitHub behaviours this depends on were checked against a real
repository before the change was written, not inferred:

| Behaviour | Observed |
| --- | --- |
| Creating a draft release for a tag that does not exist | No tag ref is created (`GET /git/ref/tags/<tag>` → 404) |
| Creating the tag afterwards, on a different commit | Accepted |
| Publishing that draft | Release binds to the existing tag; `target_commitish` is ignored and the tag still resolves to the commit we chose |
| Publishing a draft whose tag does **not** exist | GitHub creates the tag at `target_commitish` — the unsealed bump commit |
| `POST /git/refs` for an existing ref | 422 `Reference already exists`, which the step treats as an idempotent resume only when the existing tag already names the resealed commit |

One thing in that path is *not* proven: `PATCH /releases/<id> -F draft=false`
was exercised on a repository that could not have immutable releases enabled,
because the setting is exposed nowhere in the REST or GraphQL API (only the
derived `immutable` flag on a release object), and manufacturing a permanent
junk release here to test it is not reversible under immutability. Two things
make that acceptable: publishing performs no ref write at all when the tag
already exists, so there is nothing for ref protection to reject; and if it were
rejected the state is recoverable, because the tag already names the sealed
commit and the release is still a draft.

One consequence had to be handled explicitly. A draft release has no tag, and
Release Please's release iterator skips a release with no tag commit, so during
the window between the draft being cut and its tag being created there is no
previous release for Release Please to find. The reseal's own automation merge
is a trunk push inside that window, and a Release Please run there would rebuild
the next release pull request from far too much history. The `release-please`
job therefore carries a `concurrency` group with `cancel-in-progress: false`, so
such a run simply queues and executes once the tag exists.

### Failure modes

The two post-conditions are still able to fail, and the reordering is what
makes their failures cheap:

- If the tag is not on the resealed commit, the release stays a **draft**. No
  public release exists, no tag is protected, and the version can simply be
  re-cut. Under the old ordering the same condition left a published release on
  a permanently unsealable tag.
- If publishing the draft were itself rejected, the tag already names the
  sealed commit, so the release is completed by publishing the draft and
  re-dispatching `publish-js-sdk.yml` — the annotation says exactly that.
- If `"draft": true` is ever removed from the config, Release Please publishes
  on the bump commit again and the tag is frozen there. The step detects this
  from the release's own `draft` output and aborts *before* the ~40-minute
  reseal, naming the config key to restore.

`test/scripts/release-please-tag-seal.test.mjs` executes that shell against a
stubbed `gh` and asserts the whole ordering — including that the trace of
side effects is exactly reseal → create tag → publish release → publish npm —
plus every abort above. It runs in `SDK CI`, so the guards cannot be removed
without failing a check.

### Reseal supersession (#1532)

The reordering above was correct and still stranded one more version, because
waiting on *the dispatched run* is not the same as waiting on *a sealed commit*.
`regenerate-derived-artifacts.yml` serializes on concurrency group
`derived-artifacts` with `cancel-in-progress: false`, and GitHub holds at most
one run pending per group: when a third run enters, the pending one is
**cancelled**. The release commit's own push always starts a reseal, so the
reseal the release dispatches is always queued behind one, and is evicted by
whatever lands next.

That is what happened to `js-sdk-v0.1.8-beta.0` on 2026-08-26. Release Please
run [`33007925674`](https://github.com/honua-io/honua-sdk-js/actions/runs/33007925674)
(release commit `883302cc`) dispatched reseal `33008321316` at `20:02:18Z`; it
never started a single job, sat pending for 61 minutes behind the push-triggered
reseal `33007925640` of the same commit, and was cancelled at `21:03:49Z` when
the next reseal pair arrived. The release then refused to tag — correctly by its
own post-condition, and wrongly in fact, because `33007925640` had **succeeded**
and a sealed descendant did exist.

[#1532](https://github.com/honua-io/honua-sdk-js/pull/1532) makes the step follow
the supersession chain, bounded to five hops: only a `cancelled` conclusion is
retryable, every other non-success still aborts before a tag exists, and the
merge-base plus generated-only-paths checks still decide whether the resulting
tip may carry the tag. It merged on 2026-08-29, before the `0.1.9-beta.0` cut
below.

## Disposition of the stranded versions

- **`0.1.5-beta.0` and `0.1.6-beta.0`: deliberately skipped, not published.**
  Both are pre-release beta versions superseded within hours by `0.1.7-beta.0`,
  which is published. Their tags carry published GitHub Releases and therefore
  cannot be moved onto a sealed commit, and publishing them from a recovery
  branch would put bytes on npm that no tag names — the exact provenance break
  the seal exists to prevent. The GitHub Releases remain as history; the
  versions are permanently absent from npm and the version line continues from
  `0.1.7-beta.0`.
- **`0.1.7-beta.0`: published through the workflow's guarded branch-recovery
  path** from the resealed commit `2327a2a63`, because its tag was already
  frozen by the time the reseal existed.
- **`0.1.8-beta.0`: skipped, and skippable — the version line continues from
  `0.1.9-beta.0`.** Its disposition is materially better than the three above,
  which is the point of the reordering: because the tag is created *after* the
  reseal, the refusal left `js-sdk-v0.1.8-beta.0` with **no tag at all** and its
  GitHub Release still a **draft** (created `2026-08-26T19:58:03Z`, never
  published), so nothing is frozen and nothing on npm is unnamed by a tag.
  `@honua/sdk-js@0.1.8-beta.0` is absent from the registry. The version is not
  re-cut because `0.1.9-beta.0` has since taken the line forward; the draft is
  deliberately left untouched as evidence.

  One asymmetry belongs in the record: that cut was coordinated, and only the
  JS SDK half was stranded. `mcp-server-v0.1.8-beta.0` and
  `create-honua-app-v0.1.3` were published from the same run, and
  `@honua/mcp-server@0.1.8-beta.0` reached npm at `2026-08-26T20:00:08Z` with no
  `@honua/sdk-js` partner on the same tuple. The mirror-image gap exists one
  version earlier — `@honua/sdk-js@0.1.7-beta.0` is on npm while
  `@honua/mcp-server@0.1.7-beta.0` never was, despite its GitHub Release. Two
  successive half-published pairs are why the shipped zero-to-map client configs
  pinned an `@honua/mcp-server` version the registry never served
  ([#1545](https://github.com/honua-io/honua-sdk-js/issues/1545)), and why the
  pair is now cut and gated on one tuple
  ([#1529](https://github.com/honua-io/honua-sdk-js/issues/1529)).

## Residual

`0.1.5-beta.0` and `0.1.6-beta.0` remain unpublishable; their tags carry
published releases and are frozen. Nothing about the new ordering can repair a
release that was already cut under the old one — it only guarantees that the
next one is cut correctly.

The other two options considered in [#1350](https://github.com/honua-io/honua-sdk-js/issues/1350)
were rejected on merit:

- **Reseal the Release Please pull request before it merges**, so the merged
  bump commit is itself sealed. This is the only option that removes the second
  commit entirely, but it seals a *branch head*, and the seal is a property of
  the exact tree: any trunk movement between the reseal and the merge restales
  it. Release Please would then still cut and publish on that commit, so
  losing the race is unrecoverable in exactly the way this ticket is about. It
  also requires pushing non-Release-Please commits onto
  `release-please--branches--trunk`, which the disposition checks reject as not
  being exact bot automation, and which the bot's own branch regeneration would
  discard.
- **Make the bump commit self-verifiable** so no reseal is needed. This is the
  same thing as the option above — the only way to make it self-verifiable is
  to regenerate evidence inside it — with the same race, or else it requires
  removing `package.json` and the version-stamped fixtures from the
  evidence-neutral source digest, which is weakening the seal rather than
  reordering around it.

## First proven cut: `0.1.9-beta.0`

`js-sdk-v0.1.9-beta.0` is the first public release that proves the chosen
ordering against the repository's live immutable-release enforcement:

- Release Please created the draft against version-bump commit
  `640535afe475020fb11cddfb4d2261dafae07736`.
- The first regeneration run
  [stalled while merging its green automation PR](https://github.com/honua-io/honua-sdk-js/actions/runs/33272463337),
  the failure tracked by [#1541](https://github.com/honua-io/honua-sdk-js/issues/1541).
  Its re-dispatch
  [completed the reseal](https://github.com/honua-io/honua-sdk-js/actions/runs/33275381277)
  and merged generated-only PR #1539 as
  `c99e71197dd940ed952aecb024c6de273456f2ae`.
- The public `js-sdk-v0.1.9-beta.0` tag was created on that resealed commit. It
  was not moved from the version-bump commit, and publication did not use a
  recovery branch.
- The [GitHub Release](https://github.com/honua-io/honua-sdk-js/releases/tag/js-sdk-v0.1.9-beta.0)
  was published at `2026-08-29T22:49:54Z`, after the resealed commit and tag
  existed, and GitHub reports the release as immutable.
- The [package publication run](https://github.com/honua-io/honua-sdk-js/actions/runs/33279534389)
  checked out `c99e71197dd940ed952aecb024c6de273456f2ae`, passed its `Verify
  release seal` step, and published from the tag rather than a branch recovery.
- Re-verification from a pristine checkout of the tag reports
  `releaseSeal=ok`, version `0.1.9-beta.0`, all 36 gate receipts bound to source
  digest `abb3489b7f0e`, and all eight artifacts declared by
  `config/release-artifacts.v1.json` verified against their registry integrity,
  npm provenance, and publish attestations. The coordinated artifact versions
  are `0.1.9-beta.0`, except `create-honua-app@0.1.3` as declared by its own
  package manifest.

This discharges the remaining acceptance criteria in #1337. The earlier
`0.1.5-beta.0`, `0.1.6-beta.0`, `0.1.7-beta.0`, and `0.1.8-beta.0` dispositions
remain exactly as recorded above; this cut does not attempt to mutate the three
immutable releases, and does not re-cut the tagless `0.1.8-beta.0` draft.

The first-release terminal journey has separate server-feature blockers. In
particular, honua-server#3695 landed the mechanical setup-view portion of
honua-server#3428, while that issue still retains live-model qualification and
the honua-server#3431 scope-narrowing matrix. Those features govern journey
qualification, not whether this already-published SDK tag is a sealed immutable
cut, and are therefore not blockers for #1337.

The chosen ordering leaves `release-please--branches--trunk` untouched: the fix
lives in `release-please-config.json` and `release-please.yml` on trunk, both
read fresh on every run, so it survives any regeneration of the bot branch and
applies to the release pull request that is already open.
