-- Quiz Library — close 3 open file-storage rules (found by security_check.sql). Safe to run again.
--
-- 1. "students manage own pdf uploads (select)" let ANY signed-in user open EVERY PDF in
--    library-pdfs (other students' private PDFs and your library PDFs).
-- 2. "students manage own pdf uploads (insert)" let any signed-in user upload anywhere in it.
--    Students already have their own narrower rules ("student pdf … own", folder students/<their id>/),
--    and your library has its own rules, so nothing that the app uses breaks.
-- 3. quiz-images: anyone (even not signed in) could upload or DELETE any picture. The app does
--    not use this bucket any more; pictures stay readable.

drop policy if exists "students manage own pdf uploads (select)" on storage.objects;
drop policy if exists "students manage own pdf uploads (insert)" on storage.objects;
drop policy if exists "quiz_images_public_write" on storage.objects;
drop policy if exists "quiz_images_public_delete" on storage.objects;
