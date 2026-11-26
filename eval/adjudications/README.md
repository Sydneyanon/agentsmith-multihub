# Ground-truth adjudications

When a label in a frozen corpus is disputed, the label is **never edited**. An adjudication record here preserves:
- the original label;
- the disputing source and its verdict;
- the evidence: compiler-backed execution of the unchanged contract, and an independent assessment;
- the outcome, the adjudicator, and whether a human has signed off.

Scores are always computed from the original labels. When an adjudication overturns a label, results are reported both ways, with
the adjudicated reading clearly marked.

| Record | Subject | Outcome | Human sign-off |
|---|---|---|---|
| `heldout3-reentrancy.json` | corpus 3: `EtherShareVault.redeem`, `MerchantEscrow.release` (reentrancy) | **Labels upheld**: both are exploitable, shown by EVM execution and by an independent assessor. The validator's refutations are **overturned** as artefacts of its model. | pending |

**Consequence for corpus 3's recorded results:**
- The label metrics are unchanged.
- The execution-validator line in `eval/results/README.md` ("3 refuted, 2 disagree with labels, open") is now resolved. Both disagreements were validator errors, so only 1 of the 3 refutations was correct (`PrepaidCreditLedger.withdraw`, labelled benign).
