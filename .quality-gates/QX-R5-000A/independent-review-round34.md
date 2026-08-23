# QX-R5-000A independent blind review — Round 34

- Verdict: REJECT
- Score: 30/32
- Reviewed commit: `4499a604d718ffac8be7a3fda5219b65456bf9c2`
- Severity: S0 0, S1 1, S2 0, S3 0
- Proceed: no

## Open finding

### S1 — Structured external-pass claims remain bypassable

The validator did not reject three external-gate claims:

```json
{"rights":{"status":"passed"}}
{"human":{"status":"合格"}}
{"sites":{"status":"passed after smoke test"}}
```

Direct Rights keys were not external context, Japanese positive statuses were not
recognized, and prose classification did not inherit the external subject from a
parent object. Unknown non-empty external result strings were also treated as
well-formed. AI Binary therefore remained able to imply Human, Sites, or Rights
acceptance.

## Verification

- `rtk git rev-parse HEAD`: exit 0; exact commit confirmed.
- `rtk git status --short`: exit 0; clean.
- `rtk git diff --exit-code`: exit 0.
- `rtk git diff --cached --exit-code`: exit 0.
- `rtk npm run test:research`: exit 0; 224/224 passed.
- Read-only predicate probe: exit 0; all three false negatives reproduced.

Runtime trees were unchanged: `app` `42df35f01b63990c436d7cc5c45bc3b23cbb155d`,
`src` `a15e510ca1c8c632652e53f043b1ec128d25f728`, and `public`
`dbf15b05e8811c7636af5482d777b35bf07cc647`.

The review was read-only and did not use prior independent-review contents.
