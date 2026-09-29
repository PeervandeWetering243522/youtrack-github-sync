import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_EXCLUDE_PREFIX, ENV_KEYS, parseConfig } from "../../src/config.ts";
import {
  ALL_TRIMMED_WHITESPACE,
  ARABIC_INDIC_ONE,
  BOM,
  EXPECTED_CONFIG,
  NBSP,
  OWNER_PROBLEM,
  PREFIX_PROBLEM,
  PROJECT_PROBLEM,
  REPO_PROBLEM,
  REPO_SHAPE_PROBLEM,
  URL_CREDENTIALS_PROBLEM,
  URL_HTTPS_PROBLEM,
  URL_INVALID_PROBLEM,
  URL_QUERY_PROBLEM,
  VALID_ENV,
  ZERO_WIDTH_SPACE,
  captureConfigError,
  char,
  envWith,
  fullwidth,
  problemsFor,
  visible,
} from "./fixtures.ts";

describe("parseConfig: GITHUB_REPO", () => {
  const accepted: readonly (readonly [string, string, string])[] = [
    ["a/b", "a", "b"],
    ["Owner-1/repo.name_x-y", "Owner-1", "repo.name_x-y"],
    ["9lives/.github", "9lives", ".github"],
    ["owner/...", "owner", "..."],
    [`${"a".repeat(39)}/repo`, "a".repeat(39), "repo"],
    [`owner/${"r".repeat(100)}`, "owner", "r".repeat(100)],
  ];
  for (const [value, owner, repo] of accepted) {
    it(`splits "${value.slice(0, 40)}" into owner and repo`, () => {
      const config = parseConfig(envWith({ GITHUB_REPO: value }));

      assert.equal(config.githubOwner, owner);
      assert.equal(config.githubRepo, repo);
    });
  }

  it("accepts every owner the spec regex allows, including trailing and doubled hyphens", () => {
    for (const owner of ["a-", "a--b", "0", `9${"-".repeat(38)}`]) {
      const config = parseConfig(envWith({ GITHUB_REPO: `${owner}/repo` }));

      assert.equal(config.githubOwner, owner, owner);
    }
  });

  it('rejects only the exact repository names "." and ".."', () => {
    for (const repo of [".git", "..a", "a..b", "a."]) {
      const config = parseConfig(envWith({ GITHUB_REPO: `owner/${repo}` }));

      assert.equal(config.githubRepo, repo, repo);
    }
  });

  it("reports GITHUB_REPO as missing when absent or blank", () => {
    assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: undefined })), ["GITHUB_REPO is missing"]);
    assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: "  " })), ["GITHUB_REPO is missing"]);
  });

  it('rejects values that are not exactly "owner/repo"', () => {
    for (const value of ["owner", "owner/repo/extra", "owner/repo/", "owner//repo", "https://github.com/owner/repo"]) {
      assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: value })), [REPO_SHAPE_PROBLEM], value);
    }
  });

  it('requires an ASCII "/" separator; look-alike slashes are a shape error', () => {
    for (const value of [`owner${char(0x2215)}repo`, `owner${fullwidth("/")}repo`, "owner\\repo"]) {
      assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: value })), [REPO_SHAPE_PROBLEM], visible(value));
    }
  });

  it("rejects invalid owner names", () => {
    for (const owner of ["", "-owner", "own_er", "own.er", "own er", "a".repeat(40)]) {
      assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: `${owner}/repo` })), [OWNER_PROBLEM], owner);
    }
  });

  it("rejects invalid repository names", () => {
    for (const repo of ["", ".", "..", "re po", "repo!", "r".repeat(101)]) {
      assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: `owner/${repo}` })), [REPO_PROBLEM], repo);
    }
  });

  it("rejects non-ASCII, multi-line and space-padded parts (the patterns anchor each whole part)", () => {
    const cases: readonly (readonly [string, readonly string[]])[] = [
      [`${char(0x00f3)}wner/repo`, [OWNER_PROBLEM]],
      [`${fullwidth("o")}wner/repo`, [OWNER_PROBLEM]],
      [`own${ZERO_WIDTH_SPACE}er/repo`, [OWNER_PROBLEM]],
      ["owner\n/repo", [OWNER_PROBLEM]],
      ["owner\nevil/repo", [OWNER_PROBLEM]],
      [`owner/r${char(0x00e9)}po`, [REPO_PROBLEM]],
      [`owner/${ARABIC_INDIC_ONE}`, [REPO_PROBLEM]],
      ["owner/repo\nevil", [REPO_PROBLEM]],
      [`owner/repo${char(0)}`, [REPO_PROBLEM]],
      ["owner / repo", [OWNER_PROBLEM, REPO_PROBLEM]],
      ["/", [OWNER_PROBLEM, REPO_PROBLEM]],
    ];
    for (const [value, expected] of cases) {
      assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: value })), expected, visible(value));
    }
  });

  it("reports both owner and repository problems at once", () => {
    const problems = problemsFor(envWith({ GITHUB_REPO: "-bad/.." }));

    assert.deepEqual(problems, [OWNER_PROBLEM, REPO_PROBLEM]);
  });
});

