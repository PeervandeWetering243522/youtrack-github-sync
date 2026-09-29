/**
 * Paged GitHub list reads (issues, milestones): GET the first page, then every Link
 * rel="next" page that nextPageUrl accepts, until a page has none. Any failure fails the
 * whole list: a truncated list would hide existing mirrors and make sync create duplicates.
 */

import type { HttpClient } from "../http.ts";
import type { JsonValue } from "../json.ts";
import { GitHubSchemaError, githubRequest } from "./client.ts";
import type { GitHubTarget } from "./client.ts";
import { nextPageUrl } from "./link.ts";

/**
 * Every item of a paged list, in page order: GETs `firstUrl` and each rel="next" URL
 * verbatim (retry-once), and turns each page body into items with `parsePage`.
 * Throws whatever parsePage, nextPageUrl or the client throws, and GitHubSchemaError
 * for a rel="next" that loops back to a page already fetched.
 */
export async function listAllPages<Item>(
  http: HttpClient,
  target: GitHubTarget,
  firstUrl: string,
  parsePage: (body: JsonValue) => readonly Item[],
): Promise<readonly Item[]> {
  const pages: (readonly Item[])[] = [];
  const visited = new Set<string>();
  let url: string | null = firstUrl;
  while (url !== null) {
    if (visited.has(url)) {
      throw new GitHubSchemaError(`GitHub Link rel="next" loops back to an already fetched page: ${url}`);
    }
    visited.add(url);
    const response = await http.request(githubRequest(target, "GET", url, "retry-once"));
    pages.push(parsePage(response.body));
    url = nextPageUrl(response.headers.get("link"));
  }
  // flat(), not push(...page): spreading a huge page as arguments overflows the stack.
  return pages.flat();
}
