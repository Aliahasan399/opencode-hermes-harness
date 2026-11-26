## Summary

<!-- What changed and why? Keep the change focused and additive. -->

## Related issue

<!-- Link the issue this PR addresses, if any. -->

## Type of change

- [ ] Bug fix
- [ ] New capability / enhancement
- [ ] Documentation or governance
- [ ] Test / tooling
- [ ] Database migration

## Verification

List the exact commands you ran and their outcome. Tests should run against an isolated database.

```text
cd engine
npm test
# or: node --test --test-concurrency=1 test/*.test.js
```

- [ ] Tests pass on an isolated test database.
- [ ] Negative cases included where relevant (injection-as-data, redaction, invalid IDs,
      cross-project isolation, approval replay).
- [ ] No runtime or agent-execution success is claimed from test presence alone.

## Safety and isolation checklist

- [ ] Changes are additive; no DROP/TRUNCATE, row rewrites, or source rewrites.
- [ ] Any new migration is additive, reversible, idempotent, and project-scoped where applicable.
- [ ] Project isolation and `validProject` scope rules are unchanged or strengthened.
- [ ] `LEVEL 1` (`OPTIMIZATION_LEVEL=1`) and `HARNESS_SEMANTIC_LLM=0` defaults are unchanged.
- [ ] Approval model remains single-use, explicit, and bound to plan/scope/mode/risk.
- [ ] No new unrestricted process-spawn site or shell execution.
- [ ] Retrieved/stored content remains untrusted data, never instructions.

## Privacy checklist

- [ ] No secrets, tokens, passwords, connection strings, personal paths, or session IDs included.
- [ ] No internal artifacts (`.env`, `data/`, `backups/`, `logs/`, `checkpoints/`, `reports/`,
      caches) included.
- [ ] Documentation is sanitized for public release.

## Limitations

<!-- State what was NOT demonstrated or verified, honestly. -->

## Note for automated agents

Automated agents must not run Git commit, push, remote, or publication commands. Git operations and
publication are owner-controlled and remain blocked pending explicit owner authorization.