describe("parseConfig: YOUTRACK_BASE_URL", () => {
  const normalized: readonly (readonly [string, string])[] = [
    ["https://youtrack.ai.buas.nl/", "https://youtrack.ai.buas.nl"],
    ["https://youtrack.ai.buas.nl///", "https://youtrack.ai.buas.nl"],
    ["https://example.com/youtrack/", "https://example.com/youtrack"],
    ["https://example.com/youtrack//", "https://example.com/youtrack"],
    ["HTTPS://YouTrack.Example.COM", "https://youtrack.example.com"],
    ["https://example.com:443/", "https://example.com"],
    ["https://example.com:8443/yt", "https://example.com:8443/yt"],
    // Encoded "?", "#" and "/" are path characters: kept as they are, never read as a query or stripped.
    ["https://example.com/yt%3F", "https://example.com/yt%3F"],
    ["https://example.com/%23/", "https://example.com/%23"],
    ["https://example.com/yt%2F", "https://example.com/yt%2F"],
    // "@" in the path is not userinfo.
    ["https://example.com/@user/", "https://example.com/@user"],
  ];
  for (const [value, expected] of normalized) {
    it(`normalizes "${value}" to "${expected}"`, () => {
      const config = parseConfig(envWith({ YOUTRACK_BASE_URL: value }));

      assert.equal(config.youtrackBaseUrl, expected);
    });
  }

  // Lenient WHATWG inputs: the result is always canonical origin + path, and
  // feeding it back in yields the same value.
  const canonical: readonly (readonly [string, string])[] = [
    ["https:example.com", "https://example.com"],
    ["https:\\\\example.com\\yt\\", "https://example.com/yt"],
    ["https://@example.com", "https://example.com"],
    ["https://:@example.com/", "https://example.com"],
    [`https://b${char(0x00fc)}cher.example/`, "https://xn--bcher-kva.example"],
    [`https://${fullwidth("example")}.com`, "https://example.com"],
    ["https://example.com/a/../b/", "https://example.com/b"],
    ["https://example.com/%2e%2e/yt/./", "https://example.com/yt"],
    ["https://example.com/you track/", "https://example.com/you%20track"],
    ["https://Example.com/Path/", "https://example.com/Path"],
    ["https://[::1]:8443/", "https://[::1]:8443"],
    ["https://exa\tmple.com/y\nt/", "https://example.com/yt"],
  ];
  for (const [value, expected] of canonical) {
    it(`canonicalizes "${visible(value)}" to "${expected}", idempotently`, () => {
      const once = parseConfig(envWith({ YOUTRACK_BASE_URL: value })).youtrackBaseUrl;
      const twice = parseConfig(envWith({ YOUTRACK_BASE_URL: once })).youtrackBaseUrl;

      assert.equal(once, expected);
      assert.equal(twice, once);
    });
  }

  it("reports YOUTRACK_BASE_URL as missing when absent or blank", () => {
    assert.deepEqual(problemsFor(envWith({ YOUTRACK_BASE_URL: undefined })), ["YOUTRACK_BASE_URL is missing"]);
    assert.deepEqual(problemsFor(envWith({ YOUTRACK_BASE_URL: " " })), ["YOUTRACK_BASE_URL is missing"]);
  });

  it("rejects values the WHATWG parser refuses (relative, no host, bad port, bad host)", () => {
    const values = ["youtrack.ai.buas.nl", "/api", "https://", "https://exa mple.com", "https://example.com:99999"];
    for (const value of [...values, "https://example.com:443:443", "https://xn--/", "https://[::1", "https://user@"]) {
      assert.deepEqual(problemsFor(envWith({ YOUTRACK_BASE_URL: value })), [URL_INVALID_PROBLEM], value);
    }
  });

  it("rejects every protocol other than https, including an upper-case http and look-alikes", () => {
    const values = [
      "http://youtrack.ai.buas.nl",
      "HTTP://example.com",
      "ftp://youtrack.ai.buas.nl",
      "file:///etc/passwd",
    ];
    for (const value of [...values, "wss://example.com", "blob:https://example.com/x"]) {
      assert.deepEqual(problemsFor(envWith({ YOUTRACK_BASE_URL: value })), [URL_HTTPS_PROBLEM], value);
    }
  });

  it("rejects query strings and fragments, including empty ones, wherever the parser finds them", () => {
    const values = [
      "https://example.com/?a=1",
      "https://example.com/#top",
      "https://example.com?",
      "https://example.com#",
    ];
    for (const value of [
      ...values,
      "https://example.com\\?x",
      "https://example.com/yt?#",
      "https://example.com/yt/#?a",
    ]) {
      assert.deepEqual(problemsFor(envWith({ YOUTRACK_BASE_URL: value })), [URL_QUERY_PROBLEM], value);
    }
  });

  it("rejects credentials, even with one half empty or percent-encoded, without echoing them", () => {
    const secrets = ["https://user:hunter2secret@example.com", "https://:hunter2secret@example.com"];
    const values = [
      "https://user@example.com",
      "https://user:@example.com",
      "https://%40@example.com",
      "https://:p@example.com/yt/",
    ];
    for (const value of [...secrets, ...values]) {
      const error = captureConfigError(envWith({ YOUTRACK_BASE_URL: value }));

      assert.deepEqual(error.problems, [URL_CREDENTIALS_PROBLEM], value);
      assert.equal(error.message.includes("hunter2secret"), false);
    }
  });

  it("reports every URL problem at once", () => {
    const problems = problemsFor(envWith({ YOUTRACK_BASE_URL: "http://user:pw@example.com/?q=1#x" }));

    assert.deepEqual(problems, [URL_HTTPS_PROBLEM, URL_QUERY_PROBLEM, URL_CREDENTIALS_PROBLEM]);
  });

  it("keeps the host fixed when a path is appended to the result", () => {
    for (const value of ["https://example.com//evil.com/", "https://example.com\\@evil.com", "https:///evil.com//"]) {
      const base = parseConfig(envWith({ YOUTRACK_BASE_URL: value })).youtrackBaseUrl;

      assert.equal(new URL(`${base}/api/issues`).origin, new URL(value).origin, value);
    }
  });
});

