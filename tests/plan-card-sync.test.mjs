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
  vm.runInNewContext(plansBlock.slice(a, b) + 'window.qlPlanCardLines=featureLines;window.L=CARD_LIMITS;window.F=CARD_FEATURES;window.FL=CARD_FEAT_LIMITS;', ctx);
  return ctx.window;
}
function adminLists() {
  const grab = name => { const m = admin.match(new RegExp(`const ${name}=([\\s\\S]*?);\\n`)); assert.ok(m, name); return m[1]; };
  return vm.runInNewContext(`({FEATURES:${grab('FEATURES')},LIMITS:${grab('LIMITS')},FEAT_LIMITS:${grab('FEAT_LIMITS')}})`);
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
});

test("Kuza's Free plan: Storage, Results kept, Devices, ticked Create Folder and Others all show", () => {
  const card = cardModule();
  const free = {id: 'free', name: 'Free', is_default: true, visibility: 'public',
    limits: {storage_mb: 100, results_kept: 3, devices: 1, quizzes: 3, questions_per_quiz: 100, links: 3, folders: 3, pdfs: null},
    features: {new_folder: true, new_link: true, new_quiz: true, _others: ['Others', '  ', 'Priority support']}};
  assert.deepEqual(lines(card, free), [
    'Storage: 100 MB', 'Results kept per quiz: 3', 'Devices at the same time: 1',
    'Create Folder · 3 folders', 'Add Quiz Link · 3 quiz links', 'Create Quiz · 3 quizzes · 100 questions each',
    'Others', 'Priority support']);
});

test('Unlimited toggles, unticked features, every feature group and Google Forms limits', () => {
  const card = cardModule();
  const max = {limits: {storage_mb: null, results_kept: null, devices: null, quizzes: null, questions_per_quiz: null, pdfs: 20480, gform_per_day: 'unlimited', gform_questions: null},
    features: {new_quiz: true, new_pdf: true, gform: true, nav_rooms: true, sel_move: true, quiz_shuffle: true, pf_themes: true, _sale: {pct: 33}}};
  assert.deepEqual(lines(card, max), [
    'Storage: Unlimited', 'Results kept per quiz: Unlimited', 'Devices at the same time: Unlimited',
    'Rooms', 'Upload PDF · 20480 PDFs', 'Create Quiz · Unlimited quizzes · Unlimited questions each',
    'Make Google Form · Unlimited Google Forms a day · 200 questions per form',
    'Select many: Move', 'Shuffle', 'App themes']);
  const pro = {limits: {storage_mb: 2048, results_kept: 10, gform_per_day: 7, gform_questions: 50}, features: {gform: true}};
  assert.deepEqual(lines(card, pro), ['Storage: 2 GB', 'Results kept per quiz: 10', 'Devices at the same time: 1', 'Make Google Form · 7 Google Forms a day · 50 questions per form']);
  // empty Google Forms per day = the default from Settings: no number is made up on the card
  assert.deepEqual(lines(card, {limits: {}, features: {gform: true}}).at(-1), 'Make Google Form · 200 questions per form');
  // nothing ticked: only the Limits rows, no made-up lines
  assert.deepEqual(lines(card, {limits: {storage_mb: 100, results_kept: 3, devices: 2}, features: {}}), ['Storage: 100 MB', 'Results kept per quiz: 3', 'Devices at the same time: 2']);
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
