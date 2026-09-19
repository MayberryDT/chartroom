# Chartroom: Jev off/on comparison

Run on September 19, 2026. This is a small synthetic demonstration, not a general benchmark or a comparison against the latest GBrain.

Jev improved the correct first search result from **17/20 to 20/20**. It added **24 links**, of which **23 met the predefined relevance rules**. Connection coverage was incomplete, and two enrichment calls failed response validation. No runtime prompts, thresholds or code were changed during this comparison.

## Setup

- 30 short synthetic notes across six projects; each project has a current policy, incident, historical policy, navigation index and a distractor.
- 20 labeled questions: 18 short searches and two natural-language questions. The evaluator authored both notes and labels before testing; there was no independent human panel or held-out real-world dataset.
- Fixture and runner committed before measurement (`e2e8f6b`). Runtime code is the packaged `885e889` version. Fixture SHA-256: `7e478d1d982364dc9652570eee11fee2260f5813e0d6919c484592cbedad1bfc`.
- GBrain v0.48.2.0, Bun 1.4.0, Jev `jev-1.13.0`; no embeddings or answer-generation model.
- Search used two copies of the same stopped, graph-free database. Both requested 12 candidates. Candidate sets matched for every query; only their order changed.
- Each search arm ran three passes in fixed order. Pass one was the first request in that owner process; passes two and three reused caches. These are repeat measurements, not three independent model trials. OS/network caches were not flushed.
- Connections used two fresh databases with the same document order. No search-test judgments or links were carried into the connection test. Jev off had no semantic-link enrichment; the notes contained no explicit links.
- All work used temporary local owners and synthetic data. The live brain was unchanged.

## Search results

| Mode / pass | Correct first | Correct in first three | Median latency | p95 latency |
| --- | ---: | ---: | ---: | ---: |
| Jev off, first 1 | 17/20 | 19/20 | 34.3 ms | 41.8 ms |
| Jev off, repeat 2 | 17/20 | 19/20 | 30.7 ms | 37.8 ms |
| Jev off, repeat 3 | 17/20 | 19/20 | 28.7 ms | 34.6 ms |
| Jev on, first 1 | 20/20 | 20/20 | 150.4 ms | 198.9 ms |
| Jev on, repeat 2 | 20/20 | 20/20 | 35.4 ms | 40.2 ms |
| Jev on, repeat 3 | 20/20 | 20/20 | 30.9 ms | 36.7 ms |

The correct page was present in the 12 candidates for all questions in both arms. First-pass mean reciprocal rank improved from 0.904 to 1.000. The same rankings persisted in both repeats. First-pass median latency increased by about 116 ms; cached repeats were close to baseline. Latencies include local HTTP, retrieval, logging and any Jev request, but exclude startup and ingestion. Fixed arm order and the small sample limit timing conclusions.

All three first-result improvements selected the current policy over an archived policy:

| Query | Baseline correct-page rank | Jev correct-page rank |
| --- | ---: | ---: |
| Cedar backup retention nightly | 2 | 1 |
| Juniper greenhouse watering threshold | 4 | 1 |
| Lantern onboarding security training deadline | 3 | 1 |

No measured query regressed. This set includes explicit supersession language and clear dates; the result does not establish performance on long, messy or ambiguous personal notes.

## Connection results

| Measure | Jev off | Jev on |
| --- | ---: | ---: |
| Links created | 0 | 24 |
| Accepted links | 0 | 23 |
| Unwanted links | 0 | 1 |
| Selected expected relationships found | 0/18 | 10/18 |
| Link precision under the preset rules | Not applicable | 95.8% |
| Median capture latency | 19.2 ms | 326.2 ms |
| Capture enrichment failures | Not applicable | 2/30 |

The 23 accepted links comprise ten policy/incident/archive relationships and thirteen index-navigation relationships. Thus, the total link count should not be presented as 23 substantive discoveries. Expected-pair coverage was 55.6%; the eighteen pairs are a selected coverage list, not an exhaustive definition of all useful relationships. Edges are scored as undirected relationships; the raw results preserve direction.

I reviewed all 24 proposed links against the fixture text and frozen rubric. The unwanted link connects the outdoor Juniper orchard plan to the greenhouse policy despite their explicitly separate watering rules. It remains counted as a failure rather than relabeled after the run.

