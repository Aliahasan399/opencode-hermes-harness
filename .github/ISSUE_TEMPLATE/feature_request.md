---
name: Feature request
about: Suggest a capability or improvement
title: "[Feature]: "
labels: enhancement
assignees: ''
---

## Problem

<!-- What problem or limitation does this address? What is the use case? -->

## Proposed solution

<!-- Describe the desired behavior. Prefer additive changes that extend existing modules. -->

## Alternatives considered

<!-- Other approaches you considered, and why they were not chosen. -->

## Scope and safety

- Does this touch project isolation, approvals, or safety settings (`LEVEL 1`,
  `HARNESS_SEMANTIC_LLM=0`)?
- Does it require a database migration? If so, can it be additive and reversible?
- Does it introduce a new process-spawn site, dependency, or host-specific assumption?

## Evidence and limitations

<!-- What evidence supports the request? What would NOT be demonstrated by this change? -->

## Checklist

- [ ] I searched existing issues and discussions for duplicates.
- [ ] The request contains no secrets, personal paths, or session IDs.
- [ ] I understand that changes must preserve documented safety invariants.
