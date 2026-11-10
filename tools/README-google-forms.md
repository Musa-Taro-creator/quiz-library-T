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
| "Invalid JWT" on Check connection | In the function's settings turn **Verify JWT** off. It is still safe: the function checks the login itself through the database. |
| "The server key is missing for ql-gform" | The project has no secret key. In Project Settings → API Keys create a **secret key** (named `default`), then redeploy the function. It uses the new keys by itself and falls back to the legacy ones. |
