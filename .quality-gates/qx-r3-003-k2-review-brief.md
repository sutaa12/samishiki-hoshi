# QX-R3-003 K2 independent review brief

Review candidate `6ddaea020f7e10a7db7673b56529ea8472739174` without relying on the
author's verdict or the prior review's conclusions. Do not inspect later commits
until exact source and evidence bindings have been checked.

1. Verify the 378-file manifest and preserved build against this exact commit.
2. Read the Notion QX-R3-003 task, AGENTS.md contract, current specification,
   candidate receipt, and source/test diff from accepted base `6ff2359`.
3. Independently challenge every input route and reset path, including two or
   more valid edges before one RAF. Confirm each edge is consumed, repeat is
   ignored, and reset paths discard all remaining edges.
4. Reproduce proportionate type/lint/unit/focused browser checks. Treat the
   previously disclosed broad Graphics timing diagnostic separately, but
   challenge the classification if this candidate can cause it.
5. Score functional correctness, route exclusivity, reset/isolation,
   deterministic/accessibility preservation, and evidence integrity. Return
   S0/S1/S2/S3 counts and ACCEPT or REJECT.

Promotion requires no open S0, S1, or S2. Human, rights, reference hardware,
Main, deployment, and contest gates remain out of scope.
