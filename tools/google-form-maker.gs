/**
 * Quiz Library — Google Form maker (Apps Script web app).
 *
 * Paste this whole file into a new Apps Script project made with the Gmail that
 * should own the forms (quizlibrary.forms@gmail.com). Steps are in the
 * "Make Google Form" section of tools/README-google-forms.md.
 *
 *   1. Run  setup  once (Run ▶). Allow access. Copy the SECRET from the log.
 *   2. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *   3. Paste the Web app URL and the SECRET into Quiz Library Admin → Settings → Google Forms.
 *
 * Only Quiz Library's server (the Supabase Edge Function ql-gform) knows the SECRET,
 * so only logged-in Quiz Library users can make forms. Every form goes into one
 * folder per student ("Quiz Library - Bona (QL-…)") inside "Quiz Library forms".
 */

var ROOT_FOLDER_NAME = 'Quiz Library forms';
var MAX_QUESTIONS = 200;
// Version 2: big forms arrive in parts ("make" with more = true, then "add" for each part),
// so no single request takes long enough to be cut off by Supabase.
// Version 3: exam forms (d.exam): student fields first on their own page, every question
// required, one answer per Google account, the Gmail recorded, shuffled order, no editing.
var VERSION = 3;

/* ------------------------------------------------------------------ setup */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('SECRET', secret);
  }
  var root = rootFolder_();
  // Touch Forms once so the permission screen also covers Google Forms.
  var test = FormApp.create('Quiz Library setup check');
  DriveApp.getFileById(test.getId()).setTrashed(true);
  Logger.log('Forms owner Gmail: ' + Session.getEffectiveUser().getEmail());
  Logger.log('Folder: ' + root.getUrl());
  Logger.log('SECRET (paste into Quiz Library Admin → Settings → Google Forms): ' + secret);
}

/* Make a new secret (then paste it in Admin again). */
function newSecret() {
  PropertiesService.getScriptProperties().deleteProperty('SECRET');
  setup();
}

/* ------------------------------------------------------------------ web app */
function doGet() {
  return json_({ ok: true, service: 'Quiz Library Google Form maker' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request' });
  }
  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || !sameText_(String(body.secret || ''), secret)) {
    return json_({ ok: false, error: 'Not allowed' });
  }
  try {
    switch (body.action) {
      case 'ping':      return json_({ ok: true, owner: owner_(), version: VERSION });
      case 'make':      return json_(make_(body));
      case 'add':       return json_(add_(body));
      case 'discard':   return json_(discard_(body));
      case 'status':    return json_(status_(body));
      case 'rename':    return json_(rename_(body));
      case 'accepting': return json_(accepting_(body));
      case 'share':     return json_(share_(body));
      default:          return json_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err).slice(0, 300) });
  }
}

/* ------------------------------------------------------------------ actions */
function make_(d) {
  var qs = (d.questions || []).slice(0, MAX_QUESTIONS);
  if (!qs.length) throw new Error('No questions to add.');
  if (!d.user_id) throw new Error('Missing student.');
  var title = clean_(d.title, 200) || 'Quiz';
  var form = FormApp.create(title);
  var formId = form.getId();
  var folder;
  try {
    form.setIsQuiz(true);
    form.setDescription(clean_(d.description, 4000) || 'Made with Quiz Library');
    form.setProgressBar(qs.length > 10);
    var exam = d.exam && typeof d.exam === 'object' ? d.exam : null;
    if (exam) examSetup_(form, exam);
    var noAnswer = 0, shortAnswers = 0;
    for (var i = 0; i < qs.length; i++) {
      var r = addQuestion_(form, qs[i], i, !!exam);
      if (r.noAnswer) noAnswer++;
      if (r.short) shortAnswers++;
    }
    if (typeof form.setPublished === 'function') {
      try { form.setPublished(true); } catch (ignore) { /* older form type */ }
    }
    // more parts follow: keep it closed to answers until the last part is in (add_ opens it)
    form.setAcceptingResponses(!d.more);
    folder = studentFolder_(d.user_id, d.user_label);
    DriveApp.getFileById(formId).moveTo(folder);
  } catch (err) {
    try { DriveApp.getFileById(formId).setTrashed(true); } catch (ignore) {}
    throw err;
  }
  var result = {
    ok: true,
    form_id: formId,
    title: title,
    question_count: qs.length,
    responder_url: shortUrl_(form),
    edit_url: form.getEditUrl(),
    folder_url: folder.getUrl(),
    owner: owner_(),
    no_answer: noAnswer,
    short_answers: shortAnswers,
    more: !!d.more,
    editor_email: '',
    editor_error: ''
  };
  var email = cleanEmail_(d.editor_email);
  if (email) {
    try { folder.addEditor(email); result.editor_email = email; }
    catch (err) { result.editor_error = 'Could not add ' + email + ' as editor. Is it a Google account?'; }
  }
  return result;
}

