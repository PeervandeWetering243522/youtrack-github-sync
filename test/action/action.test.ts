/**
 * action.yml (decisions W1-W4): the composite action must pass every config key from an input,
 * keep the config's defaults (dry run on), only warn on a GitHub-hosted runner, and never put
 * an input inside a shell script. The file has a fixed, simple layout, so a line reader is
 * enough; no YAML dependency.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ConfigError,
  DEFAULT_EXCLUDE_PREFIX,
  DEFAULT_MAX_WRITES_PER_RUN,
  DEFAULT_SYNC_ASSIGNEES,
  ENV_KEYS,
  parseConfig,
} from "../../src/config.ts";

const ACTION_URL = new URL("../../action.yml", import.meta.url);
const LINES = readFileSync(ACTION_URL, "utf8").split(/\r?\n/);

type Input = { readonly name: string; readonly required: boolean; readonly default: string | null };

type Step = {
  readonly name: string;
  readonly condition: string | null;
  readonly uses: string | null;
  readonly run: string | null;
  /** env name -> its value expression, verbatim. */
  readonly env: ReadonlyMap<string, string>;
};

/** The value after `key:` on `line`, unquoted, or null when the line is not that key. */
function valueOf(line: string, key: string): string | null {
  const match = new RegExp(`^\\s*(?:- )?${key}: (.*)$`).exec(line);
  if (match === null) return null;
  const value = match[1] ?? "";
  return /^".*"$/.test(value) ? value.slice(1, -1) : value;
}

/** The lines from the one after `start` up to (not including) the next line indented `indent` or less. */
function block(lines: readonly string[], start: number, indent: number): readonly string[] {
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() !== "" && !line.startsWith(" ".repeat(indent + 1)));
  return end === -1 ? rest : rest.slice(0, end);
}

function readInputs(): readonly Input[] {
  const body = block(LINES, LINES.indexOf("inputs:"), 0);
  return body.flatMap((line, position) => {
    const name = /^ {2}([a-z-]+):$/.exec(line)?.[1];
    if (name === undefined) return [];
    const fields = block(body, position, 2);
    const find = (key: string): string | null =>
      fields.map((field) => valueOf(field, key)).find((value) => value !== null) ?? null;
    return [{ name, required: find("required") === "true", default: find("default") }];
  });
}

function readSteps(): readonly Step[] {
  const body = block(LINES, LINES.indexOf("  steps:"), 2);
  const starts = body.flatMap((line, position) => (line.startsWith("    - ") ? [position] : []));
  return starts.map((start, index) => toStep(body.slice(start, starts[index + 1] ?? body.length)));
}

function toStep(lines: readonly string[]): Step {
  const find = (key: string): string | null =>
    lines.map((line) => valueOf(line, key)).find((value) => value !== null) ?? null;
  const runAt = lines.findIndex((line) => valueOf(line, "run") !== null);
  const envAt = lines.findIndex((line) => line === "      env:");
  const envLines = envAt === -1 ? [] : block(lines, envAt, 6);
  const env = new Map(
    envLines.flatMap((line) => {
      const match = /^ {8}([A-Z_]+): (.*)$/.exec(line);
      return match === null ? [] : [[match[1] ?? "", match[2] ?? ""] as const];
    }),
  );
  // The script: the value after `run:` (">-" for a folded one) and its continuation lines.
  const runLines = runAt === -1 ? [] : [valueOf(lines[runAt] ?? "", "run") ?? "", ...block(lines, runAt, 6)];
  const run =
    runAt === -1
      ? null
      : runLines
          .map((line) => line.trim())
          .join("\n")
          .trim();
  return { name: find("name") ?? "", condition: find("if"), uses: find("uses"), run, env };
}

const INPUTS = readInputs();
const STEPS = readSteps();

function input(name: string): Input {
  const found = INPUTS.find((candidate) => candidate.name === name);
  assert.ok(found, `action.yml declares input ${name}`);
  return found;
}

/** An input's declaration lines (description included), joined. */
function inputText(name: string): string {
  const start = LINES.indexOf(`  ${name}:`);
  assert.ok(start !== -1, `action.yml declares input ${name}`);
  return block(LINES, start, 2).join("\n");
}

function step(name: string): Step {
  const found = STEPS.find((candidate) => candidate.name === name);
  assert.ok(found, `action.yml has a step named ${name}`);
  return found;
}

const WARNING_CONDITION = /^runner\.environment == '([a-z-]+)' && github\.event\.repository\.private != false$/;

/**
 * Evaluates the one condition shape the warning step uses:
 * `runner.environment == '<value>' && github.event.repository.private != false`, where
 * `isPrivate` undefined stands for an event payload without the repository (the warning shows).
 */
function shownOn(condition: string | null, environment: string, isPrivate?: boolean): boolean {
  const expected = WARNING_CONDITION.exec(condition ?? "")?.[1];
  assert.ok(expected !== undefined, `condition ${String(condition)} has the expected shape`);
  return environment === expected && isPrivate !== false;
}

const SYNC_STEP = "Sync YouTrack to GitHub";
const WARNING_STEP = "Recommend a self-hosted runner";

/** The required config keys with valid made-up values, so one input's default can be checked alone. */
const REQUIRED_ENV = {
  GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  GITHUB_REPO: "acme/mirror",
  YOUTRACK_BASE_URL: "https://youtrack.example.test",
  YOUTRACK_TOKEN: "perm:abc.def.ghi",
  YOUTRACK_PROJECT: "ABC",
} as const;

