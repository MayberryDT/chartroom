# Read pack trial

Run at 2026-09-26T14:30:45.910005+00:00. Fixture SHA-256 `64779b17190ec21a2c28fb3fd75ea7ade1146717a8bead01c8035fe4e43e907a`.
Labels were frozen in fixture.json before the owners started and were not changed after model output.

## Policy

Scope yes/no minimum 0.45, at most 2 scopes. Summary score minimum 2, top 5. Full text yes/no minimum 0.55. Injection yes/no at or above 0.7 drops the page. A scope with more than 4 summaries is partial and only the newest 4 are judged. These numbers were chosen before the run.

## Structural replay

10/11 code contracts passed. This arm does not measure Jev.

| Case | Passed | What failed |
| --- | --- | --- |
| paraphrase | False | dropped [] |
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
