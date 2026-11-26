# License decision — required before public release

**Status: DECISION PENDING. No license has been chosen. No `LICENSE` or `LICENSE.md` file exists.**

This document exists to surface an owner decision; it is **not** a license grant. Do not publish the
repository until the owner selects a license and adds the corresponding license file. Until then,
treat the repository as **all rights reserved**: source visibility (including a public repository
URL or shared snapshots) is **not** permission to copy, modify, distribute, or reuse the code.

No license has been inferred from code, documentation, README text, package metadata, or the
presence of this file. `engine/package.json` marks the engine as `"private": true`, which is a package
manager setting, not a license.

## Options to consider

### MIT (permissive)

- Short, widely understood permissive license.
- Allows reuse, modification, and redistribution with minimal conditions (retain the copyright and
  license notice).
- Provides no explicit patent grant and no warranty; the project is offered "as is".
- Lowest friction for adoption and contributions.

### Apache License 2.0 (permissive with patent grant)

- Permissive reuse rights similar to MIT, with an express **patent grant** from contributors and
  explicit patent-termination terms.
- Includes requirements around stating changes, retaining notices, and a `NOTICE` file when
  applicable.
- Often preferred for projects where contributors or adopters care about patent clarity.
- Longer and more administrative than MIT.

### GNU GPL-3.0 (strong copyleft)
- Permissive in use but requires derivative **distributions** to remain under compatible copyleft
  terms (source available under GPL-3.0 for distributed derivatives).
- Suitable if the goal is to keep forks of the distributed software open; it can limit
  proprietary downstream reuse.

### GNU AGPL-3.0 (network copyleft)
- Same as GPL-3.0 plus copyleft obligations triggered by **network use** of a modified version
  (users interacting with a modified service must be offered the corresponding source).
- Relevant if the Harness is offered as a hosted service; it is the most restrictive option here.

### Proprietary / private

- No public reuse rights are granted; all rights remain with the owner.
- Can still be published as source for visibility (for example, a source-available reference) only
  with clearly written, custom terms — a public repository without a license is **not** the same as
  a defined proprietary grant.
- Limits adoption, forks, and outside contributions; contributors need explicit terms before
  contributing.

## Decision requested from the owner

1. Choose one of the options above (or supply custom terms), and confirm the copyright holder name
   and year to place in the license file.
2. Confirm whether the public repository should be permissive, source-available under custom terms,
   or kept private.
3. Only after that decision: add the actual `LICENSE` file and update `README.md` / `package.json`
   metadata to match. Remove this decision document or mark it resolved.

**Do not create `LICENSE` / `LICENSE.md`, set a license field, or proceed with publication on behalf
of the owner.** Agents and automated tooling must not make this choice.
