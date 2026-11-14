# Verification experiments, version 1

The data/evaluation API lives in `src/contracts.js`; the fixed-harness Docker
runner lives in `src/function-runner.js`. Neither integrates AI or compiles
TypeScript. The existing command-based CLI/report format remains available. The experiment `schemaVersion` and
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

The Docker runner applies the timeout to each container attachment, including
startup and archive extraction. Docker control operations and Git operations have
separate eight-second limits. It resolves the target real path inside `/work` to
reject escaping symlinks. It does not verify provenance.
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
repository correctness, or security. The runner does not repeat observations or authenticate evidence against a
malicious target; those remain necessary before stronger claims.
A satisfied verdict covers only the observed input. Base behavior is never the
oracle. No AI output or generated assertion can select an executable expression.

A fixed predicate registry and runtime validation keep this checkpoint small and
dependency-free. A contract DSL or generated executable oracle would offer more
flexibility but increase the trusted execution surface and risk circular evidence.
Keeping the new API separate avoids changing legacy CLI semantics. Complete
replay bundles and repeated execution remain later work.

## Docker execution (Task 2)

Requirements: Node.js 20+, Git, a running Docker daemon, and a locally installed
Node 22 Alpine image. Install the image explicitly; the runner never pulls images:

```sh
docker pull node:22-alpine
node --test tests/function-runner.integration.test.js
npm test
```

The integration tests create disposable local Git repositories from the trusted
fixture files and commit base/candidate variants without modifying this repository.
They verify the 8-to-16 regression, exceptions, invalid/async outputs, timeouts,
output limits, log separation, missing exports, escaping symlinks, abrupt worker
exit, missing images, and container removal. Docker-unavailable tests are explicitly
skipped; missing images with an available daemon fail. Override the test image with
`PROOFABLY_TEST_IMAGE` (a locally installed Node 22 Alpine-compatible image).

For a repository containing the same exported function in both Git revisions:

```sh
node /path/to/proofably/src/function-cli.js \
  --repository /path/to/target-repository \
  --base <base-ref> --head <candidate-ref> \
  --experiment /path/to/proofably/tests/fixtures/power-of-two/experiment.json \
  --output function-report.json
```

The separate entry point avoids changing the legacy `src/cli.js check` interface.
An optional `--image <local-image-or-digest>` selects the trusted runtime. CLI
success means a report was produced; inspect comparison and verdict fields to
understand the evidence. Invalid options, schema, or Git revisions fail before
execution. Docker failures are recorded as unverified observations in the report.

The programmatic equivalent is:

```js
import { verifyFunctionExperiment } from './src/function-runner.js';
const report = verifyFunctionExperiment({
  repository: '/path/to/repository', base: 'main', candidate: 'HEAD', experiment,
});
```

### Execution and evidence

Both refs resolve to immutable commit SHAs before execution. The runner resolves
the selected local image to an immutable image ID once and uses it for both runs.
Reports include the resolved revisions, image ID, experiment, harness SHA-256,
per-observation Node/platform/architecture metadata, bounded logs, and cleanup
status. A mutable default tag is convenient locally; select a digest and preserve
the corresponding image for replay on another machine. Runs are not claimed to be
bit-for-bit reproducible across different architectures or Docker configurations.

Each revision is a Git archive extracted into its own non-root container's tmpfs.
Only a temporary input directory containing the archive, identical trusted harness,
and experiment JSON is mounted, read-only. No host working tree, credentials, or
Docker socket is mounted. The fixed bootstrap command contains no experiment text.
The harness imports one named function from a `.js` or `.mjs` target, passes JSON
arguments, and accepts synchronous JSON-compatible returns only. Dependency-free
modules are the supported scope; no install/build step runs. Imports do execute
module initialization code. Promises, undefined, nonfinite numbers, BigInt, cycles,
and non-JSON objects are invalid outputs.

A supervisor worker arrangement routes ordinary target stdout/stderr to diagnostic
stderr, keeping the JSON envelope separate. Function exceptions, target-loading
errors, invalid outputs, premature worker exits, timeouts, output overflow,
protocol errors, and Docker infrastructure failures have distinct `kind` values.
Only `returned` observations contain a `value`; other outcomes remain unverified
under the unchanged contract evaluator. A normal but contract-violating numeric
return is still a confirmed violation under Checkpoint 1's limited semantics.

The shared Docker policy disables networking, drops capabilities, sets
no-new-privileges, restricts CPU/memory/processes, and uses a read-only root
filesystem with bounded writable tmpfs mounts. The new runner also disables swap,
limits file descriptors and captured output (1 MiB), and never pulls an image.
Every attempt explicitly force-removes its uniquely named container, including
timeout and output-limit cases; a failed cleanup invalidates the observation and
reports the container name for manual removal. Per-container Docker log storage is
disabled. The legacy runner shares the isolation options; `/work` now explicitly
belongs to UID/GID 1000 so its existing non-root execution can extract archives.
Legacy CLI arguments, comparison semantics, and report shape are unchanged.

### Security and scope limits

Docker is a development isolation mechanism, not a hardened boundary for hostile
repositories. Use disposable machines for untrusted code. A worker isolates the
result channel from ordinary logging but is not an evidence-authentication boundary
against deliberately malicious Node code (which can access worker messaging or
Node internals). No claim of malicious-code tamper resistance is made.
Filesystem/path restrictions are defense in depth, not a JavaScript capability
sandbox. Resource caps do not prove purity: time, randomness, module side effects,
and process scheduling can still affect results. Dependency-free, deterministic
functions are an input assumption, not a statically verified property.

Cleanup is attempted synchronously with bounded Docker commands. Host crashes,
SIGKILL of the verifier, or daemon outages may prevent removal; use the recorded
`proofably-*` container names to investigate. Evidence repetition, stronger
isolation, and portable replay remain outside Task 2.