| Proposed link | Review |
| --- | --- |
| `notes/harbor-incident` → `notes/harbor-policy` | Accepted: same-project evidence |
| `notes/harbor-archive` → `notes/harbor-policy` | Accepted: same-project evidence |
| `notes/harbor-index` → `notes/harbor-policy` | Accepted: navigation |
| `notes/harbor-index` → `notes/harbor-archive` | Accepted: navigation |
| `notes/cedar-archive` → `notes/cedar-policy` | Accepted: same-project evidence |
| `notes/atlas-archive` → `notes/atlas-policy` | Accepted: same-project evidence |
| `notes/atlas-index` → `notes/atlas-policy` | Accepted: navigation |
| `notes/atlas-index` → `notes/atlas-incident` | Accepted: navigation |
| `notes/atlas-index` → `notes/atlas-archive` | Accepted: navigation |
| `notes/juniper-incident` → `notes/juniper-policy` | Accepted: same-project evidence |
| `notes/juniper-archive` → `notes/juniper-policy` | Accepted: same-project evidence |
| `notes/juniper-index` → `notes/juniper-policy` | Accepted: navigation |
| `notes/juniper-index` → `notes/juniper-archive` | Accepted: navigation |
| `notes/juniper-decoy` → `notes/juniper-policy` | Unwanted: separate watering policies |
| `notes/relay-incident` → `notes/relay-policy` | Accepted: same-project evidence |
| `notes/relay-archive` → `notes/relay-policy` | Accepted: same-project evidence |
| `notes/relay-index` → `notes/relay-incident` | Accepted: navigation |
| `notes/relay-index` → `notes/relay-archive` | Accepted: navigation |
| `notes/relay-index` → `notes/relay-policy` | Accepted: navigation |
| `notes/lantern-incident` → `notes/lantern-policy` | Accepted: same-project evidence |
| `notes/lantern-archive` → `notes/lantern-policy` | Accepted: same-project evidence |
| `notes/lantern-index` → `notes/lantern-policy` | Accepted: navigation |
| `notes/lantern-index` → `notes/lantern-incident` | Accepted: navigation |
| `notes/lantern-index` → `notes/lantern-archive` | Accepted: navigation |

Twelve captures abstained and sixteen published links. The Harbor theater distractor and Atlas launch incident returned `invalid_structure`; both source documents were still saved. The public adapter does not retain rejected provider bodies, so this run cannot distinguish malformed provider output from an overly strict validator. The Atlas failure prevented one directly useful connection. There was no retry or threshold tuning to improve the reported score.

All generated graph-work packets finished applied; no graph packets remained queued. All four history checks reported zero logging gaps. History snapshots are capped at 200 events and are not a complete audit of every provider response.

## Usage

| Phase | Local Jev estimate (USD) |
| --- | ---: |
| Search: 20 first queries plus 40 cached repeats | $0.001040466 |
| Capture and candidate ranking: 30 notes | $0.003419010 |
| Total accounted estimate | $0.004459476 |

That accounted estimate is about **0.446 US cents**. It uses successful responses’ reported input tokens at the adapter’s configured estimate of $0.042 per million input tokens. It excludes unknown usage from rejected responses and is not a provider invoice or verified total bill. Cached search repeats added no ledger cost. No embedding or answer-generation calls were configured.

## Reproduce

Requires the README installation, Python 3 and a TypeSafe key provided in the process environment. No additional Python packages are needed. The script intentionally excludes inherited embedding keys and does not load the repository’s `.env`. It creates and removes disposable owners and refuses to overwrite existing result files.

```sh
bun test tests
# Set TYPESAFE_API_KEY, JEV_API_KEY, or TYPESAFE_ENV in your environment.
python3 benchmarks/compare.py --output benchmarks/my-results.json
```

Results can vary with provider behavior, machine load and upstream service changes. Read [fixture.json](fixture.json), [compare.py](compare.py) and the original [results.json](results.json). The labels are explicit and can be challenged without changing the original evidence.

## What this supports

This demonstration supports saying that Jev improved ranking on these twenty synthetic questions and added mostly relevant connections at low accounted model cost. It does not support claiming perfect search, complete automatic linking, production-wide reliability or universal superiority over GBrain. The response-validation failures and missed relationships are the clearest next improvements.
