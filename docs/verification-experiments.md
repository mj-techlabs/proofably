# Verification experiments, version 1

Checkpoint 1 defines an in-process data/evaluation API in `src/contracts.js`.
It does not execute experiments, integrate AI, compile TypeScript, or change the
existing command-based CLI/report format. The experiment `schemaVersion` and
result `schemaVersion` are independently versioned at 1.

## Schema

See `tests/fixtures/power-of-two/experiment.json` for a complete example.
`validateExperiment` is the executable schema validator; malformed data throws
`TypeError`. Additional fields are ignored in version 1 and have no semantics.

| Required field | Meaning and constraints |
| --- | --- |
| `schemaVersion` | Exactly `1` |
| `id` | Nonempty experiment identifier |
| `target.module` | Nonempty repository-relative module path; no absolute path, backslash, empty segment, or `..` segment |
| `target.export` | Nonempty named export |
| `arguments` | Array of JSON values; finite numbers only; no undefined, sparse arrays, cycles, or class instances |
| `contract.id` | Nonempty predicate identifier; unknown identifiers are valid but unsupported |
| `contract.provenance.source` | Nonempty source reference for the explicitly supplied contract |
| `contract.provenance.statement` | Nonempty human-readable requirement |
| `expectedExecution.runtime` | Exactly `"node"` |
| `expectedExecution.timeoutMs` | Integer from 1 to 300000 |
| `expectedExecution.expectedExitCode` | Exactly `0` |

Execution metadata describes the intended execution; this checkpoint does not
apply timeouts, load modules, validate filesystem containment through symlinks,
or verify provenance. Paths and metadata must be revalidated by a future runner.
Provenance records the caller's source attribution, not independently established
authority. The contract ID selects the predicate; the statement is never parsed
or executed and must describe the selected predicate's intended applicability.

## Fixture contract

`smallest-power-of-two-gte` accepts exactly one positive JavaScript safe integer
`n` and requires a numeric result equal to the smallest power of two >= `n`.
For `Number.MAX_SAFE_INTEGER`, the result is `2 ** 53`, an exactly representable
number even though it is outside the safe-integer input domain. No bitwise
operations or floating-point logarithms are used by the oracle.

The fixture's `base.js` and `candidate.js` are alternative contents of the logical
target `index.js`, not actual Git revisions. The candidate changes `<` to `<=`.
At input `8`, base returns `8` and candidate returns `16`. Unit tests import these
trusted fixtures directly; they do not demonstrate isolated Docker execution.

## Observations and verdicts

`evaluateVerification(experiment, base, candidate)` accepts observations of the
form `{ "exitCode": 0, "timedOut": false, "value": 8 }`. A missing/non-JSON value,
nonzero exit, timeout, or malformed observation is unverified. The caller must
provide trustworthy observations; the evaluator cannot authenticate execution.

The result retains both observations and separates:

- `comparison`: `no-difference`, `behavioral-difference`, or `unverified`, based on
  structurally equal JSON return values. Object key order is irrelevant; array
  order matters. This is separate from the legacy CLI's stdout/stderr comparison.
- `contracts.base` and `contracts.candidate`: independently contain `satisfied`,
  `confirmed-contract-violation`, `unsupported-contract`, `invalid-input`, or
  `unverified`. Successful evaluations also record `expected` and `actual`.

Unsupported contracts and out-of-domain arguments cannot confirm a violation.
For a supported contract and valid input, a successful JSON result of the wrong
type is a violation. Infrastructure failures cannot establish one. Comparison is
independent: identical results can violate the contract in both revisions, and
an unexplained difference cannot itself confirm a defect.

## Limits and design tradeoffs

`confirmed-contract-violation` means only that the supplied successful observation
violates this built-in predicate for this input, assuming the explicit contract
applies. It does not establish requirement authority, reproducibility, a regression,
repository correctness, or security. This checkpoint has no repetition or evidence
authentication; a future runner must establish those before stronger claims.
A satisfied verdict covers only the observed input. Base behavior is never the
oracle. No AI output or generated assertion can select an executable expression.

A fixed predicate registry and runtime validation keep this checkpoint small and
dependency-free. A contract DSL or generated executable oracle would offer more
flexibility but increase the trusted execution surface and risk circular evidence.
Keeping the new API separate avoids changing legacy CLI semantics; wiring it to
isolated execution and preserving complete replay artifacts are later checkpoints.
