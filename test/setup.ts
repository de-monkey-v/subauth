/**
 * Guard, not a mock.
 *
 * This package injects every network call, so no test should ever reach the
 * real `fetch`. Replacing the global with a thrower does not stub behavior —
 * it asserts the absence of ambient network access, and turns "the default
 * silently took over" into a loud failure instead of a live HTTP request.
 */
globalThis.fetch = (() => {
  throw new Error(
    "test reached global fetch — every network call in this package must be injected",
  );
}) as typeof globalThis.fetch;