// The next part of a big form. The form must already be in this student's folder.
function add_(d) {
  var form = ownedForm_(d);
  var have = form.getItems().length;
  var qs = (d.questions || []).slice(0, Math.max(0, MAX_QUESTIONS - have));
  if (!qs.length && !(d.questions || []).length) throw new Error('No questions to add.');
  var start = Math.max(0, Math.round(Number(d.start) || have));
  var noAnswer = 0, shortAnswers = 0;
  for (var i = 0; i < qs.length; i++) {
    var r = addQuestion_(form, qs[i], start + i, !!d.required);
    if (r.noAnswer) noAnswer++;
    if (r.short) shortAnswers++;
  }
  if (d.last) {
    form.setProgressBar(have + qs.length > 10);
    if (typeof form.setPublished === 'function') {
      try { form.setPublished(true); } catch (ignore) {}
    }
    form.setAcceptingResponses(true);
  }
  return { ok: true, added: qs.length, question_count: have + qs.length, no_answer: noAnswer, short_answers: shortAnswers, last: !!d.last };
}

// A big form that could not be finished goes to the Trash (only forms in this student's folder).
function discard_(d) {
  var form = ownedForm_(d);
  DriveApp.getFileById(form.getId()).setTrashed(true);
  return { ok: true };
}

function status_(d) {
  var ids = (d.form_ids || []).slice(0, 60), out = {};
  for (var i = 0; i < ids.length; i++) {
    try {
      var form = FormApp.openById(ids[i]);
      out[ids[i]] = { accepting: form.isAcceptingResponses(), responses: form.getResponses().length, title: form.getTitle() };
    } catch (err) {
      out[ids[i]] = { missing: true };
    }
  }
  return { ok: true, forms: out };
}

function rename_(d) {
  var form = ownedForm_(d), title = clean_(d.title, 200);
  if (!title) throw new Error('Type a title.');
  form.setTitle(title);
  DriveApp.getFileById(form.getId()).setName(title);
  return { ok: true, title: title };
}

function accepting_(d) {
  var form = ownedForm_(d), on = !!d.accepting;
  if (on && typeof form.setPublished === 'function') { try { form.setPublished(true); } catch (ignore) {} }
  form.setAcceptingResponses(on);
  return { ok: true, accepting: on };
}

function share_(d) {
  var email = cleanEmail_(d.email);
  if (!email) throw new Error('Type a Gmail address.');
  var folder = studentFolder_(d.user_id, d.user_label);
  try { folder.addEditor(email); }
  catch (err) { throw new Error('Could not add ' + email + ' as editor. Is it a Google account?'); }
  return { ok: true, editor_email: email, folder_url: folder.getUrl() };
}

/* ------------------------------------------------------------------ questions */
// q = { type: 'mcq' | 'true_false' | 'short_answer', prompt, options: [text], correct: [index] | true/false,
//       answers: [text], multi: bool, points, explanation }
// Exam: the rules, then the student fields (required) on their own page before the questions.
function examSetup_(form, ex) {
  if (ex.collect_email) {
    try {
      if (typeof form.setEmailCollectionType === 'function' && FormApp.EmailCollectionType) form.setEmailCollectionType(FormApp.EmailCollectionType.VERIFIED);
      else form.setCollectEmail(true);
    } catch (err) { form.setCollectEmail(true); }
  }
  if (ex.one_response) form.setLimitOneResponsePerUser(true);
  if (ex.shuffle) form.setShuffleQuestions(true);
  if (ex.lock) {
    form.setAllowResponseEdits(false);
    form.setShowLinkToRespondAgain(false);
  }
  form.setPublishingSummary(false);
  form.setConfirmationMessage('Your answers were sent. Thank you!');
  var fields = (ex.fields || []).map(function (t) { return clean_(t, 100); }).filter(String).slice(0, 10);
  if (fields.length) {
    for (var k = 0; k < fields.length; k++) form.addTextItem().setTitle(fields[k]).setRequired(true);
    form.addPageBreakItem().setTitle('Questions');
  }
}

