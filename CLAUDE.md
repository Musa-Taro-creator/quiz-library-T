# CLAUDE.md — Quiz Library

A static website with no build step, published by GitHub Pages from `main`:
https://musa-taro-creator.github.io/quiz-library-T/ . The backend is the Supabase
project **musa-taro** (`hcultemyohiljypthtyb`). `README.md` and `tests/README.md` have
the full details. This file is the short version.

## Rules
- **Never change plan prices.** The Max plan is $1000 with a 33% sale on purpose. Do not
  "fix" prices or sales in SQL, `admin.html` or `index.html`.
- Every release of the student app changes the version name in **both**
  `index.html` (`<meta name="ql-shell-generation">`, line ~20) and `sw.js`
  (`APP_CACHE` + `SHELL_GENERATION`). Use the form `reliability-YYYY-MM-DD-vN`.
  The version in the repo on 2026-11-11 is `reliability-2026-11-11-v10` (not live until merged to main; v9 is live).
- CDN libraries stay pinned (supabase-js 2.118.0, tus 4.3.1, pdf-lib 1.17.1). If you
  change one, change it in index.html, admin.html, sw.js and the offline tests.
- A new picture in `assets/` must also be added to `SHELL` in `sw.js` (a test checks this).
- Every fix comes with a test in `tests/`. Tests never touch the real Supabase.
- SQL files are run by hand by the owner in Supabase → SQL Editor. They must be
  safe to run again.

## Files
| File | What it does |
|---|---|
| `index.html` (~20k lines) | The whole student app: HTML, CSS and many `<script id=…>` blocks added over time. Later blocks wrap and override earlier ones, often by wrapping `render`. |
| `admin.html` | Admin page. Views (`data-v`): dash, users, plans, pay (receipts / activation codes / KHQR), msgs, ctl (website control), board (Dashboard), rooms, news, settings. Also admin Web Push. |
| `rooms.mjs`, `rooms.css` | Rooms (shared spaces). Imported on demand by `qlRoomsLoader`. Everything goes through the RPC `ql_room_v1`. It swaps in its own `service.*` methods while a room is open. |
| `sw.js` | Service worker. Network-first pages, offline copy of the shell, libraries and PDF.js (with integrity hashes). It removes old `ql-app-*` caches. Supabase is never cached. |
| `vendor/pdfjs-6.4.299/` | Local PDF.js. |
| `supabase/*.sql` | Database migrations (order below). `supabase/functions/ql-push/` is the Edge Function for admin push. |
| `tools/google-form-maker.gs` | Apps Script web app (owned by quizlibrary.forms@gmail.com) that makes Google Forms. Setup: `tools/README-google-forms.md`. |
| `supabase/functions/ql-gform/` | Edge Function: app → login + 5/day (DB) → Apps Script with secret. Plain JS so tests import it. |
| `tools/khqr-checker.py` | Runs in Termux on the admin's Android phone. Checks KHQR payments with Bakong and reports them to Supabase. |
| `tests/` | Node/SQL tests (`*.test.mjs/cjs`), Playwright browser tests (`*.browser.py`) and `fixtures/` (simulated Supabase, the observed schema, `rooms-backend.mjs`). |
| `.github/workflows/claude.yml` | `@claude` GitHub Action. |

## Where features live in `index.html`
Find a block with `grep -n '<script id="NAME"' index.html`.
- Core app (state, `service` = Supabase wrapper, render, navigate, library, Realtime
  `subscribe`, offline `qlOff`, history/Back): first big `<script>` (~3570–4886) and
  the `notes*` patch scripts after it. The Realtime filter for `library_items` uses
  `library_id=eq.…`. The activity channel (~5246) has no library_id filter on
  `library_activity_logs`, because that table has no such column.
- `studentAccessFeatureScript`: student access and export.
- `quizFeatureScript` (~9085–15938): quiz editor, import, taking, grading,
  Random Quiz (~13568), Dashboard quiz runner.
- `studentWorkspaceFeatureScript` (~15938): the student's own library ("My Library"),
  its Realtime channel and saving quizzes (`student_patch_quiz_questions`).
