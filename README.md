# Quiz Library

A web app where students keep their quizzes, PDFs and quiz links in one library,
take quizzes, share them, and post to a common Dashboard. Students can install it
on their phone and use it offline. An admin page manages users, plans, payments
and website settings.

There is no build step: the files in this repository are the website. It is
published with GitHub Pages (`https://musa-taro-creator.github.io/quiz-library-T/`)
and uses [Supabase](https://supabase.com) for accounts, data and file storage.

## Files

| File / folder | What it is |
|---|---|
| `index.html` | The student app (library, quizzes, sharing, Dashboard, profile, plans, offline mode). |
| `admin.html` | The admin page: users, plans, payments, KHQR, website control, messages, settings. |
| `rooms.mjs`, `rooms.css` | Rooms (shared spaces). Loaded only when a student opens Rooms. |
| `sw.js` | Service worker: keeps the app on the device so it opens offline. |
| `assets/` | Pictures used by `index.html` (logos, quiz buttons and background, avatars). |
| `icons/`, `manifest.webmanifest`, `admin.webmanifest` | App icons and install settings. |
| `vendor/pdfjs-6.4.299/` | The PDF viewer (PDF.js), kept here so it also works offline. |
| `supabase/*.sql` | Database changes. Run them in Supabase → SQL Editor (order below). |
| `supabase/functions/ql-push/` | Supabase Edge Function that sends admin notifications. |
| `supabase/functions/ql-gform/` | Edge Function for Make Google Form (checks the login, then asks the Apps Script). |
| `tools/google-form-maker.gs`, `tools/README-google-forms.md` | Apps Script that makes students' Google Forms, and the setup steps. |
| `tools/khqr-checker.py` | Runs in Termux on the admin's Android phone and confirms KHQR payments with Bakong. |
| `tests/` | Local tests. They never connect to the real Supabase. See `tests/README.md`. |

## Database setup order

Run each file once in **Supabase → SQL Editor**, in this order. Each file is safe to
run again. Some files replace a function from an earlier file, so a later file in
this list must not be run before an earlier one.

The base tables (`libraries`, `library_items`, `student_library_items`, the
`library-pdfs` storage bucket, student access, and external quiz sharing) were made
before these files and are not in this repository.

**Plans and admin**

1. `plans_admin.sql`: plans, subscriptions, codes, payments, admin page.
2. `plan_sale.sql`: discounts.
3. `plan_limits_more.sql`: limits for quiz links and folders.
4. `plan_limits_on_edit.sql`: limits also apply when items are restored, change type, or grow.
4b. `questions_per_quiz_limit.sql`: the questions-per-quiz limit is checked by the database too.
5. `admin_extras.sql`: storage numbers, permanent user delete.
6. `hide_admins.sql`: keep admin accounts out of user lists and numbers.
7. `gift_plans.sql`: gift a plan to a user.
8. `user_greetings.sql`: a personal greeting for one user.
9. `support_messages.sql`: Help & Support messages.
10. `security_fixes.sql`: receipts and support pictures must be real pictures. Run after 2 and 9.

**Notifications and payments**

11. `admin_push.sql`: admin notifications (also deploy `supabase/functions/ql-push`). Optional.
12. `payment_review.sql`: fast receipt review.
13. `khqr_payment.sql`: pay with KHQR.
14. `khqr_autocheck.sql`: automatic check with the Android phone.
15. `khqr_auto_detect.sql`: payments are found without "I paid".
16. `khqr_budget.sql`: stay inside Bakong's free daily checks.

**Devices**

17. `single_device_login.sql`
18. `device_history.sql`
19. `multi_device.sql`
19b. `device_check_quiet.sql`: the device check only reads (stops a request loop).

**Sharing, quizzes and Dashboard**

20. `item_sharing.sql`: share PDFs, links and folders.
21. `external_share_short_links.sql`: short links for "Share externally".
21b. `share_history.sql`: "Shared with me" → History and Saved IDs.
21c. `share_unsend.sql`: Unsend a waiting share, and "Recently sent" in Share internally.
22. `student_quiz_split_storage.sql`: one row per question.
23. `student_patch_quiz_questions.sql`: save only changed questions.
24. `dashboard.sql`
25. `dashboard_folder_appearance.sql`
26. `read_schema_for_reliability.sql` (read only), then **either**
    `reliability_release_v2.sql` **or** the two files inside it
    (`student_quiz_atomic_save_v2.sql` and `dashboard_reliable_posting_v2.sql`), not both.
27. `dashboard_quiz_access_v1.sql`
28. `dashboard_quiz_instant_feedback_v1.sql`
29. `shared_rooms_v1.sql`
30. `security_storage_fix.sql`: closes open file-storage rules.
31. `google_forms.sql`: Make Google Form (also deploy `supabase/functions/ql-gform`; steps in `tools/README-google-forms.md`).
31b. `google_forms_user_limits.sql`: Google Forms per day per person (Admin → Users). Run after 31.
31c. `google_forms_plan_limits.sql`: Google Forms per day and questions per form per plan (Edit plan). Run after 31b.
32. `rooms_controls_v1.sql`: Website Control → Rooms (every room button: Everyone / By plan / Lock / Hidden, checked on the server for each person's own plan), "Who can change this?" on room items and the room owner's item rules. Run after 29 (and run it again if 29 is ever run again).
33. `rooms_look_v1.sql`: the new room page: cover colour and emoji, pins, "since your last visit", studying now, NEW badges and quiz scores on the cards. Run after 32.

`security_check.sql` is read only: run it any time. Every row it returns is
something to look at; no rows means all good.

## Making changes

- **Libraries from a CDN are pinned to exact versions** (`@supabase/supabase-js@2.118.0`,
  `tus-js-client@4.3.1`, `pdf-lib@1.17.1`). To update one, change the version in
  `index.html`, `admin.html` (Supabase only), `sw.js` and the offline tests, then test.
- **Releasing a change to the student app:** change the version name in both places,
  `<meta name="ql-shell-generation" content="…">` in `index.html` and `APP_CACHE` /
  `SHELL_GENERATION` in `sw.js`, so installed apps download the new version as one update.
- **New picture for `index.html`:** put it in `assets/` and add its path to `SHELL` in
  `sw.js` so it also works offline (a test checks this).

## Tests

See `tests/README.md` for setup. In short, from the repository root:

```bash
node --test tests/*.test.cjs tests/*.test.mjs
```

```bash
python tests/library-workflows.browser.py
```

The SQL tests run the real `supabase/*.sql` files in a temporary local database, and the
browser tests use a simulated Supabase, so no real accounts or data are touched.
