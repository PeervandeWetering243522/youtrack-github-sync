/**
 * The "## Upgrading" section of a PR description (V5): reading it, the `!` rule, and putting it
 * in place of its token in the generated notes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fillUpgrading,
  isBreakingTitle,
  upgradingSection,
  withUpgradingToken,
} from "../../scripts/release/upgrading.ts";

describe("upgradingSection", () => {
  it("is null without a description or without the section", () => {
    assert.equal(upgradingSection(null), null);
    assert.equal(upgradingSection(""), null);
    assert.equal(upgradingSection("Adds a thing.\n\n## Testing\n\nRan it."), null);
  });

  it("returns the section's text, trimmed, up to the next heading of level 1 or 2", () => {
    const body = "Intro.\n\n## Upgrading\n\nAdd `contents: read`.\n\nThen redeploy.\n\n## Test plan\n\n- [x] tests";
    assert.equal(upgradingSection(body), "Add `contents: read`.\n\nThen redeploy.");
  });

  it("runs to the end of the description when no heading follows", () => {
    assert.equal(upgradingSection("## Upgrading\nSet `x`.\n"), "Set `x`.");
  });

  it("keeps level-3 headings and deeper inside the section", () => {
    const body = "## Upgrading\n\n### Worker\n\nRedeploy.\n\n# Notes\n\nnot this";
    assert.equal(upgradingSection(body), "### Worker\n\nRedeploy.");
  });

  it("matches the heading in any case, with trailing spaces or closing hashes", () => {
    assert.equal(upgradingSection("## upgrading  \nA"), "A");
    assert.equal(upgradingSection("## UPGRADING ##\nA"), "A");
    assert.equal(upgradingSection("   ## Upgrading\nA"), "A");
  });

  it("does not take other headings that start with the word", () => {
    assert.equal(upgradingSection("## Upgrading notes\nA"), null);
    assert.equal(upgradingSection("### Upgrading\nA"), null);
    assert.equal(upgradingSection("##Upgrading\nA"), null);
  });

  it("reads CRLF descriptions, as the GitHub web editor saves them", () => {
    assert.equal(
      upgradingSection("Intro.\r\n\r\n## Upgrading\r\n\r\nLine 1.\r\nLine 2.\r\n\r\n## Next\r\n"),
      "Line 1.\nLine 2.",
    );
  });

  it("ignores HTML comments, so the template's untouched section is empty", () => {
    const template = "## Upgrading\n\n<!-- Only for a breaking change.\nLeave it empty otherwise. -->\n";
    assert.equal(upgradingSection(template), null);
    assert.equal(upgradingSection("## Upgrading\n<!-- hint -->\nSet `x`.<!-- more -->"), "Set `x`.");
  });

  it("treats an unclosed comment as running to the end, as GitHub renders it", () => {
    assert.equal(upgradingSection("## Upgrading\nSet `x`.\n<!-- open\n## Next"), "Set `x`.");
  });

  it("does not end the section at a heading-like line inside a code fence", () => {
    const body = "## Upgrading\n\n```yaml\n# a YAML comment\n## another\n```\n\nDone.\n\n## Next";
    assert.equal(upgradingSection(body), "```yaml\n# a YAML comment\n## another\n```\n\nDone.");
    assert.equal(upgradingSection("## Upgrading\n~~~\n# x\n~~~\n# Next"), "~~~\n# x\n~~~");
  });

  it("keeps `<!--` inside a code fence as code", () => {
    assert.equal(
      upgradingSection("## Upgrading\n```sh\n# <!-- x\nrun\n```\nafter"),
      "```sh\n# <!-- x\nrun\n```\nafter",
    );
    assert.equal(upgradingSection("## Upgrading\n```html\n<!-- a -->\n```"), "```html\n<!-- a -->\n```");
  });

  it("still strips a comment that spans lines outside a fence", () => {
    assert.equal(upgradingSection("## Upgrading\nA <!-- one\ntwo --> B\n<!--\n## Next\n-->\nC"), "A  B\n\nC");
  });

  it("closes a fence only with the same character, at least as long", () => {
    const nested = "## Upgrading\n````md\n```\n## Other\n```\n````\nnext\n## End";
    assert.equal(upgradingSection(nested), "````md\n```\n## Other\n```\n````\nnext");
    assert.equal(upgradingSection("## Upgrading\n~~~\n```\n# x\n~~~\ny\n# End"), "~~~\n```\n# x\n~~~\ny");
    assert.equal(
      upgradingSection("## Upgrading\n```\n``` not a close\n# x\n```\n# End"),
      "```\n``` not a close\n# x\n```",
    );
  });

  it("does not take a heading inside a code fence as the section", () => {
    assert.equal(upgradingSection("```md\n## Upgrading\nexample\n```\n"), null);
  });

  it("takes the first section when there are two", () => {
    assert.equal(upgradingSection("## Upgrading\nfirst\n## Upgrading\nsecond"), "first");
  });

  it("keeps lines the commit parser would read as notes or references, verbatim", () => {
    const text = "breaking change in prose.\nBREAKING CHANGE: literal\nCloses #12";
    assert.equal(upgradingSection(`## Upgrading\n${text}`), text);
  });
});

describe("isBreakingTitle", () => {
  it("is true for a `!` before the colon, with or without a scope", () => {
    assert.equal(isBreakingTitle("feat!: drop the YT prefix"), true);
    assert.equal(isBreakingTitle("fix(action)!: rename an input"), true);
  });

  it("is false without the `!` or for a `!` elsewhere", () => {
    assert.equal(isBreakingTitle("feat: add a thing"), false);
    assert.equal(isBreakingTitle("fix(action): stop! now"), false);
    assert.equal(isBreakingTitle("feat!:no space"), false);
    assert.equal(isBreakingTitle('Revert "feat!: x"'), false);
  });

  it("reads only the first line of a commit message", () => {
    assert.equal(isBreakingTitle("feat: a\n\nfeat!: b"), false);
    assert.equal(isBreakingTitle("feat!: a (#8)\n\nbody"), true);
  });
});

describe("withUpgradingToken", () => {
  it("keeps the header and replaces any body with a token footer", () => {
    assert.equal(
      withUpgradingToken("feat!: a (#8)\n\nBREAKING CHANGE: typed in the dialog", 3),
      "feat!: a (#8)\n\nBREAKING CHANGE: UPGRADING-NOTE-3",
    );
    assert.equal(withUpgradingToken("feat!: a (#8)", 0), "feat!: a (#8)\n\nBREAKING CHANGE: UPGRADING-NOTE-0");
  });
});

describe("fillUpgrading", () => {
  it("puts each section in place of its token, indented to stay in its bullet", () => {
    const notes = "### ⚠ BREAKING CHANGES\n\n* UPGRADING-NOTE-1\n* **action:** UPGRADING-NOTE-10\n";
    const sections = new Map([
      [1, "First line.\n\n- step\n\n```yaml\nx: 1\n```"],
      [10, "Other."],
    ]);
    assert.equal(
      fillUpgrading(notes, sections),
      "### ⚠ BREAKING CHANGES\n\n* First line.\n\n  - step\n\n  ```yaml\n  x: 1\n  ```\n* **action:** Other.\n",
    );
  });

  it("inserts `$` sequences literally", () => {
    assert.equal(fillUpgrading("* UPGRADING-NOTE-0", new Map([[0, "Use $& and $1."]])), "* Use $& and $1.");
  });

  it("leaves a token without a section as it is", () => {
    assert.equal(fillUpgrading("* UPGRADING-NOTE-2", new Map()), "* UPGRADING-NOTE-2");
  });
});