describe("parseConfig: YOUTRACK_PROJECT", () => {
  it("accepts letters, digits, underscores and hyphens", () => {
    const config = parseConfig(envWith({ YOUTRACK_PROJECT: "My_Proj-2" }));

    assert.equal(config.youtrackProject, "My_Proj-2");
  });

  it("accepts one-character and digit-first names, and a trailing or inner '_' or '-'", () => {
    for (const value of ["C", "9", "1CUI", "cui", "CUI-", "CUI_", "C-U_I", "C--I"]) {
      assert.equal(parseConfig(envWith({ YOUTRACK_PROJECT: value })).youtrackProject, value, value);
    }
  });

  it("reports YOUTRACK_PROJECT as missing when absent or blank", () => {
    assert.deepEqual(problemsFor(envWith({ YOUTRACK_PROJECT: undefined })), ["YOUTRACK_PROJECT is missing"]);
    assert.deepEqual(problemsFor(envWith({ YOUTRACK_PROJECT: "" })), ["YOUTRACK_PROJECT is missing"]);
  });

  it("rejects characters that could alter the search query", () => {
    for (const value of ["CUI OTHER", "CUI,OTHER", "{CUI}", "CUI:", "project: CUI", "#CUI", `CU${char(0x00cd)}`]) {
      assert.deepEqual(problemsFor(envWith({ YOUTRACK_PROJECT: value })), [PROJECT_PROBLEM], visible(value));
    }
  });

  it('rejects a leading "-" (YouTrack\'s minus operator) or "_", even after trimming', () => {
    const values = ["-", "--", "-CUI", "--CUI", "-1", "_", "__", "_CUI", "-_", "_-CUI", " -CUI", `${NBSP}_CUI\t`];
    for (const value of values) {
      assert.deepEqual(problemsFor(envWith({ YOUTRACK_PROJECT: value })), [PROJECT_PROBLEM], visible(value));
    }
  });

  it("rejects Unicode look-alikes and embedded invisible characters", () => {
    const values = [fullwidth("CUI"), "C\nUI", `CU${char(0x0406)}`, `CUI${ZERO_WIDTH_SPACE}`, ARABIC_INDIC_ONE];
    for (const value of [...values, `${char(0x2010)}CUI`, `${char(0x2212)}CUI`]) {
      assert.deepEqual(problemsFor(envWith({ YOUTRACK_PROJECT: value })), [PROJECT_PROBLEM], visible(value));
    }
  });
});

