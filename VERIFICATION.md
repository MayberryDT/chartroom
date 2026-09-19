# Verification

Checked on September 19, 2026, using Linux, Bun 1.4.0 and the pinned GBrain v0.48.2.0 dependency. This is installation and integration evidence, not a quality benchmark.

## Fresh installation

Copied only the repository files into a new temporary directory with an empty home directory. Installed with `bun install --frozen-lockfile --ignore-scripts` and no inherited credentials. Started a new database on a separate loopback port, then ran the README's three synthetic captures with an explicitly supplied TypeSafe credential. No embedding key was configured.

Results:

- All three documents were saved.
- Jev created one connection: `notes/harbor-maintenance` → `notes/harbor-sensors`.
- The unrelated garden page received no connection.
- Searching `Harbor sensor monthly calibration` returned both sensor pages. The usage record recorded capture and passage-ranking calls.
- The maintenance page's history contained nine events, including the graph receipt and successful connection publication.
- Stopping and restarting the owner retained the token, document and connection.
- An unauthenticated MCP POST returned HTTP 401.
- The run's local Jev input-token cost estimate was $0.000180012. This is not an invoice or a before/after cost comparison.

The install test exposed a candidate-retrieval issue: an exact title could return only the newly captured page. Capture now makes one bounded broader search when that happens, then applies the same Jev relevance threshold.

## Automated checks

Run `bun test tests`. Two tests passed, with no failures. The owner test uses a real disposable PGLite database and a deterministic test judge; the fresh-install check above used real Jev.

The checks cover quoted credentials, provider HTTP failure classification, malformed responses, usage accounting, graph publication, idempotent replay, stale revision rejection, source isolation, and reopening the database to resume a queued graph packet without another model call. Completed work does not publish again. The owner fixture also exercises the exact-title candidate fallback.

A separate no-key startup check confirmed that capture still saves its document when Jev configuration is missing, reports the enrichment failure, and leaves the page searchable.

## Not checked in this release preparation

Other operating systems, optional OpenAI embeddings, remote hosting and broad retrieval-quality comparisons were not tested. There is no claim of benchmark improvement. Model judgments can vary between runs.
