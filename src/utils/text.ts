/**
 * UTF-16 text helpers: cutting a string without splitting a surrogate pair, and
 * looking up offsets in an ascending list of string offsets. Pure, no I/O.
 */

/** First `maxLength` UTF-16 units of `text`, without leaving a lone high surrogate. */
export function cutUtf16(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const end = Math.max(0, maxLength);
  const last = text.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, end - 1) : text.slice(0, end);
}

/** How many of the ascending `values` are below `limit` (binary search). */
export function countBelow(values: readonly number[], limit: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] ?? limit) < limit) low = middle + 1;
    else high = middle;
  }
  return low;
}
