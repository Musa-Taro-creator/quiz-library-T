# Local reliability/security checks

These tests never connect to production. Browser tests block outside requests or
use a loopback-only server and simulated authentication/RPCs. SQL tests use
disposable local databases, not a Supabase connection string. No real student
records, credentials, or deliberately interrupted live saves are used.

## Requirements

Tested with Node 24, Python 3, system Chromium at `/usr/bin/chromium`, Playwright
1.62.0, PGlite 0.5.10, embedded-postgres 17.10.0-beta.17 (PostgreSQL 17.10), and
pg 8.23.1. Quiz fixtures now use the UUID item/library keys, foreign keys,
account deletion behavior and table defaults shown in the user-supplied schema.
The deployed external quiz-share function is reproduced verbatim in a local test
fixture, including its TABLE return. Install test engines outside the checkout:

```sh
npm install --prefix /tmp/ql-reliability-deps --no-audit --no-fund @electric-sql/pglite@0.5.10 embedded-postgres@17.10.0-beta.17 pg@8.23.1
python -m pip install --target /tmp/ql-reliability-python playwright==1.62.0
```

From the repository root:

```sh
QL_PGLITE_MODULE=/tmp/ql-reliability-deps/node_modules/@electric-sql/pglite/dist/index.js QL_EMBEDDED_POSTGRES_MODULE=/tmp/ql-reliability-deps/node_modules/embedded-postgres/dist/index.js QL_PG_MODULE=/tmp/ql-reliability-deps/node_modules/pg/lib/index.js node --test tests/*.test.cjs tests/*.test.mjs

export PYTHONPATH=/tmp/ql-reliability-python
export PYTHONDONTWRITEBYTECODE=1
python tests/bulk-preview-scroll.test.py
python tests/editor-persistence.browser.py
python tests/admin-message-drafts.browser.py
python tests/pdf-viewer.browser.py
python tests/offline-upgrade.browser.py
python tests/dashboard-posting.browser.py
python tests/dashboard-appearance.browser.py
```

For the additional supported text-ID schema compatibility check:

```sh
QL_TEST_ITEM_IDS=text QL_PGLITE_MODULE=/tmp/ql-reliability-deps/node_modules/@electric-sql/pglite/dist/index.js node --test tests/quiz-save-v2.test.mjs
```

The native concurrency suite starts its own PostgreSQL server bound only to
127.0.0.1 on a dynamically assigned port and removes its own temporary cluster.
It does not read PG* environment variables or accept a remote database URL.

## Coverage and limitations

- Quiz saves: 0–10,000 questions, missing/changed batches, duplicate IDs,
  settings-only edits, transactional failures, concurrent finalizers, interrupted
  transactions, consistent pagination, retries, account isolation and deletion.
- Editor: edits during saving, confirmation conflicts with another tab, settings
  persistence, and isolation of account-specific drafts. Bug #1's grading
  functions are compared verbatim with the published baseline and exercised with
  124 True/False, MCQ, multiple-answer and short-answer assertions.
- Import: original nonsequential option letters, answer keys, and deep preview
  scroll/focus on desktop, phone and tablet-sized Chromium viewports.
- Admin: nine sections render with simulated RPCs; text/photo drafts survive
  refresh and conversation changes; failed/pending replies preserve new edits.
- PDF: matching real 6.4.299 library/worker, three-page rendering, navigation by
  scrolling, zoom, text extraction, cancellation, native fallback and cleanup.
  Upgrade tests cover failed downloads, integrity errors, interruption, quota
  errors, successful retries, cold offline resources and unrelated storage.
- Dashboard: a folder with 24 subfolders, 12 quizzes and 14 PDFs, Unicode/chunked
  uploads, failures at preparation/upload/finalization, duplicate retries, feature
  restrictions, ownership, and folder appearance when saving shared content.

Mock authentication does not validate real Google login, payments, email or
Supabase deployment configuration. PGlite/stock PostgreSQL fixtures cannot prove
compatibility with unknown deployed functions, policies, constraints or triggers.
Physical Safari/iPad, low-memory devices, unusual encrypted/scanned PDFs and live
network behavior require additional validation. Tablet viewport tests are not
Safari tests. Large imports still construct the initial preview; per-answer
refresh now replaces one card, but very large lists can still feel slow.

## Database and release prerequisites — not yet performed

1. Both user-supplied schema exports have been reviewed. Local tests reproduce
   the UUID item/library keys, foreign keys, defaults, grants, existing limit
   trigger, exact external-share TABLE-returning function, and shared-link table
   columns/checks/unique indexes. The existing item-limit trigger is verified
   unchanged after migration. The full run passes 101 Node/SQL tests, plus browser
   tests and a separate text-ID compatibility run. These are schema-compatible
   local simulations, not an independent Supabase staging deployment. The exact
   live timeout was not reproduced against production; live rollout validation
   remains necessary. The Dashboard migration adds an owner/date index for the
   existing daily post limit without altering that limit.
2. Back up the database and validate both candidate migrations against an
   isolated copy of the actual schema. Apply
   `student_quiz_atomic_save_v2.sql`, then `dashboard_reliable_posting_v2.sql` in
   a coordinated release window. Each file is transactional. The combined
   `reliability_release_v2.sql` runs both in one transaction and is the preferred
   single-paste release script; do not run both forms. Do not execute an
   unfinished earlier Bug #2 staging migration from another worktree.
3. The quiz migration blocks old direct question writes and the unsafe replace
   RPC, and withdraws client TRUNCATE permissions (present in the supplied
   schema) because TRUNCATE bypasses RLS and revision triggers. Normal item
   read/insert/update/delete permissions remain. Existing cached editors must
   save/export drafts before the release and
   refresh afterward. Deploy the matching frontend promptly after SQL succeeds;
   deploying the frontend first makes the new RPCs unavailable. A frontend-only
   rollback to unsafe old writers is not a compatible rollback plan.
4. Legacy drafts with no account identity are retained unchanged but not restored
   automatically. They need owner-reviewed recovery; assigning them to whichever
   account signs in would reintroduce the privacy bug. Conflict recovery offers
   downloading a draft or saving a separate new quiz instead of overwriting the
   server version.
5. Current staging limits are 8 unfinished saves/posts per account, 100,000
   questions per quiz save, 8 MiB per quiz batch/settings request, 64 MiB staged
   data per account, 32 MiB per Dashboard quiz preparation, and 24-hour retry
   receipts. Expired sessions are deleted in bounded batches during activity;
   no scheduled job is installed. Observe usage before choosing a scheduled
   cleanup or changing limits.
6. The service-worker upgrade preserves saved PDFs, quizzes and unrelated
   storage. It activates only a complete app generation. An old worker already
   running on a disconnected device cannot be remotely replaced until the user
   reconnects and a complete update succeeds; already-executed old PDF.js code
   cannot be retroactively unloaded. After activation, vulnerable old PDF.js
   downloads are blocked and known old application caches are retired.
7. Verify the live frontend build, worker generation, matching PDF versions,
   account-scoped quiz reads and representative user-approved smoke actions.
   Failure injection stays local. A successful Git push alone is not evidence
   of a successful Pages deployment or working database RPCs.

Production SQL execution and website publication are separate from preparing
this release branch. Neither has been performed as part of these local tests.