function addQuestion_(form, q, i, required) {
  var title = clean_(q.prompt, 4000).replace(/\s*\n+\s*/g, ' ') || ('Question ' + (i + 1));
  var points = Math.max(0, Math.min(1000, Math.round(Number(q.points) || 1)));
  var expl = clean_(q.explanation, 4000);
  var item, noAnswer = false;
  if (q.type === 'true_false') {
    item = form.addMultipleChoiceItem();
    item.setTitle(title).setChoices([
      item.createChoice('True', q.correct === true),
      item.createChoice('False', q.correct === false)
    ]).setPoints(points);
    setChoiceFeedback_(item, expl);
    if (required) item.setRequired(true);
    noAnswer = q.correct !== true && q.correct !== false;
  } else if (q.type === 'short_answer') {
    item = form.addTextItem();
    item.setTitle(title).setPoints(points);
    if (required) item.setRequired(true);
    // Google can't take the answer key for short answers from a script, so the
    // accepted answers are shown as feedback and the form owner marks them.
    var answers = (q.answers || []).map(function (a) { return clean_(a, 500); }).filter(String);
    var note = (answers.length ? 'Answer: ' + answers.join(' / ') : '') + (expl ? (answers.length ? '\n' : '') + expl : '');
    if (note) item.setGeneralFeedback(FormApp.createFeedback().setText(note).build());
    return { short: true, noAnswer: !answers.length };
  } else {
    var opts = uniqueOptions_(q.options || []);
    if (opts.length < 2) opts = opts.concat(['(blank)', '(blank 2)']).slice(0, 2);
    var correct = (Array.isArray(q.correct) ? q.correct : [q.correct]).map(Number);
    item = q.multi ? form.addCheckboxItem() : form.addMultipleChoiceItem();
    item.setTitle(title).setChoices(opts.map(function (text, k) {
      return item.createChoice(text, correct.indexOf(k) >= 0);
    })).setPoints(points);
    setChoiceFeedback_(item, expl);
    if (required) item.setRequired(true);
    noAnswer = !correct.some(function (k) { return k >= 0 && k < opts.length; });
  }
  return { noAnswer: noAnswer };
}

function setChoiceFeedback_(item, text) {
  if (!text) return;
  var fb = FormApp.createFeedback().setText(text).build();
  item.setFeedbackForCorrect(fb).setFeedbackForIncorrect(fb);
}

// Google needs every answer option to be different and not empty.
function uniqueOptions_(list) {
  var seen = {}, out = [];
  for (var i = 0; i < list.length; i++) {
    var t = clean_(list[i], 500).replace(/\s*\n+\s*/g, ' ') || '(blank)';
    var base = t, n = 2;
    while (seen[t.toLowerCase()]) { t = base + ' (' + n + ')'; n++; }
    seen[t.toLowerCase()] = true;
    out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ folders */
function rootFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('ROOT_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (ignore) {} }
  var it = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);
  props.setProperty('ROOT_ID', folder.getId());
  return folder;
}

function studentFolder_(userId, label) {
  var key = 'folder_' + String(userId).replace(/[^A-Za-z0-9-]/g, '');
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var id = props.getProperty(key);
    if (id) { try { return DriveApp.getFolderById(id); } catch (ignore) {} }
    var folder = rootFolder_().createFolder('Quiz Library - ' + (clean_(label, 120) || 'Student'));
    props.setProperty(key, folder.getId());
    return folder;
  } finally {
    lock.releaseLock();
  }
}

// The form must sit in this student's folder (a second check after the Edge Function's).
function ownedForm_(d) {
  if (!d.form_id || !d.user_id) throw new Error('Missing form.');
  var id = PropertiesService.getScriptProperties().getProperty('folder_' + String(d.user_id).replace(/[^A-Za-z0-9-]/g, ''));
  var parents = DriveApp.getFileById(d.form_id).getParents(), ok = false;
  while (parents.hasNext()) { if (parents.next().getId() === id) ok = true; }
  if (!id || !ok) throw new Error('This form is not in your folder.');
  return FormApp.openById(d.form_id);
}

/* ------------------------------------------------------------------ small helpers */
function owner_() { return Session.getEffectiveUser().getEmail(); }

function shortUrl_(form) {
  var url = form.getPublishedUrl();
  try { return form.shortenFormUrl(url); } catch (ignore) { return url; }
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max || 1000);
}

function cleanEmail_(v) {
  var e = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200 ? e : '';
}

function sameText_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
