# Read pack trial

Run at 2026-09-26T14:35:18.277382+00:00. Fixture SHA-256 `f7870b7259c64d3bf644b634e240f6e00877b8b434cea09beca4f4d07ed621cc`.
Labels were frozen in fixture.json before the owners started and were not changed after model output.
An earlier structural-only attempt is preserved in attempt-1.json. Its archive note never entered the index because an unquoted colon made the summary invalid YAML. The sentence is unchanged and is now quoted. That attempt made no live Jev call.

## Policy

Scope yes/no minimum 0.45, at most 2 scopes. Summary score minimum 2, top 5. Full text yes/no minimum 0.55. Injection yes/no at or above 0.7 drops the page. A scope with more than 4 summaries is partial and only the newest 4 are judged. These numbers were chosen before the run.

## Structural replay

11/11 code contracts passed. This arm does not measure Jev.

| Case | Passed | What failed |
| --- | --- | --- |
| paraphrase | True |  |
| both | True |  |
| thin | True |  |
| none | True |  |
| injection | True |  |
| partial | True |  |
| invented | True |  |
| timeout | True |  |
| invalid | True |  |
| stale | True |  |
| exact | True |  |

## Live Jev

Model `jev-1.13.0`. One uncached pass. Soft disagreements were not rerun and thresholds were not changed.
Credential was supplied from an explicit env file. The file path and secret are not recorded. Accounted ledger USD 0.0011208120000000003.

| Case | Pages loaded | Soft label | Baseline rank of labeled pages |
| --- | --- | --- | --- |
| paraphrase | (none) | differ | notes/dock-rule:None, notes/dock-archive:1 |
| cedar | (none) | differ | notes/copy-rule:None, notes/copy-archive:1 |
| both | (none) | differ | notes/copy-rule:1, notes/dock-rule:2 |
| thin | (none) | match | notes/relay:1 |
| none | (none) | match |  |
| exact | (none) |  |  |
| injection | (none) | match | notes/bookmark-tip:1 |
| partial | (none) |  |  |

## Keyword baseline

Same questions, Jev off, keyword search, top 12. A blank rank means the page was absent.

| Case | Top slugs |
| --- | --- |
| paraphrase | notes/dock-archive, scopes/harbor, notes/bookmark-tip, notes/theater |
| cedar | notes/copy-archive, scopes/cedar |
| both | notes/copy-rule, notes/dock-rule, scopes/harbor, scopes/cedar, notes/copy-archive, notes/theater, notes/dock-archive, notes/relay |
| thin | notes/relay, scopes/relay |
| none |  |
| exact | notes/dock-rule, scopes/harbor, scopes/sessions, notes/theater, notes/bookmark-tip |
| injection | notes/bookmark-tip, scopes/bookmarks, notes/dock-archive |
| partial | notes/session-00-lamp, scopes/cedar, notes/bookmark-tip |

## Live judgments

Thresholds were not changed after these scores.

| Case | Scope yes/no | Summary scores | Full text | Result |
| --- | --- | --- | --- | --- |
| paraphrase | harbor 0.93 | archive 3.11, current rule 1.36, theater 0.10 | archive keep 0.05, dropped | empty |
| cedar | cedar 0.97 | archive 2.78, current rule 1.19 | archive keep 0.41, dropped | empty |
| both | harbor 0.94, cedar 0.93 | archives 2.57 and 2.38, current rules 1.92 and 1.45 | both archives dropped, keep 0.19 and 0.18 | empty |
| thin | relay 0.87 | title-only line 0.84 | not reached | fallback search, nothing loaded |
| none | all at or below 0.30 | not reached | not reached | fallback search, nothing loaded |
| exact | not called | not called | not called | skipped, 0 tokens |
| injection | bookmarks 0.80 | post 1.03 | not reached | nothing loaded |
| partial | sessions 0.40, below 0.45 | not reached | not reached | fallback search, lamp not judged |

Keyword search missed `notes/dock-rule` and `notes/copy-rule` and ranked the archives first. The pack chose the right scopes, then the current one-line summaries stayed under the score floor of 2 while the archives cleared it. Full text then refused the archives. No wrong page was loaded, and the right page was not recovered.

On the question whose right pages were already ranks 1 and 2, those summaries scored 1.92 and 1.45, so the pack loaded nothing. That is a miss against keyword search, not a recovery.

The relay title, the lunch question, and the exact slug behaved as the code contract requires. The bookmark summary scored 1.03, so the live injection check never ran. The structural replay is what covers that drop. The lamp scope scored 0.40, so the live partial window was not entered. The structural replay is what covers that exclusion.

Per-question read-pack time was about 60 to 110 ms per stage. The live ledger accounted USD 0.001120812, of which read-pack scope, summary, and full text were USD 0.000238224, USD 0.000144648, and USD 0.000067116. Capture connection judgments and search reranks on that same owner made up the rest. This is an adapter estimate, not an invoice.

## What this supports

The structural arm supports the code contracts: closed slugs, full-text drop, injection drop, partial window, stale-hash exclusion, exact-slug skip, and fallback on timeout or a malformed response.

The live arm does not support a retrieval improvement. It supports a narrower claim: on these questions Jev would rather return nothing than load the archive, and the one-line paraphrase did not clear a score of 2. Hard live failures: 0. The notes and labels were written by the same person. This is not a general accuracy claim.