describe("parseConfig: YOUTRACK_EXCLUDE_PREFIX (decision F1)", () => {
  it('defaults to "[individual]" when unset', () => {
    const config = parseConfig(envWith({ YOUTRACK_EXCLUDE_PREFIX: undefined }));

    assert.equal(DEFAULT_EXCLUDE_PREFIX, "[individual]");
    assert.equal(config.excludePrefix, "[individual]");
  });

  it("uses a custom prefix, trimmed", () => {
    const config = parseConfig(envWith({ YOUTRACK_EXCLUDE_PREFIX: "  [solo] " }));

    assert.equal(config.excludePrefix, "[solo]");
  });

  it("keeps the prefix's case, inner whitespace and non-ASCII characters (surrogate pairs intact)", () => {
    for (const prefix of [
      "[My Own]",
      "[Individual]  x",
      `${char(0x1f680)} [individual]`,
      `[${char(0x00e9)}quipe]${char(0x1f600)}`,
    ]) {
      const config = parseConfig(envWith({ YOUTRACK_EXCLUDE_PREFIX: `${NBSP}${prefix}\t` }));

      assert.equal(config.excludePrefix, prefix, visible(prefix));
    }
  });

  it("rejects a prefix that is set but empty or whitespace-only (it would exclude every issue)", () => {
    for (const value of ["", "   ", `${NBSP}${BOM}`, ALL_TRIMMED_WHITESPACE]) {
      const problems = problemsFor(envWith({ YOUTRACK_EXCLUDE_PREFIX: value }));

      assert.deepEqual(problems, [PREFIX_PROBLEM], visible(value));
    }
  });

  it("ignores the retired YOUTRACK_TITLE_PREFIX, whatever its value", () => {
    const knownKeys: readonly string[] = ENV_KEYS;
    for (const value of ["[team]", "", " "]) {
      const legacy = { ...VALID_ENV, YOUTRACK_EXCLUDE_PREFIX: undefined, YOUTRACK_TITLE_PREFIX: value };

      const config = parseConfig(legacy);

      assert.deepEqual(config, { ...EXPECTED_CONFIG, excludePrefix: DEFAULT_EXCLUDE_PREFIX }, visible(value));
    }
    assert.equal(knownKeys.includes("YOUTRACK_TITLE_PREFIX"), false);
  });
});