- `studentProfileFeatureScript`: profile, avatars, password.
- `qlOneDevice` (~17324): device limit and `ql_device_check`. Polls every 45 s only
  while the tab is visible, and ignores its own `last_seen` UPDATEs (this was the loop fix).
- `ql-stale-deploy-update-checker` (~17515): the "new version" banner.
- `internalQuizShareFeatureScript` (~17619): the "Shared with me" button, badge and old
  quiz-share inbox (`student_quiz_shares`, not in the repo). New quiz shares go through `qlItemShare`.
- `qlInstallApp` (registers sw.js), `qlDevices` (devices list), `qlItemMenu`,
  `qlItemShare` (~18494): Share internally for everything incl. quizzes (`ql_send_item_share`),
  Kuza's "Concept B" look (`.ql-sb-*` on top of shared `.ql-sa-*` parts): Share window with a
  What → Who → Share stepper, person tiles, "Already sent" / "Recently sent to", Undo message
  (`ql_unsend_item_share`); Shared with me = Hi + Your ID pill, underline tabs, Inbox cards,
  History timeline (filter, date groups, Unsend), Saved IDs tiles with Share (`qlSharePreselect`). External short links, Dashboard posting and list.
- `qlGoogleForms` (before `qlRoomsLoader`): Make Google Form button (after Create Quiz), window with tabs
  Practice · Exam · My Google Forms (Practice and Exam share one pane; Exam adds student fields asked first on their
  own page + rules: one answer per Google account, record Gmail, shuffle, no editing; source `exam_paste`/`exam_quiz`;
  needs Apps Script version 3). Practice forms (Apps Script version 4) are copies of a template form
  (`setupPracticeTemplate`, Release marks set to "Immediately" by hand once — Google doesn't let a script set it) so
  students see "View score" after Submit; Practice settings: Shuffle (off by default). "Number the questions" (both tabs, on by default; start at 1 or quiz numbers) is added
  by the app to each prompt. Exam settings are remembered per device (`ql_gf_exam_<uid>`). Paste = `window.qlBulkPastePanel` (end of `quizFeatureScript`): the quiz editor's Bulk Paste
  panel (upload, guides, answer key, Apply & Preview, Missing/Problem panels, editable preview), no Destination/Position.
  The Questions box (`rowsNow()` = the chosen quiz, or the pasted list after Apply; 2+ questions): Parts (Questions per part: typed or quick 25/50/100/max/Half, 1…max, remembered
  as `partSize`; tick several, one form each, made one after another; a failed one keeps the forms before it) or
  My own range (From–To). A list longer than one form starts in Parts, a shorter one in My own range
  (whole list). "Start at 1 / Original numbers" shows when a form doesn't start at question 1. Forms over 30 questions are sent in parts of 30
  (`make` with chunked → first 30, then `add` per part, `discard` if a part fails twice) so no call hits
  Supabase's ~150 s limit; needs Apps Script version 2 (older script = one call). The % counts the parts.
  Then My Google Forms opens with a "ready" banner and the new form highlighted (link, made date, days ago).
  Feature key `gform` (Website Control). Admin → Settings card `gfCard()` stores the Apps Script URL + secret
  and the safety cap; Admin → Users → Manage sets one person's Google Forms per day (badge in the list);
  Edit plan → Make Google Form: limits.gform_per_day (number / "unlimited" / absent = global) and limits.gform_questions (1–200).
- `qlPlans` (~19498): plans, limits incl. `questions_per_quiz`, sale price, codes, KHQR, payments.
  The "Choose your plan" cards come only from the saved plan (`featureLines` = `window.qlPlanCardLines`):
  `CARD_LIMITS` / `CARD_FEATURES` / `CARD_FEAT_LIMITS` must match admin.html `LIMITS` / `FEATURES` /
  `FEAT_LIMITS` (tests/plan-card-sync.test.mjs checks). An open window re-draws on every config refresh.
  Each limit row in Edit plan has a "Show" switch (same look as Unlimited) for the card, saved as `features._card = {limit: bool}`;
  no saved choice = `CARD_HIDDEN_BY_DEFAULT` (Storage hidden, others shown), same list in both files. The limit still applies.
- `qlSupport` (Help & Support), `qlOfflineMode` (offline mode + PDF.js loading),
  `qlWorkspaceLoading` ("Loading your library…" instead of 0 items), `qlRoomsLoader`.
- Hidden tabs pause polling: look for `visibilityState` checks (devices, update checker,
  plans, support).

## SQL migration order (run once each, in this order)
1 plans_admin → 2 plan_sale → 3 plan_limits_more → 4 plan_limits_on_edit →
4b questions_per_quiz_limit → 5 admin_extras → 6 hide_admins → 7 gift_plans →
8 user_greetings → 9 support_messages → 10 security_fixes →
11 admin_push (optional, plus deploy ql-push) → 12 payment_review → 13 khqr_payment →
14 khqr_autocheck → 15 khqr_auto_detect → 16 khqr_budget →
17 single_device_login → 18 device_history → 19 multi_device → 19b device_check_quiet →
20 item_sharing → 21 external_share_short_links → 21b share_history → 21c share_unsend → 22 student_quiz_split_storage →
23 student_patch_quiz_questions → 24 dashboard → 25 dashboard_folder_appearance →
26 read_schema_for_reliability (read only), then **either** reliability_release_v2
**or** (student_quiz_atomic_save_v2 + dashboard_reliable_posting_v2), never both →
27 dashboard_quiz_access_v1 → 28 dashboard_quiz_instant_feedback_v1 → 29 shared_rooms_v1 →
30 security_storage_fix → 31 google_forms (+ Edge Function ql-gform, Apps Script) → 31b google_forms_user_limits → 31c google_forms_plan_limits.
The Google Forms rule/mine/reserve functions are copied identically in 31, 31b and 31c (tests check it): change all three.
Supabase has safeupdate on: every UPDATE/DELETE needs a WHERE (tests/sql-safe-update.test.mjs checks).
`security_check.sql` is read only and can be run any time. No rows returned means all good.
The base tables (`libraries`, `library_items`, …) existed before these files and are not in the repo.

## Running the tests
Install the test engines once, outside the repo:
```bash
npm install --prefix /tmp/ql-reliability-deps --no-audit --no-fund @electric-sql/pglite@0.5.10 embedded-postgres@17.10.0-beta.17 pg@8.23.1
```
```bash
export QL_PGLITE_MODULE=/tmp/ql-reliability-deps/node_modules/@electric-sql/pglite/dist/index.js QL_EMBEDDED_POSTGRES_MODULE=/tmp/ql-reliability-deps/node_modules/embedded-postgres/dist/index.js QL_PG_MODULE=/tmp/ql-reliability-deps/node_modules/pg/lib/index.js PYTHONDONTWRITEBYTECODE=1
```
```bash
node --test tests/*.test.cjs tests/*.test.mjs
```
```bash
for f in tests/*.browser.py tests/bulk-preview-scroll.test.py; do python "$f" || echo "FAIL $f"; done
```
Browser tests need `pip install --target /tmp/ql-reliability-python playwright==1.62.0`,
`PYTHONPATH=/tmp/ql-reliability-python`, and Chromium at `/usr/bin/chromium` (in cloud sessions:
`ln -s /opt/pw-browsers/chromium /usr/bin/chromium`). `quiz-save-v2-concurrency` fails as root
(initdb refuses); that is the container, not the code.

## Checking the live version
```bash
curl -s https://musa-taro-creator.github.io/quiz-library-T/index.html | grep -o 'ql-shell-generation" content="[^"]*"'
```
```bash
curl -s https://musa-taro-creator.github.io/quiz-library-T/sw.js | grep -m1 APP_CACHE
```
Both must show the version in the repo. Pages can take a few minutes after a push to `main`.

## Open items (as of 2026-11-09)
- Check Supabase memory/swap. If it is still around 700 MB, restart the project once.
- The TEST folder in Kuza's Trash can be deleted.
