// Plans page sync: the student "Choose your plan" card comes only from the plan saved in
// Admin → Plans → Edit plan. No network, no Supabase: runs the card builder from index.html
// and compares its lists with admin.html.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const plansBlock = html.slice(html.indexOf('<script id="qlPlans">'), html.indexOf('</script>', html.indexOf('<script id="qlPlans">')));

function cardModule() {
  const a = plansBlock.indexOf('  const CARD_LIMITS='), b = plansBlock.indexOf('window.qlPlanCardLines=featureLines;');
  assert.ok(a > 0 && b > a, 'card builder found in qlPlans');
  const ctx = {window: {}};
  vm.runInNewContext(plansBlock.slice(a, b) + 'window.qlPlanCardLines=featureLines;window.L=CARD_LIMITS;window.F=CARD_FEATURES;window.FL=CARD_FEAT_LIMITS;window.HID=CARD_HIDDEN_BY_DEFAULT;', ctx);
  return ctx.window;
}
function adminLists() {
  const grab = name => { const m = admin.match(new RegExp(`const ${name}=([\\s\\S]*?);\\n`)); assert.ok(m, name); return m[1]; };
  return vm.runInNewContext(`({FEATURES:${grab('FEATURES')},LIMITS:${grab('LIMITS')},FEAT_LIMITS:${grab('FEAT_LIMITS')},HID:${grab('CARD_HIDDEN_BY_DEFAULT')}})`);
}
const plain = x => JSON.parse(JSON.stringify(x));
const lines = (card, p) => plain(card.qlPlanCardLines(p)).map(([t]) => t);

test('card lists match admin Edit plan (Limits, Features in this plan, limits under each tick)', () => {
  const card = cardModule(), a = adminLists();
  assert.deepEqual(plain(card.L), plain(a.LIMITS).map(([k, l]) => [k, l]));
  const adminFeatures = a.FEATURES.flatMap(g => g[1]).filter(f => f[0] !== 'signup');
  assert.deepEqual(plain(card.F), plain(adminFeatures), 'same features, same names, same order as admin');
  for (const [k, rows] of Object.entries(a.FEAT_LIMITS)) {
    const mine = (card.FL[k] || []).map(r => r[0]);
    for (const [lk] of rows) assert.ok(mine.includes(lk), `${k}: limit ${lk} is on the card`);
  }
  assert.ok(card.FL.gform.some(r => r[0] === 'gform_per_day'), 'Google Forms per day is on the card');
  assert.deepEqual(plain(card.HID), plain(a.HID), 'same "hidden on the card by default" list as admin');
  assert.deepEqual(plain(a.HID), ['storage_mb'], 'Storage is hidden by default, every other limit row is shown');
});

test("Kuza's Free plan: Results kept, Devices, ticked Create Folder and Others show; Storage hidden by default", () => {
  const card = cardModule();
  const free = {id: 'free', name: 'Free', is_default: true, visibility: 'public',
    limits: {storage_mb: 100, results_kept: 3, devices: 1, quizzes: 3, questions_per_quiz: 100, links: 3, folders: 3, pdfs: null},
    features: {new_folder: true, new_link: true, new_quiz: true, _others: ['Others', '  ', 'Priority support']}};
  assert.deepEqual(lines(card, free), [
    'Results kept per quiz: 3', 'Devices at the same time: 1',
    'Create Folder · 3 folders', 'Add Quiz Link · 3 quiz links', 'Create Quiz · 3 quizzes · 100 questions each',
    'Others', 'Priority support']);
});

