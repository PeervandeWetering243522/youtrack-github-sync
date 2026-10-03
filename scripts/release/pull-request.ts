/**
 * Reads the PR a commit on main was squash-merged from, for its description (GitHub's "List
 * pull requests associated with a commit"). Used at release time only, with the release job's
 * token, which needs `pull-requests: read`.
 */

import { isInteger, isJsonArray, isJsonObject, isString, parseJson } from "../../src/json.ts";

export type GitHubTarget = { readonly apiUrl: string; readonly repository: string; readonly token: string };
export type MergedPullRequest = { readonly number: number; readonly body: string | null };

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const TIMEOUT_MS = 15_000;

/** The repository, token and API URL from the GitHub Actions env. Throws when one is missing. */
export function gitHubTarget(env: Readonly<Record<string, string | undefined>>): GitHubTarget {
  const repository = env["GITHUB_REPOSITORY"] ?? "";
  if (!REPOSITORY.test(repository)) throw new Error("GITHUB_REPOSITORY must be set to <owner>/<repo>.");
  const token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"] ?? "";
  if (token === "") throw new Error("GITHUB_TOKEN must be set to read the released pull requests.");
  return { apiUrl: env["GITHUB_API_URL"] ?? "https://api.github.com", repository, token };
}

/** The PR whose squash commit `sha` is, or null when no PR was merged as that commit. */
export async function mergedPullRequest(
  target: GitHubTarget,
  sha: string,
  fetchFn: typeof fetch = fetch,
): Promise<MergedPullRequest | null> {
  if (!SHA.test(sha)) throw new Error("Expected a full commit SHA.");
  const short = sha.slice(0, 7);
  const response = await fetchFn(`${target.apiUrl}/repos/${target.repository}/commits/${sha}/pulls?per_page=100`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${target.token}`,
      "User-Agent": "youtrack-gh-release",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${String(response.status)} for the pull requests of commit ${short}.`);
  }
  const list = parseJson(await response.text());
  if (!isJsonArray(list)) throw new Error(`GitHub's answer for commit ${short} is not a list of pull requests.`);
  for (const item of list) {
    if (!isJsonObject(item)) throw new Error(`GitHub sent an unexpected pull request for commit ${short}.`);
    const { number, body } = item;
    if (!isInteger(number) || !(isString(body) || body === null)) {
      throw new Error(`GitHub sent an unexpected pull request for commit ${short}.`);
    }
    if (item["merge_commit_sha"] === sha) return { number, body };
  }
  return null;
}
