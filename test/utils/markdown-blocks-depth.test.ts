/**
 * Block classification (src/utils/markdown-blocks.ts) with deep container nesting:
 * a line costs time for its own characters, not for the nesting depth (finding 6),
 * and the classification is the one the earlier, quadratic version produced.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { neutraliseReferences } from "../../src/mirror.ts";
import { EMPTY_STATE, blockCloser, classifyLine } from "../../src/utils/markdown-blocks.ts";
import type { BlockState, ClassifiedLine } from "../../src/utils/markdown-blocks.ts";

/** Generous, so a slow machine does not flake: each case takes a few ms, the quadratic version took 0.5-8 s. */
const TIME_BUDGET_MS = 500;

describe("block parsing with deep nesting", () => {
  const quotes = "> ".repeat(5_000);
  const cases: readonly (readonly [name: string, markdown: string, expected: string])[] = [
    ["30,000 nested block quotes", `${">".repeat(30_000)} @a`, `${">".repeat(30_000)} \`@a\``],
    ["10,000 nested list items", `${"- ".repeat(10_000)}@a`, `${"- ".repeat(10_000)}\`@a\``],
    ["10,000 nested ordered list items", `${"1. ".repeat(10_000)}@a`, `${"1. ".repeat(10_000)}\`@a\``],
    ["5,000 nested quote and list item pairs", `${"> - ".repeat(5_000)}@a`, `${"> - ".repeat(5_000)}\`@a\``],
    [
      "30,000 blank lines after 5,000 nested list items",
      `${"- ".repeat(5_000)}x${"\n".repeat(30_000)}@a`,
      `${"- ".repeat(5_000)}x${"\n".repeat(30_000)}\`@a\``,
    ],
    [
      "10,000 quote-only lines around 5,000 nested list items",
      `> ${"- ".repeat(5_000)}x\n${"> \n".repeat(10_000)}> @a`,
      `> ${"- ".repeat(5_000)}x\n${"> \n".repeat(10_000)}> \`@a\``,
    ],
    [
      "long indented lines inside 3,000 nested list items",
      `${"- ".repeat(3_000)}x\n${`${" ".repeat(6_000)}@y\n`.repeat(5)}\n${" ".repeat(6_004)}@code`,
      `${"- ".repeat(3_000)}x\n${`${" ".repeat(6_000)}\`@y\`\n`.repeat(5)}\n${" ".repeat(6_004)}@code`,
    ],
    [
      "a fence inside 5,000 nested block quotes",
      `${quotes}\`\`\`\n${quotes}@code\n${quotes}\`\`\`\n@a`,
      `${quotes}\`\`\`\n${quotes}@code\n${quotes}\`\`\`\n\`@a\``,
    ],
  ];

  for (const [name, markdown, expected] of cases) {
    it(`neutralises ${name} exactly, within ${String(TIME_BUDGET_MS)} ms`, () => {
      const start = performance.now();
      const output = neutraliseReferences(markdown);
      const elapsed = performance.now() - start;
      assert.equal(output, expected);
      assert.ok(elapsed < TIME_BUDGET_MS, `took ${elapsed.toFixed(0)} ms`);
    });
  }
});

// ---------------------------------------------------------------------------
// Classification snapshot: a reproducible corpus of block structures (nesting up
// to 60 deep), classified line by line. The hash was taken from the quadratic
// version (commit 00d9d27) before the linear rewrite.

const CORPUS_SHA256 = "adbc08d8eccb67594554d61578c3fcecfedb247f73ce62ca54ca1552cffbea7a";
const MARKERS = [">", "> ", "- ", "* ", "1. ", "2) ", "-   ", "10. "];
const PREFIXES = [">", "> ", " > ", "- ", "* ", "+ ", "1. ", "2) ", "10. ", "-", "1.", " ", "  ", "   ", "    ", "\t"];
const BODIES = [
  "",
  "",
  "   ",
  "@a",
  "#1",
  "x",
  "a `b",
  "c` d",
  "```",
  "``` js",
  "```a``` @b",
  "~~~",
  "````",
  "# h",
  "## @x",
  "<div>",
  "</div>",
  "<!--",
  "-->",
  "<pre>",
  "</pre>",
  "<custom-tag>",
  "<?php",
  "?>",
  "***",
  "---",
  "===",
  "* * *",
  "- - -",
  "_ _ _",
  "text @c",
  "GH-2",
  "o/r#3",
  "-- -",
  "* * * x",
  "\t- - -",
  "- -",
  "__ _ _ ",
  "*\t*\t*",
];

/** Deterministic PRNG (mulberry32), so the corpus never changes. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Documents that open a path of containers (up to 60 deep) on their first line;
 * later lines continue some of them (sometimes over-indented), may open more, and
 * end in a leaf block start, text or nothing.
 */
function corpus(seed: number, count: number): readonly (readonly string[])[] {
  const random = prng(seed);
  const below = (limit: number): number => Math.floor(random() * limit);
  const pick = (options: readonly string[]): string => options[below(options.length)] ?? "";
  const continuation = (marker: string): string =>
    marker.startsWith(">") ? pick([">", "> ", " > "]) : " ".repeat(marker.length + (random() < 0.1 ? 1 : 0));
  const document = (): readonly string[] => {
    const path = Array.from({ length: random() < 0.2 ? 10 + below(50) : below(5) }, () => pick(MARKERS));
    const line = (): string => {
      const continued = path.slice(0, below(path.length + 1)).map(continuation);
      const opened = Array.from({ length: random() < 0.3 ? below(4) : 0 }, () => pick(PREFIXES));
      return [...continued, ...opened].join("") + pick(BODIES);
    };
    return [path.join("") + pick(BODIES), ...Array.from({ length: below(20) }, line)];
  };
  return Array.from({ length: count }, document);
}

/** Everything the rendering reads from a classification, as text. */
function describeLine(line: ClassifiedLine): string {
  const { kind, joins, state } = line;
  const containers = state.containers.map((c) =>
    c.kind === "quote" ? ">" : `${String(c.padding)}${c.hasContent ? "+" : "."}`,
  );
  const leaf = state.leaf;
  const leafText = leaf === null ? "-" : leaf.kind === "fence" ? `f${leaf.char}${String(leaf.length)}` : leaf.kind;
  const html = leaf?.kind === "html" ? `${leaf.closer}${leaf.end === null ? "" : leaf.end.source}` : "";
  return `${kind}${joins ? "+" : ""}|${containers.join(",")}|${leafText}${html}|${blockCloser(state)}`;
}

/** The indices of the block quotes and empty list items, recomputed from the containers. */
function expectedStops(state: BlockState): readonly number[] {
  return state.containers.flatMap((c, index) => (c.kind === "quote" || !c.hasContent ? [index] : []));
}

describe("block classification snapshot", () => {
  it("classifies a reproducible corpus exactly like the quadratic version did", () => {
    const hash = createHash("sha256");
    for (const document of corpus(6, 4_000)) {
      let state = EMPTY_STATE;
      for (const source of document) {
        const line = classifyLine(state, source);
        assert.deepEqual(line.state.stops, expectedStops(line.state), JSON.stringify(document));
        hash.update(`${describeLine(line)}\n`);
        state = line.state;
      }
      hash.update("\u0000");
    }
    assert.equal(hash.digest("hex"), CORPUS_SHA256);
  });
});
