import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkIssueList, IncompleteIssueListError, openListed } from "../../src/plan/list-check.ts";
import { ghIssue } from "./fixtures.ts";

/** Open mirrors #12 and #13, closed mirror #14 and open PR #15: 3 open items. */
const LIST = Object.freeze([
  ghIssue(12, "[CUI-3] Task 3"),
  ghIssue(13, "[CUI-5] Task 5"),
  ghIssue(14, "[CUI-6] Task 6", { state: "closed" }),
  ghIssue(15, "Some pull request", { isPullRequest: true, labelNames: [] }),
]);

describe("openListed", () => {
  it("counts open issues and open pull requests, not closed ones", () => {
    assert.equal(openListed(LIST), 3);
  });

  it("counts an issue a shifted page listed twice once", () => {
    assert.equal(openListed([...LIST, ghIssue(13, "[CUI-5] Task 5")]), 3);
  });

  it("is 0 for an empty list", () => {
    assert.equal(openListed([]), 0);
  });
});

describe("checkIssueList (R11)", () => {
  it("accepts a list with exactly the open items the repository reports", () => {
    assert.doesNotThrow(() => {
      checkIssueList(LIST, 3);
    });
  });

  it("accepts a list with more open items: one opened after the list was read", () => {
    assert.doesNotThrow(() => {
      checkIssueList(LIST, 2);
    });
  });

  it("accepts an empty list of an empty repository", () => {
    assert.doesNotThrow(() => {
      checkIssueList([], 0);
    });
  });

  it("refuses a list that misses one open item, naming both counts", () => {
    // Act
    const failure = (() => {
      try {
        checkIssueList(LIST, 4);
      } catch (error) {
        return error;
      }
      return assert.fail("expected checkIssueList to throw");
    })();

    // Assert
    assert.ok(failure instanceof IncompleteIssueListError);
    assert.equal(failure.name, "IncompleteIssueListError");
    assert.equal(failure.listed, 3);
    assert.equal(failure.reported, 4);
    assert.equal(
      failure.message,
      "GitHub issue list is incomplete: it holds 3 open issues and pull requests, the repository reports 4; " +
        "nothing was written, the next run reads it again",
    );
  });

  it("refuses an empty list of a repository with open issues (the 2026-10-22 incident)", () => {
    assert.throws(() => {
      checkIssueList([], 59);
    }, IncompleteIssueListError);
  });

  it("does not count a duplicate listing towards the reported count", () => {
    assert.throws(() => {
      checkIssueList([...LIST, ghIssue(12, "[CUI-3] Task 3")], 4);
    }, IncompleteIssueListError);
  });
});
