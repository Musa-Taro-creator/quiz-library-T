# Make Google Form — setup (about 15 minutes, once)

Students press **Make Google Form**. The form is made by **one Gmail you own**
(`quizlibrary.forms@gmail.com`) and put in a folder for that student. Three pieces:

| Piece | Where | File |
|---|---|---|
| Apps Script (makes the forms) | script.google.com, signed in as the forms Gmail | `tools/google-form-maker.gs` |
| Database (list + 5 a day) | Supabase → SQL Editor | `supabase/google_forms.sql` |
| Edge Function (checks the login) | Supabase → Edge Functions | `supabase/functions/ql-gform/index.ts` |

## A. Apps Script — signed in as quizlibrary.forms@gmail.com

1. Open **script.google.com** while signed in with `quizlibrary.forms@gmail.com`
   (use a private window if you are signed in with other Gmails).
2. **New project**. Click "Untitled project" and name it **Quiz Library forms**.
3. Delete the sample code. Paste **all** of `tools/google-form-maker.gs`. Press **Save** (💾).
4. At the top, choose the function **setup** and press **Run ▶**.
   - "Authorization required" → **Review permissions** → choose `quizlibrary.forms@gmail.com`.
   - "Google hasn't verified this app" → **Advanced** → **Go to Quiz Library forms (unsafe)** → **Allow**.
     (This is your own script, so the warning is normal.)
5. The **Execution log** opens at the bottom. Copy the long text after **SECRET**.
6. **Deploy → New deployment** → click ⚙ next to "Select type" → **Web app**.
   - Description: `v1`
   - Execute as: **Me (quizlibrary.forms@gmail.com)**
   - Who has access: **Anyone**
   - **Deploy** → copy the **Web app URL** (it ends with `/exec`).

Later changes to the script: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**
(the URL stays the same).

## B. Supabase

1. **SQL Editor** → paste all of `supabase/google_forms.sql` → **Run**. It should say *Success*.
2. **Edge Functions → Deploy a new function → Via Editor**.
   - Name: **ql-gform**
   - Delete the sample, paste all of `supabase/functions/ql-gform/index.ts`, **Deploy**.
   - Leave **Verify JWT** on. Nothing else to add: Supabase gives the function its keys by itself.

## C. Quiz Library Admin

1. **Settings → 📝 Make Google Form**: paste the **Web app URL** and the **SECRET**,
   set **Forms per student per day** (5), press **Save**.
   You should see: ✅ *Saved and connected. Forms are made by quizlibrary.forms@gmail.com*.
2. **Website Control → + New menu → Make Google Form**: On / Off / Plan.

## Daily limits

Settings → **Forms per student per day** is the Default (5). In **Users → Manage → 📝 Google Forms per day**
you can give one person their own number (0–1000) or **Unlimited**. Admin accounts are Unlimited.
Unlimited still stops at the **safety cap** (Settings, default 100 a day). Needs `supabase/google_forms_user_limits.sql`.

Plans: **Plans & Limits → Edit plan → Make Google Form** has **Google Forms per day** (empty = the default,
a number, or Unlimited) and **Questions per form** (1–200; Unlimited = 200). Order: admin → the person's own
setting → the plan → the default. Needs `supabase/google_forms_plan_limits.sql`.

## Big forms (more than 30 questions)

Supabase stops an Edge Function after about 150 seconds, and Google needs about a second per
question. So the app sends big forms in parts of 30: the first part makes the form, the rest are
added one part at a time (the progress % counts the parts). This needs **Apps Script version 2**
(`ping` answers `version: 2`) and the current `ql-gform`. With an older Apps Script everything is
still sent in one call, as before.

After updating `tools/google-form-maker.gs`: paste it into the Apps Script project, **Save**, then
**Deploy → Manage deployments → ✏️ → Version: New version → Deploy** (the URL stays the same).
After updating `supabase/functions/ql-gform/index.ts`: open the function in Supabase, paste the
file, **Deploy**.

## Exam forms

The **Exam** tab makes a form that asks each student's details first (name, ID, … on their own
page, required), makes every question required, and can allow one answer per Google account,
record the Gmail, shuffle the questions and block editing. This needs **Apps Script version 3**
(`ping` answers `version: 3`): paste the current `tools/google-form-maker.gs`, Save, then
Deploy → Manage deployments → ✏️ → Version: New version → Deploy. With an older Apps Script the
app says "Exam forms need the new Apps Script (version 3)" and nothing is made. Practice forms
keep working either way. Google doesn't let a script hide the score: change it once in Google
Forms → Settings → Release marks if needed.

## Practice forms: show the score after Submit (template)

Google doesn't let a script set **Release marks**, and forms made by a script start on
"Later, after manual review", so students only see "Your response has been recorded". From
**Apps Script version 4** every practice form is made as a **copy of a template form**, and a copy
keeps the template's settings. Set it up once, signed in as the forms Gmail:

1. Paste the current `tools/google-form-maker.gs`, **Save**, then **Deploy → Manage deployments → ✏️ →
   Version: New version → Deploy** (same URL). Update `ql-gform` too.
2. At the top choose **setupPracticeTemplate** and press **Run ▶**. The log shows the link of
   "Quiz Library – practice template (do not delete)" (in the "Quiz Library forms" folder).
3. Open that link → **Settings** → **Release marks** → **Immediately after each submission**, and tick
   **Missed questions**, **Correct answers** and **Point values**. Keep the template empty.
4. Admin → Settings → Make Google Form → **Check connection** should say
   "Apps Script version 4 · Practice template: ✓ ready".
5. Make one small practice form and submit it: you should see **View score**.

Exam forms are not copied from it (they stay on "Later", for the teacher to release). Forms made
before this keep "Later": change those by hand (Settings → Release marks). If the template is deleted,
practice forms are still made the old way and Check connection says "Practice template missing".
The Practice tab's **Shuffle question order** also needs version 4.

## Switching to another Gmail later

Do part A with the new Gmail, then paste its URL and SECRET in Admin. New forms use the
new Gmail; forms made before keep working while the old Apps Script stays deployed
(Admin lists it under "Other Gmails").

## If something goes wrong

| Message | Fix |
|---|---|
| "The Edge Function ql-gform is not deployed yet" | Part B step 2. |
| "The Google Forms secret in Admin does not match the Apps Script" | Copy the SECRET again (run **setup** once more to see it in the log) and paste it in Admin. |
| "Google sent an unexpected answer…" | The deployment must be **Web app**, **Execute as: Me**, **Who has access: Anyone**. |
| "Google took too long to answer…" | Supabase stopped the function. Make sure the Apps Script is version 2 and `ql-gform` is up to date (see Big forms). |
| "Invalid JWT" on Check connection | In the function's settings turn **Verify JWT** off. It is still safe: the function checks the login itself through the database. |
| "The server key is missing for ql-gform" | The project has no secret key. In Project Settings → API Keys create a **secret key** (named `default`), then redeploy the function. It uses the new keys by itself and falls back to the legacy ones. |
