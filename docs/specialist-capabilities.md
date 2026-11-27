# Specialist capabilities: inventory and how each becomes assignable (2026-11-27)

Checked in this cloud container on 2026-11-27 with `command -v` and version calls. "Works" means it ran here, not that it was evaluated.
There is **one** way a capability enters AgentSmith: as a producer or an evaluator inside a research-loop assignment (T-149
`repository_research`, `docs/research-loop.md`). There is no second orchestrator.

## 1. Inventory

| Capability | State here | Works? | Plane it may write | How it becomes assignable |
|---|---|---|---|---|
| Solidity structural specialists (7 classes: reentrancy, access control, initializer, delegatecall, unchecked call, selfdestruct, tx.origin) | in the repository | yes (tests) | 1: claims (`deterministic_rule`) | **assignable now**: `investigate_target` |
| Execution validators (reentrancy, reachability, initializer, unchecked call) | in the repository | yes (tests) | 2: independent evidence | **assignable now**: `challenge_target` |
| Protocol model P1–P3 (components, calls, state roles, authority) | in the repository | yes | mapping facts (features) | **used now**: mapping and target selection |
| Foundry (forge, cast, anvil, chisel 1.5.1) and solc 0.8.28 | session scratchpad only: not on PATH, not in the image, lost with the container | yes (the private case study's tests ran on it) | 2: evidence (a reproducing test), never a claim's own proof | install through the environment setup script (an environment change for you to approve), then an evaluator step that runs a test against the sealed snapshot offline; fork RPC stays separately approved |
| Slither | not installed; PyPI reachable (0.11.3 wheel download verified); needs solc and crytic-compile | untested | 1: claims, one per detector class | a producer step; its detectors become classes; output is never evidence |
| Mythril, Echidna, Medusa, Halmos, Semgrep, Aderyn, Solhint | not installed (`command -v` finds none) | untested | Echidna/Medusa/Halmos: 2 (property and invariant checks); Mythril, Semgrep, Aderyn, Solhint: 1 | as above; property tools are the natural evaluators for the **not-modelled** classes (accounting invariants, arithmetic precision, liveness) |
| Python 3, pip, Go, Cargo, Node 22, Docker (binary) | installed | Docker daemon untested | — | build prerequisites only |
| Claude Code in this session: subagents (Explore, general-purpose, Plan), `/security-review`, `/code-review`, the Workflow tool (opt-in only) | available **only inside a human-attended Claude Code session** | yes, attended | today: none directly. A model claim needs a budget-gateway reservation (research store rule); an attended session's output can enter only as a named human's input, under that human's responsibility | unattended use is T-195 (single bounded calls through the US$25/month gateway) and needs A31. A subscription is not assumed to give unattended runtime access |

## 2. The integration contract (what "assignable" means)
A capability is assignable when it has:
1. a step key and handler in `engine/steps.ts`, gated by the same two switches;
2. a fixed identity and version (`generator_id` or `evaluator_id`), so independence is checkable (evaluator ≠ generator);
3. the classes it examines. On a successful run those classes move from `not_modelled` to `examined` in coverage memory.

The loop then assigns it with no further change. The component priority scores **pending classes at the current content hash**, so a new
capability makes every component it has not examined a candidate again, while existing coverage is kept.

The one code generalisation this needs is small: today `SPECIALIST_CLASSES` is a single list for the single specialist. It should become
a list per capability (T-201). The plan is to do that with the first external tool rather than as a design exercise.

## 3. APEX, Weirdness and the niche/bug-class strategy: the same engine, not separate projects
- **APEX** (T-150–T-162, not started) is a *producer and evaluator family* for multi-step paths and protocol interactions. Its hypotheses
  are plane-1 claims with evidence spans. Its execution checks are plane-2 evaluations by a different evaluator id. Its choices use the
  existing `path` decision level and candidate kind (already in the A29 draft). It is assigned through `investigate_target`-style steps
  and remembered in the same coverage and outcome records.
- **Weirdness** (5.5A) is a *mapping-stage signal*. Anomalies it finds in the protocol model become a sourced feature and a named
  contribution in the component priority, so it changes **which target is chosen next** and why. It does not run a pipeline of its own.
- **Niche / bug-class strategy** is expressed through the class taxonomy and memory the loop already keeps:
  - classes AgentSmith can examine versus classes it records as not modelled;
  - coverage per class at each component version;
  - the outcome ledger per class.

  The policy already prefers pending classes. Adding a class-gap weight (classes where we have a capability, the component is
  unexamined, and audits do not cover it) is a policy version change, recorded and evaluated (T-192), not a new engine.