test('Unlimited toggles, unticked features, every feature group and Google Forms limits', () => {
  const card = cardModule();
  const max = {limits: {storage_mb: null, results_kept: null, devices: null, quizzes: null, questions_per_quiz: null, pdfs: 20480, gform_per_day: 'unlimited', gform_questions: null},
    features: {new_quiz: true, new_pdf: true, gform: true, nav_rooms: true, sel_move: true, quiz_shuffle: true, pf_themes: true, _sale: {pct: 33}}};
  assert.deepEqual(lines(card, max), [
    'Results kept per quiz: Unlimited', 'Devices at the same time: Unlimited',
    'Rooms', 'Upload PDF · 20480 PDFs', 'Create Quiz · Unlimited quizzes · Unlimited questions each',
    'Make Google Form · Unlimited Google Forms a day · 200 questions per form',
    'Select many: Move', 'Shuffle', 'App themes']);
  const pro = {limits: {storage_mb: 2048, results_kept: 10, gform_per_day: 7, gform_questions: 50}, features: {gform: true}};
  assert.deepEqual(lines(card, pro), ['Results kept per quiz: 10', 'Devices at the same time: 1', 'Make Google Form · 7 Google Forms a day · 50 questions per form']);
  // empty Google Forms per day = the default from Settings: no number is made up on the card
  assert.deepEqual(lines(card, {limits: {}, features: {gform: true}}).at(-1), 'Make Google Form · 200 questions per form');
  // nothing ticked: only the Limits rows, no made-up lines
  assert.deepEqual(lines(card, {limits: {storage_mb: 100, results_kept: 3, devices: 2}, features: {}}), ['Results kept per quiz: 3', 'Devices at the same time: 2']);
});

test('"Show on student card" per limit row: saved choice wins, no choice = default, limit rows under features too', () => {
  const card = cardModule();
  const L = {storage_mb: 2048, results_kept: 5, devices: 2, quizzes: 10, questions_per_quiz: 50, gform_per_day: 4, gform_questions: 30};
  // admin turned Storage on and Devices off
  assert.deepEqual(lines(card, {limits: L, features: {_card: {storage_mb: true, devices: false}}}), ['Storage: 2 GB', 'Results kept per quiz: 5']);
  // every row hidden, including the ones under a ticked feature: the feature still shows, without numbers
  const off = {storage_mb: false, results_kept: false, devices: false, quizzes: false, questions_per_quiz: false, gform_per_day: false, gform_questions: false};
  assert.deepEqual(lines(card, {limits: L, features: {new_quiz: true, gform: true, _card: off}}), ['Create Quiz', 'Make Google Form']);
  // one row of two under Create Quiz hidden
  assert.deepEqual(lines(card, {limits: L, features: {new_quiz: true, _card: {questions_per_quiz: false}}}).at(-1), 'Create Quiz · 10 quizzes');
  // a broken saved value falls back to the defaults
  assert.deepEqual(lines(card, {limits: L, features: {_card: 'x'}}), ['Results kept per quiz: 5', 'Devices at the same time: 2']);
});

test('admin Edit plan has a Shown/Hidden choice on every limit row and saves it with the plan', () => {
  const ed = admin.slice(admin.indexOf('function editPlan('), admin.indexOf('const modeLabel='));
  assert.match(ed, /const limRow=\(k,l\)=>\{[^\n]*\$\{eye\(k\)\}<\/div>`\}/, 'every limRow (Limits + rows under a feature tick) has the eye');
  assert.match(ed, /id="pGfDayUnl"><\/button>Unlimited<\/span>\$\{eye\("gform_per_day"\)\}/, 'Google Forms per day row has the eye');
  assert.match(ed, /features\._card=\{\};o\.querySelectorAll\("\[data-show\]"\)\.forEach\(b=>features\._card\[b\.dataset\.show\]=b\.classList\.contains\("on"\)\)/, 'saved in features._card');
});

test('old hard-coded card lines are gone and the open window re-draws on new plan data', () => {
  assert.ok(!html.includes('1 device at a time'), 'old devices line');
  assert.ok(!html.includes('Share externally + QR'), 'old feature name list');
  const fl = plansBlock.slice(plansBlock.indexOf('function featureLines'), plansBlock.indexOf('window.qlPlanCardLines'));
  assert.ok(!/featMode|cfg\b/.test(fl), 'card lines depend only on the plan');
  const up = plansBlock.slice(plansBlock.indexOf('function openUpgrade'), plansBlock.indexOf('function shrink'));
  assert.match(up, /const render=\(refresh\)=>\{[\s\S]*?const ps=plans\(\)\.filter\(p=>p\.visibility==="public"\)/, 'plans are read on every draw');
  assert.match(up, /upLive=render;[\s\S]*loadCfg\(\);/, 'opening the window fetches the newest plans');
  assert.match(plansBlock, /applyAll\(\);upRefresh\(\);/, 'a config refresh (Realtime / poll) re-draws the open window');
  assert.match(plansBlock, /table:"ql_plans"\},\(\)=>\{loadCfg\(\);loadMine\(\)\}/, 'Realtime on ql_plans still reloads');
});
