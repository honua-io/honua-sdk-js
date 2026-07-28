#!/usr/bin/env node

const message =
  "The honua-sdk-js migration scripts now delegate to @honua/honua-migrate. " +
  "Use honua-js-migrate directly. The compatibility scripts will remain for at least two consecutive " +
  "honua-migrate minor releases and 90 days, and will not be removed before honua-migrate 1.2.";

process.stderr.write(`${message}\n`);
await import("@honua/honua-migrate/cli");
