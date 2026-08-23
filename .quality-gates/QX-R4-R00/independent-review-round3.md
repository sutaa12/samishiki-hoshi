# QX-R4-R00 independent review — round 3

- Isolation: fresh artifact-only context, `fork_turns=none`
- Reviewer role: independent SolMax acceptance reviewer
- Reviewed snapshot: `c4a967c91d895a03ae8f21897c9771c9416d98ae`
- Reviewed tree: `615a5f24991646758f514c8a00073a948dd92606`
- Verdict: REJECT
- Score: 23/32
- Severity: S0=0, S1=2 open, S2=6 open, S3=1 mitigated
- Blindness limitation: a filtered acceptance read exposed nested prior-status metadata. No prior finding text was used, but this review is preserved as diagnostic and cannot be the sole final independent authority.

## Blocking findings

1. `S1-01`: a preserved Human Reject row could coexist with top-level and owner pass.
2. `S1-02`: lexically distinct aliases could resolve to the same raw, trace, and owner evidence file.
3. `S2-01`: canonical query/fragment duplicate URLs still counted as distinct references.
4. `S2-02`: required Research Pack files themselves could be symlinks.
5. `S2-03`: mandatory Library scorecard maintenance, compatibility, cost, lifecycle, browser, and communication cells were not all validated, and decision values were unconstrained.
6. `S2-04`: Git tree object IDs could pass 40-hex plus `git archive` checks intended for commits.
7. `S2-05`: rollback validation did not require the prior Sites version or deployed boundary.
8. `S2-06`: comparable-game rows omitted TestableHypothesis.

## Remediation status

The findings are not considered closed by the implementer. A future frozen snapshot must fail on any Human Reject, compare canonical realpaths, canonicalize all reference URLs, reject symlinked required files, validate every Library column and decision enum, require Git commit object type, require the Sites rollback boundary, and require comparable hypotheses. A fully fresh reviewer with no prior-status exposure must confirm zero open S0-S2.
