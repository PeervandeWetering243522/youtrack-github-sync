import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FIXED_NOW_MS, inTimeZone, MAX_RETRY_AFTER_MS, RETRY_DELAY_MS, runRetryAfter } from "./http-harness.ts";

describe("createHttpClient: retry-after parsing", () => {
  it("waits exactly maxRetryAfterMs when retry-after equals the cap", async () => {
    assert.deepEqual(await runRetryAfter("10"), { waits: [MAX_RETRY_AFTER_MS], fetches: 2 });
  });

  it("retries immediately for retry-after 0", async () => {
    assert.deepEqual(await runRetryAfter("0"), { waits: [0], fetches: 2 });
  });

  it("does not retry for an absurdly large delta-seconds value", async () => {
    assert.deepEqual(await runRetryAfter("99999999999999999999"), { waits: [], fetches: 1 });
  });

  it("parses an obsolete rfc850 date", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);

    assert.deepEqual(await runRetryAfter("Friday, 25-Sep-26 10:00:07 GMT"), { waits: [7_000], fetches: 2 });
  });

  it("reads an rfc850 two-digit year more than 50 years ahead as the previous century", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);

    // 2076 is exactly 50 years ahead (far future: no retry); 77 means 1977 (past: retry now).
    assert.deepEqual(await runRetryAfter("Friday, 25-Sep-76 10:00:00 GMT"), { waits: [], fetches: 1 });
    assert.deepEqual(await runRetryAfter("Saturday, 25-Sep-77 10:00:00 GMT"), { waits: [0], fetches: 2 });
  });

  it("reads an rfc850 date even one second more than 50 years ahead as the previous century", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);

    // 2076-09-25T10:00:01Z is 50 years and 1 s ahead, so RFC 9110 makes it 1976 (past: retry now).
    assert.deepEqual(await runRetryAfter("Friday, 25-Sep-76 10:00:01 GMT"), { waits: [0], fetches: 2 });
  });

  it("reads an rfc850 two-digit year as the next century when that is within 50 years", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2080-06-01T00:00:00Z"));

    // In 2080, "10" is 2110 (30 years ahead: far future, no retry), not 2010 (past: retry now).
    assert.deepEqual(await runRetryAfter("Sunday, 01-Jun-10 00:00:00 GMT"), { waits: [], fetches: 1 });
  });

  it("reads an rfc850 date across a century rollover", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2099-12-31T23:59:58Z"));

    assert.deepEqual(await runRetryAfter("Friday, 01-Jan-00 00:00:03 GMT"), { waits: [5_000], fetches: 2 });
  });

  it("parses an obsolete asctime date as UTC regardless of the local time zone", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);

    await inTimeZone("Pacific/Kiritimati", async () => {
      assert.equal(new Date(FIXED_NOW_MS).getTimezoneOffset(), -14 * 60, "time zone switch did not apply");
      assert.deepEqual(await runRetryAfter("Fri Sep 25 10:00:03 2026"), { waits: [3_000], fetches: 2 });
    });
  });

  it("parses an asctime date with a space-padded day", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-09-05T10:00:00Z"));

    assert.deepEqual(await runRetryAfter("Sat Sep  5 10:00:04 2026"), { waits: [4_000], fetches: 2 });
  });

  it("accepts a leap second", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-09-25T23:59:55Z"));

    assert.deepEqual(await runRetryAfter("Fri, 25 Sep 2026 23:59:60 GMT"), { waits: [5_000], fetches: 2 });
  });

  it("accepts 29 February in a leap year", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2028-02-29T10:00:00Z"));

    assert.deepEqual(await runRetryAfter("Tue, 29 Feb 2028 10:00:03 GMT"), { waits: [3_000], fetches: 2 });
  });

  it("does not retry when the HTTP-date is further away than maxRetryAfterMs", async (t) => {
    t.mock.method(Date, "now", () => FIXED_NOW_MS);

    assert.deepEqual(await runRetryAfter("Fri, 25 Sep 2026 10:00:11 GMT"), { waits: [], fetches: 1 });
  });

  // Each of these would give a different wait (or none) if handed to Date.parse.
  const unusable = [
    "-1",
    "1.5",
    "+3",
    "3 s",
    "Fri, 25 Sep 2026 10:00:05 UTC",
    "Fri, 25 Sep 26 10:00:05 GMT",
    "fri, 25 Sep 2026 10:00:05 GMT",
    "Fri, 25 sep 2026 10:00:05 GMT",
    "Fri, 25 Foo 2026 10:00:05 GMT",
    "Fri, 00 Sep 2026 10:00:05 GMT",
    "Thu, 31 Sep 2026 10:00:05 GMT",
    "Sat, 29 Feb 2027 10:00:05 GMT",
    "Fri, 25 Sep 2026 24:00:00 GMT",
    "Fri, 25 Sep 2026 10:60:00 GMT",
    "Fri, 25 Sep 2026 10:00:61 GMT",
    "Fri, 25 Sep 2026 10:00:05 GMT trailing",
    "Friday, 25-Sep-2026 10:00:05 GMT",
    "Fri Sep 25 10:00:05 26",
  ];

  for (const value of unusable) {
    it(`falls back to retryDelayMs for retry-after ${JSON.stringify(value)}`, async (t) => {
      t.mock.method(Date, "now", () => FIXED_NOW_MS);

      assert.deepEqual(await runRetryAfter(value), { waits: [RETRY_DELAY_MS], fetches: 2 });
    });
  }
});