describe("action.yml: inputs", () => {
  it("passes every config key to the sync step from a declared input, and nothing else", () => {
    const { env } = step(SYNC_STEP);

    assert.deepEqual([...env.keys()].sort(), [...ENV_KEYS].sort());
    for (const [key, value] of env) {
      const name = /^\$\{\{ inputs\.([a-z-]+) \}\}$/.exec(value)?.[1];
      assert.ok(name !== undefined, `${key} comes straight from an input, got ${value}`);
      input(name);
    }
  });

  it("requires the YouTrack token, URL and project, which have no defaults", () => {
    const required = INPUTS.filter((candidate) => candidate.required).map((candidate) => candidate.name);

    assert.deepEqual(required, ["youtrack-token", "youtrack-base-url", "youtrack-project"]);
    for (const name of required) assert.equal(input(name).default, null);
  });

  it("defaults to the job's own token and repository", () => {
    assert.equal(input("github-token").default, "${{ github.token }}");
    assert.equal(input("github-repo").default, "${{ github.repository }}");
  });

  it("keeps the config's defaults for the exclude prefix and the write cap", () => {
    assert.equal(input("youtrack-exclude-prefix").default, DEFAULT_EXCLUDE_PREFIX);
    assert.equal(input("max-writes-per-run").default, String(DEFAULT_MAX_WRITES_PER_RUN));
  });

  it("is a dry run unless the workflow sets dry-run to false", () => {
    const dryRun = input("dry-run").default;

    assert.equal(dryRun, "true");
    assert.equal(parseConfig({ ...REQUIRED_ENV, DRY_RUN: dryRun }).dryRun, true);
  });

  it("reopens closes by the default token's bot, github-actions[bot], unless the workflow changes reopen-closed-by (R10)", () => {
    const reopen = input("reopen-closed-by");

    assert.equal(reopen.required, false);
    assert.equal(reopen.default, "github-actions[bot]");
    assert.equal(
      parseConfig({ ...REQUIRED_ENV, REOPEN_CLOSED_BY: reopen.default }).reopenClosedBy,
      "github-actions[bot]",
    );
  });

  it("turns reopening off when the workflow sets reopen-closed-by to an empty string", () => {
    // GitHub passes an input set to "" as an empty env value, which the config reads as off.
    assert.equal(parseConfig({ ...REQUIRED_ENV, REOPEN_CLOSED_BY: "" }).reopenClosedBy, null);
  });

  it("syncs assignees unless the workflow sets sync-assignees to false (U1)", () => {
    const sync = input("sync-assignees");

    assert.equal(sync.required, false);
    assert.equal(sync.default, "true");
    assert.equal(sync.default, String(DEFAULT_SYNC_ASSIGNEES));
    assert.equal(parseConfig({ ...REQUIRED_ENV, SYNC_ASSIGNEES: sync.default }).syncAssignees, true);
    assert.equal(parseConfig({ ...REQUIRED_ENV, SYNC_ASSIGNEES: "false" }).syncAssignees, false);
  });

  it("fails the run when the workflow sets sync-assignees to an empty string", () => {
    assert.throws(
      () => parseConfig({ ...REQUIRED_ENV, SYNC_ASSIGNEES: "" }),
      (error) => error instanceof ConfigError && error.problems.join() === 'SYNC_ASSIGNEES must be "true" or "false"',
    );
  });

  it("has no assignee map unless the workflow passes assignee-map, which it takes from a secret (U14)", () => {
    const map = input("assignee-map");

    assert.equal(map.required, false);
    assert.equal(map.default, "");
    assert.equal(parseConfig({ ...REQUIRED_ENV, ASSIGNEE_MAP: map.default }).assigneeMap.size, 0);
    assert.match(inputText("assignee-map"), /\bsecret\b/);
  });
});

describe("action.yml: steps", () => {
  it("warns first, before Node is set up or any token is passed", () => {
    assert.equal(STEPS[0]?.name, WARNING_STEP);
    assert.equal(step(WARNING_STEP).env.size, 0);
  });

  it("shows the self-hosted recommendation on a GitHub-hosted runner of a repo not known to be public", () => {
    const { condition } = step(WARNING_STEP);

    assert.equal(shownOn(condition, "github-hosted", true), true);
    assert.equal(shownOn(condition, "github-hosted"), true, "no repository in the event payload");
    assert.equal(shownOn(condition, "github-hosted", false), false, "public repos run free");
    assert.equal(shownOn(condition, "self-hosted", true), false);
  });

  it("only warns on a GitHub-hosted runner and never stops the run (decision W3)", () => {
    const run = step(WARNING_STEP).run ?? "";

    assert.match(run, /echo "::warning title=[^:]+::[^"]*self-hosted runner[^"]*"/);
    assert.doesNotMatch(run, /\bexit\b/);
  });

  it("never puts an expression inside a shell script, so no input runs as shell code", () => {
    for (const { name, run } of STEPS) {
      if (run !== null) assert.doesNotMatch(run, /\$\{\{/, `step ${name}`);
    }
  });

  it("pins every action it uses to a full commit SHA", () => {
    const uses = STEPS.flatMap((candidate) => (candidate.uses === null ? [] : [candidate.uses]));

    assert.ok(uses.length > 0);
    for (const reference of uses) assert.match(reference, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it("runs the Node entrypoint from the action's own checkout", () => {
    assert.equal(step(SYNC_STEP).run, 'node "$GITHUB_ACTION_PATH/src/node.ts"');
    assert.ok(existsSync(new URL("../../src/node.ts", import.meta.url)));
  });
});
