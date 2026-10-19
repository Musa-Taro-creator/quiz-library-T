"""Run with Python, Playwright and Chromium; all data and browser I/O stay local.

    python tests/bulk-preview-scroll.test.py

QUIZ_HTML_PATH can select an earlier HTML snapshot to verify the regression.
"""
import os
from pathlib import Path
import re
import shutil
import unittest

from playwright.sync_api import sync_playwright


class BulkPreviewScrollTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source_path = Path(os.environ.get(
            "QUIZ_HTML_PATH", Path(__file__).resolve().parents[1] / "index.html"))
        source = source_path.read_text()

        def definition(name):
            start = re.search(r"^  function " + re.escape(name) + r"\(", source, re.M).start()
            following = re.search(r"^  function ", source[start + 3:], re.M)
            return source[start:start + 3 + following.start()]

        names = [
            "qzEnsureSubDialog", "qzOpenSubDialog", "qzCloseSubDialog", "qzLetter",
            "qzIsLetterOptionLine", "qzIsAnswerLine", "qzIsNumberedQuestionStart",
            "qzLooksLikeQuestionSentence", "qzSplitBulkBlocks", "qzParseBulkText",
            "qzParseAnswerKey", "qzSessOf", "qzInSess", "qzSetSess", "qzSessionNames",
            "qzNormOpt", "qzIsMultiIdx", "qzNewQuestion", "qzDestinationOptions",
            "qzSessionFilterOptions", "qzScopeIndices", "qzComputeInsertIndex",
            "openAddNewQuestionsDialog",
        ]
        cls.component = "\n".join(definition(name) for name in names)
        cls.styles = "\n".join(re.findall(r"<style[^>]*>([\s\S]*?)</style>", source))
        cls.playwright = sync_playwright().start()
        options = {"headless": True, "args": ["--no-sandbox"]}
        executable = os.environ.get("CHROMIUM_EXECUTABLE") or shutil.which("chromium")
        if executable:
            options["executable_path"] = executable
        cls.browser = cls.playwright.chromium.launch(**options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 1920, "height": 950})
        self.errors, self.requests = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

        def block(route):
            self.requests.append(route.request.url)
            route.abort()

        self.page.route("**/*", block)
        self.page.set_content('<!doctype html><html><head><meta charset="utf-8"><style>' +
                              self.styles + '</style></head><body class="ql-skin ql-white"></body></html>')
        self.page.evaluate("""() => {
            window.esc = value => String(value ?? '').replace(/[&<>"']/g,
                m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
            window.toast = () => {};
            window.alert = message => { throw Error(message) };
            window.nextId = 0;
            window.uid = () => 'test-question-' + (++window.nextId);
        }""")
        self.page.evaluate("() => { let qzSessionRegistry=[];\n" + self.component + """
            window.openDemo = () => {
                window.done = null;
                openAddNewQuestionsDialog([], qs => { window.done=qs }, {tab:'bulk'});
            };
            openDemo();
        }""")
        blocks = []
        for i in range(1, 123):
            if i == 80:
                block = f"{i}. True or false?\nA. True\nB. False\nAnswer: A"
            elif i == 100:
                block = f"{i}. Capital of France?\nAnswer: Paris"
            else:
                block = f"{i}. Which answer is correct?\nA. First\nB. Second"
                if i != 122:
                    block += "\nAnswer: A"
            blocks.append(block)
        self.text = "\n\n".join(blocks)
        self.page.locator("#qzAqBulkArea").fill(self.text)
        self.page.locator("#qzAqParse").click()
        self.assertEqual(self.page.locator("[data-bulk-item]").count(), 122)

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])
        self.assertEqual(self.requests, [])

    def settled(self):
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")

    def positions(self):
        return self.page.evaluate("""() => ['#qzSubDialogBox', '#qzAqPreview .qz-preview-list',
            '#qzAqBulkArea', '#qzAqKeyArea'].map(selector => {
                const el=document.querySelector(selector);
                return {selector,top:el.scrollTop,left:el.scrollLeft};
            })""")

    def act_without_jump(self, selector, action="click", value=None):
        target = self.page.locator(selector)
        target.scroll_into_view_if_needed()
        self.settled()
        before = self.positions()
        self.assertGreater(before[1]["top"], 1000, "The test must exercise a deep question")
        if action == "select":
            target.select_option(value)
        elif action == "space":
            target.focus()
            target.press("Space")
        else:
            target.click()
        self.settled()
        for position in before:
            current = self.page.locator(position["selector"]).evaluate("""el => ({
                top:el.scrollTop,left:el.scrollLeft,
                maxTop:el.scrollHeight-el.clientHeight,maxLeft:el.scrollWidth-el.clientWidth})""")
            self.assertAlmostEqual(current["top"], min(position["top"], current["maxTop"]), delta=1,
                                   msg=f"Scroll jumped in {position['selector']}")
            self.assertAlmostEqual(current["left"], min(position["left"], current["maxLeft"]), delta=1)
        self.assertTrue(self.page.locator(selector).evaluate("el => el === document.activeElement"),
                        "Keyboard focus must remain on the changed answer control")

    def test_question_62_toggle_and_answer_ticks_keep_position(self):
        toggle = '.qz-bp-multi-toggle[data-bulk-index="61"]'
        self.act_without_jump(toggle)
        self.assertTrue(self.page.locator(toggle).is_checked())
        second = '.qz-bp-tick[data-bulk-index="61"][data-opt-index="1"]'
        self.act_without_jump(second)
        self.assertEqual(self.page.locator('[data-bulk-item="61"] .qz-bp-tick:checked').count(), 2)
        first = '.qz-bp-tick[data-bulk-index="61"][data-opt-index="0"]'
        self.act_without_jump(first)
        self.act_without_jump(toggle)
        self.assertEqual(self.page.locator('.qz-bp-answer-select[data-bulk-index="61"]').input_value(), "1")

    def test_dropdown_and_true_false_controls_keep_position(self):
        self.act_without_jump('.qz-bp-answer-select[data-bulk-index="61"]', "select", "1")
        self.act_without_jump('.qz-bp-tf-btn[data-bulk-tf="79"][data-val="false"]')
        self.assertIn("active", self.page.locator('.qz-bp-tf-btn[data-bulk-tf="79"][data-val="false"]').get_attribute("class"))

    def test_keyboard_toggles_and_removing_last_selected_answer(self):
        self.act_without_jump('.qz-bp-multi-toggle[data-bulk-index="61"]', "space")
        self.act_without_jump('.qz-bp-tick[data-bulk-index="61"][data-opt-index="0"]', "space")
        row = self.page.locator('[data-bulk-item="61"]')
        self.assertEqual(row.locator('.qz-preview-opt.is-correct').count(), 0)
        self.assertEqual(row.locator('.qz-bp-tick:checked').count(), 0)
        self.assertIn("ANSWER MISSING", row.inner_text())

    def test_pasted_drafts_and_textarea_scroll_survive_answer_changes(self):
        draft, key = self.text + "\n\n", "1.B\n"
        self.page.locator("#qzAqBulkArea").fill(draft)
        self.page.locator("#qzAqKeyArea").fill(key)
        self.page.locator("#qzAqBulkArea").evaluate("el => {el.scrollTop=140}")
        self.act_without_jump('.qz-bp-multi-toggle[data-bulk-index="61"]')
        self.assertEqual(self.page.locator("#qzAqBulkArea").input_value(), draft)
        self.assertEqual(self.page.locator("#qzAqKeyArea").input_value(), key)
        self.assertEqual(self.page.locator('.qz-bp-answer-select[data-bulk-index="0"]').input_value(), "0")

    def test_resolving_final_missing_answer_keeps_deep_question_visible(self):
        self.act_without_jump('.qz-bp-answer-select[data-bulk-index="121"]', "select", "1")
        self.assertIn("122/122", self.page.locator(".qz-bp-summary").inner_text())
        self.assertTrue(self.page.locator("#qzAddQSubmit").is_enabled())

    def test_missing_answer_navigation_and_saved_answer_values(self):
        self.act_without_jump('.qz-bp-multi-toggle[data-bulk-index="61"]')
        self.act_without_jump('.qz-bp-tick[data-bulk-index="61"][data-opt-index="1"]')
        self.page.locator("#qzBpMissingFirst").click()
        self.page.wait_for_function("""() => {
            const row=document.querySelector('[data-bulk-item="121"]').getBoundingClientRect();
            const list=document.querySelector('#qzAqPreview .qz-preview-list').getBoundingClientRect();
            return row.top >= list.top-2 && row.top < list.bottom;
        }""")
        self.act_without_jump('.qz-bp-answer-select[data-bulk-index="121"]', "select", "1")
        self.page.locator("#qzAddQSubmit").click()
        saved = self.page.evaluate("done")
        self.assertEqual(len(saved), 122)
        self.assertEqual(saved[61]["correct_answer"], [0, 1])
        self.assertTrue(saved[61]["allow_multiple"])
        self.assertEqual(saved[121]["correct_answer"], 1)
        self.assertFalse(any(key.startswith("_") for q in saved for key in q))

    def test_new_import_resets_preview_instead_of_reusing_previous_scroll(self):
        self.act_without_jump('.qz-bp-multi-toggle[data-bulk-index="61"]')
        self.page.locator("#qzAqBulkArea").fill("1. New question?\nA. First\nB. Second\nAnswer: B")
        self.page.locator("#qzAqParse").click()
        self.assertEqual(self.page.locator("[data-bulk-item]").count(), 1)
        self.assertEqual(self.page.locator("#qzAqPreview .qz-preview-list").evaluate("el => el.scrollTop"), 0)

    def test_tablet_and_phone_layouts_preserve_position(self):
        for width in (1280, 768, 390):
            with self.subTest(width=width):
                self.page.set_viewport_size({"width": width, "height": 950})
                self.act_without_jump('.qz-bp-multi-toggle[data-bulk-index="61"]')


if __name__ == "__main__":
    unittest.main(verbosity=2)
