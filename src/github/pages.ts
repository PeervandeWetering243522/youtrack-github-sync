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

/** The caller's `mayFetchNext` refused a further page, so the list was not read in full. */
export class PageLimitError extends Error {
  constructor(pagesRead: number) {
    super(`GitHub list stopped after ${String(pagesRead)} pages: the caller allows no further page`);
    this.name = "PageLimitError";
  }
}

/**
 * Every item of a paged list, in page order: GETs `firstUrl` and each rel="next" URL
 * verbatim (retry-once), and turns each page body into items with `parsePage`. Before each
 * page after the first it asks `mayFetchNext` (by default always yes).
 * Throws whatever parsePage, nextPageUrl or the client throws, GitHubSchemaError for a
 * rel="next" that loops back to a page already fetched, and PageLimitError when
 * `mayFetchNext` refuses a page.
 */
export async function listAllPages<Item>(
  http: HttpClient,
  target: GitHubTarget,
  firstUrl: string,
  parsePage: (body: JsonValue) => readonly Item[],
  mayFetchNext: () => boolean = () => true,
): Promise<readonly Item[]> {
  const pages: (readonly Item[])[] = [];
  const visited = new Set<string>();
  let url: string | null = firstUrl;
  while (url !== null) {
    if (pages.length > 0 && !mayFetchNext()) {
      throw new PageLimitError(pages.length);
    }
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
