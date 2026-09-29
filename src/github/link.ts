/**
 * RFC 8288 Link header parsing for GitHub pagination: nextPageUrl returns a rel="next" URL
 * only when it points to https://api.github.com/, so the token never leaves GitHub.
 */

import { GITHUB_API_BASE, GitHubSchemaError, quote } from "./client.ts";

/** Followed Link targets must use this exact spelling (no case/port/dot/%-encoded variants), so the token stays on GitHub. */
const TRUSTED_LINK_PREFIX = `${GITHUB_API_BASE}/`;

/**
 * The URL of the first rel="next" link in a Link header, verbatim; null (last page) only
 * when there is none. listAllPages (pages.ts) calls this for every page of the issue and
 * milestone lists. Throws GitHubSchemaError,
 * because stopping would truncate the list, hide existing mirrors and create duplicates:
 * - when the rel="next" URL is not spelled "https://api.github.com/..." or does not parse
 *   to that origin without userinfo (never send our token to another host);
 * - when there is no rel="next" link but the header does not parse as RFC 8288 (e.g. an
 *   unclosed quote or <URL>, which can swallow the next entry).
 * Error messages quote at most 40 characters, with anything that could be userinfo hidden.
 */
export function nextPageUrl(linkHeader: string | null): string | null {
  if (linkHeader === null) {
    return null;
  }
  const { links, isWellFormed } = parseLinkHeader(linkHeader);
  const next = links.find((link) => link.rels.includes("next"));
  if (next === undefined) {
    if (!isWellFormed) {
      throw new GitHubSchemaError(`GitHub Link header does not parse and has no rel="next": ${quoteLink(linkHeader)}`);
    }
    return null;
  }
  if (!isTrustedUrl(next.url)) {
    throw new GitHubSchemaError(`GitHub Link rel="next" points outside ${TRUSTED_LINK_PREFIX}: ${quoteLink(next.url)}`);
  }
  return next.url;
}

type LinkValue = { readonly url: string; readonly rels: readonly string[] };
type ParsedLinkHeader = { readonly links: readonly LinkValue[]; readonly isWellFormed: boolean };
type ParsedLinkEntry = { readonly link: LinkValue | null; readonly isWellFormed: boolean };

/** RFC 8288 link-param: token BWS [ "=" BWS ( token / quoted-string ) ], with optional whitespace around it. */
const LINK_PARAM_PATTERN =
  /^[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]*(?:=[ \t]*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[^"\\]|\\.)*"))?[ \t]*$/s;

/** Needs the exact prefix, and fetch()'s WHATWG parse must then give exactly the API origin with no userinfo. */
function isTrustedUrl(url: string): boolean {
  const parsed = url.startsWith(TRUSTED_LINK_PREFIX) ? URL.parse(url) : null;
  return parsed?.origin === GITHUB_API_BASE && parsed.username === "" && parsed.password === "";
}

/** quote() of Link text with anything that could be userinfo replaced first, so a cut cannot leave half a secret. */
function quoteLink(text: string): string {
  return quote(hideUserinfo(text));
}

/**
 * Replaces everything before the last "@" of each run between "/", "?" and "#" with "***"
 * (userinfo ends at the last "@" of the authority). Over-hides rather than under-hides. Linear time.
 */
function hideUserinfo(text: string): string {
  return text
    .split(/([/?#])/)
    .map((part) => {
      const at = part.lastIndexOf("@");
      return at < 0 ? part : `***${part.slice(at)}`;
    })
    .join("");
}

/** All entries that start with <URL>, and whether every non-empty entry is well-formed RFC 8288. */
function parseLinkHeader(linkHeader: string): ParsedLinkHeader {
  const entries = splitLinkHeader(linkHeader, ",")
    .filter((entry) => !isBlank(entry))
    .map(parseLinkEntry);
  return {
    links: entries.flatMap((entry) => (entry.link === null ? [] : [entry.link])),
    isWellFormed: entries.every((entry) => entry.isWellFormed),
  };
}

function isBlank(text: string): boolean {
  return /^[ \t]*$/.test(text);
}

/**
 * Where the splitter is inside one part: "start" (only whitespace so far), "plain",
 * "value" (right after "=" and optional whitespace), "url" (<...>), "quoted" ("..."),
 * "escaped" (after a backslash inside quotes).
 */
type SplitState = "start" | "plain" | "value" | "url" | "quoted" | "escaped";

/**
 * Splits on `separator` outside <URL> and quoted values, so commas and semicolons in
 * them are kept. As in RFC 8288, "<" opens a URL only at the start of a part and '"'
 * opens a quoted string only right after "=". Elsewhere they are plain characters, so
 * one malformed entry cannot swallow the entries after it. Linear time.
 */
function splitLinkHeader(text: string, separator: "," | ";"): readonly string[] {
  const parts: string[] = [];
  let current = "";
  let state: SplitState = "start";
  for (const char of text) {
    if (char === separator && (state === "start" || state === "plain" || state === "value")) {
      parts.push(current);
      current = "";
      state = "start";
    } else {
      current += char;
      state = nextSplitState(state, char);
    }
  }
  parts.push(current);
  return parts;
}

function nextSplitState(state: SplitState, char: string): SplitState {
  switch (state) {
    case "url":
      return char === ">" ? "plain" : "url";
    case "quoted":
      if (char === "\\") {
        return "escaped";
      }
      return char === '"' ? "plain" : "quoted";
    case "escaped":
      return "quoted";
    case "start":
      return char === "<" ? "url" : unquotedState(state, char);
    case "value":
      return char === '"' ? "quoted" : unquotedState(state, char);
    case "plain":
      return unquotedState(state, char);
  }
}

/** Outside <...> and "...": "=" starts a value, whitespace keeps start/value, anything else is plain. */
function unquotedState(state: "start" | "value" | "plain", char: string): SplitState {
  if (char === "=") {
    return "value";
  }
  const isWhitespace = char === " " || char === "\t";
  return isWhitespace && state !== "plain" ? state : "plain";
}

/**
 * `<url>; rel="next last"; foo=bar` -> { url, rels: ["next", "last"] }; link is null when the
 * entry does not start with <URL>. Well-formed: nothing but whitespace between ">" and the
 * first ";", and every param empty or matching LINK_PARAM_PATTERN.
 */
function parseLinkEntry(text: string): ParsedLinkEntry {
  const match = /^[ \t]*<([^>]*)>(.*)$/s.exec(text);
  if (match === null) {
    return { link: null, isWellFormed: false };
  }
  const [, url = "", rest = ""] = match;
  const [head = "", ...params] = splitLinkHeader(rest, ";");
  return {
    link: { url: url.trim(), rels: parseRelTypes([head, ...params]) },
    isWellFormed: isBlank(head) && params.every((param) => isBlank(param) || LINK_PARAM_PATTERN.test(param)),
  };
}

/**
 * Relation types of the first `rel` param, lowercased. RFC 8288: later ones are
 * ignored, even when the first has no value (`rel; rel="next"` has no relation types).
 */
function parseRelTypes(params: readonly string[]): readonly string[] {
  for (const param of params) {
    const equals = param.indexOf("=");
    const name = equals >= 0 ? param.slice(0, equals) : param;
    if (name.trim().toLowerCase() === "rel") {
      const relValue = equals >= 0 ? unquote(param.slice(equals + 1).trim()) : "";
      return relValue
        .toLowerCase()
        .split(/\s+/)
        .filter((rel) => rel !== "");
    }
  }
  return [];
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/gs, "$1");
  }
  return value;
}
