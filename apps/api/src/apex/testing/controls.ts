/**
 * PROTOTYPE controls (docs/architecture/apex-first-capability.md §10.2 item 2). SELF-AUTHORED, CORRECT-but-ASYMMETRIC contracts: each one
 * is correct as designed, but its accounting or phase variables are deliberately asymmetric, so some candidate invariants the explorer
 * generates for it are FALSE. Ground truth is written per candidate, by reading the design, with the reason. Development data only:
 * not a benchmark, not a frozen corpus, and nothing here may be read as evidence of detection quality on real code. The controls were
 * written by the same author as the quality rules, several of them to exercise one rule each, so a rate measured on them shows that the
 * rules do what they were designed to do; it is not an independent estimate of the false-invariant rate on any other code.
 */
import { exploreStateInvariants, type ExploreOptions } from "./state-explorer-prototype.js";

export type Control = {
  contract: string; source: string; design: string;
  /** every candidate id the explorer may generate for this contract, labelled: true = a real invariant of the design, false = not one */
  truth: Record<string, { invariant: boolean; why: string }>;
};

export const CONTROLS: Control[] = [
  {
    contract: "FeeVault",
    design: "a 1% fee is kept outside the user ledger; withdrawal is two-step (request, then complete)",
    source: `contract FeeVault {
  mapping(address => uint256) public balances; mapping(address => uint256) public pending; uint256 public totalFees;
  function deposit() external payable { uint256 fee = msg.value / 100; balances[msg.sender] += msg.value - fee; totalFees += fee; }
  function requestWithdraw(uint256 amount) external { balances[msg.sender] -= amount; pending[msg.sender] += amount; }
  function completeWithdraw() external { uint256 a = pending[msg.sender]; pending[msg.sender] = 0; payable(msg.sender).transfer(a); }
}`,
    truth: {
      "conservation:totalFees=sum(balances)": { invariant: false, why: "fees and balances are different quantities by design" },
      "conservation:totalFees=sum(pending)": { invariant: false, why: "fees and pending withdrawals are different quantities by design" },
      "solvency:balance>=sum(balances)": { invariant: true, why: "every credited balance was paid in, minus a fee that stays in the contract" },
      "solvency:balance>=sum(pending)": { invariant: true, why: "pending amounts come from balances, which are backed" },
      "actor-value:attacker-net<=0": { invariant: true, why: "an actor can only withdraw what it deposited, minus the fee" },
    },
  },
  {
    contract: "GrossVault",
    design: "totalDeposits records GROSS deposits; deposits of 2 ether or more pay a 1% fee that is not credited to the depositor",
    source: `contract GrossVault {
  mapping(address => uint256) public balances; uint256 public totalDeposits; uint256 public fees;
  function deposit() external payable {
    uint256 fee = msg.value >= 2 ether ? msg.value / 100 : 0;
    balances[msg.sender] += msg.value - fee; totalDeposits += msg.value; fees += fee;
  }
}`,
    truth: {
      "conservation:totalDeposits=sum(balances)": { invariant: false, why: "gross deposits exceed credited balances once a large deposit pays the fee" },
      "conservation:fees=sum(balances)": { invariant: false, why: "different quantities" },
      "solvency:balance>=sum(balances)": { invariant: true, why: "credited balances never exceed ether received" },
      "actor-value:attacker-net<=0": { invariant: true, why: "nothing ever pays ether out" },
    },
  },
  {
    contract: "Staged",
    design: "after two deposits, anyone may claim a 1 ether bonus funded from a separate reserve; totalDeposits counts deposits only",
    source: `contract Staged {
  mapping(address => uint256) public balances; uint256 public totalDeposits; uint256 public reserve; uint256 public count;
  function fund() external payable { reserve += msg.value; }
  function deposit() external payable { balances[msg.sender] += msg.value; totalDeposits += msg.value; count += 1; }
  function distribute() external {
    require(count >= 2, "early");
    require(reserve >= 1 ether, "reserve");
    reserve -= 1 ether; balances[msg.sender] += 1 ether;
  }
}`,
    truth: {
      "conservation:totalDeposits=sum(balances)": { invariant: false, why: "bonuses are credited outside totalDeposits by design" },
      "conservation:reserve=sum(balances)": { invariant: false, why: "different quantities" },
      "conservation:count=sum(balances)": { invariant: false, why: "different quantities" },
      "solvency:balance>=sum(balances)": { invariant: true, why: "bonuses are paid out of ether held in the reserve" },
      "actor-value:attacker-net<=0": { invariant: true, why: "nothing ever pays ether out" },
    },
  },
  {
    contract: "Rounds",
    design: "a round counter anyone advances to 3; anyone may then close the round, which resets it",
    source: `contract Rounds {
  uint256 public round; uint256 public closed;
  function advance() external { require(round < 3, "full"); round += 1; }
  function close() external { require(round == 3, "open"); round = 0; closed += 1; }
}`,
    truth: {
      "one-way:round": { invariant: false, why: "round resets to 0 by design, by anyone, after reaching 3" },
    },
  },
  {
    contract: "Seeded",
    design: "the owner seeds 1 ether of shares once; afterwards anyone may claim 1 reward share, which by design is not part of totalShares",
    source: `contract Seeded {
  address public owner; bool public seeded; uint256 public totalShares; mapping(address => uint256) public shares; mapping(address => bool) public claimed;
  constructor() { owner = msg.sender; }
  function seed() external { require(msg.sender == owner, "owner"); require(!seeded, "once"); seeded = true; totalShares += 1 ether; shares[msg.sender] += 1 ether; }
  function claim() external { require(seeded, "early"); require(!claimed[msg.sender], "claimed"); claimed[msg.sender] = true; shares[msg.sender] += 1; }
}`,
    truth: {
      "conservation:totalShares=sum(shares)": { invariant: false, why: "reward shares are outside totalShares by design" },
      "one-way:seeded": { invariant: true, why: "seeded is never reset" },
    },
  },
  {
    contract: "Bonus",
    design: "as Staged, but the bonus is available after ONE deposit, so the designed asymmetry is reachable within the explored depth",
    source: `contract Bonus {
  mapping(address => uint256) public balances; uint256 public totalDeposits; uint256 public reserve; uint256 public count;
  function fund() external payable { reserve += msg.value; }
  function deposit() external payable { balances[msg.sender] += msg.value; totalDeposits += msg.value; count += 1; }
  function distribute() external {
    require(count >= 1, "early");
    require(reserve >= 1 ether, "reserve");
    reserve -= 1 ether; balances[msg.sender] += 1 ether;
  }
}`,
    truth: {
      "conservation:totalDeposits=sum(balances)": { invariant: false, why: "bonuses are credited outside totalDeposits by design" },
      "conservation:reserve=sum(balances)": { invariant: false, why: "different quantities" },
      "conservation:count=sum(balances)": { invariant: false, why: "different quantities" },
      "solvency:balance>=sum(balances)": { invariant: true, why: "bonuses are paid out of ether held in the reserve" },
      "actor-value:attacker-net<=0": { invariant: true, why: "nothing ever pays ether out" },
    },
  },
];

export type FalseInvariantMeasure = {
  /** candidates accepted (established) that are FALSE for the correct design, over all accepted candidates */
  falseAccepted: number; trueAccepted: number; falseInvariantRate: number;
  /** false candidates generated, and the share of them that was accepted */
  falseGenerated: number; falseAcceptanceRate: number;
  /** true invariants that honest sequences exercised but the rules still rejected (the price of the rules) */
  trueRejected: string[]; falseAcceptedIds: string[];
  /** a hypothesis on a correct control is a false positive by construction */
  falsePositiveHypotheses: string[]; unlabelled: string[];
};
export function measureFalseInvariants(options: ExploreOptions, controls: Control[] = CONTROLS): FalseInvariantMeasure {
  const m: FalseInvariantMeasure = { falseAccepted: 0, trueAccepted: 0, falseInvariantRate: 0, falseGenerated: 0, falseAcceptanceRate: 0, trueRejected: [], falseAcceptedIds: [], falsePositiveHypotheses: [], unlabelled: [] };
  for (const c of controls) {
    const r = exploreStateInvariants([{ path: "c.sol", text: `pragma solidity ^0.8.20;\n${c.source}` }], c.contract, options);
    for (const cand of r.candidates) {
      const t = c.truth[cand.id]; if (!t) { m.unlabelled.push(`${c.contract}:${cand.id}`); continue; }
      if (!t.invariant) m.falseGenerated++;
      if (cand.established && t.invariant) m.trueAccepted++;
      if (cand.established && !t.invariant) { m.falseAccepted++; m.falseAcceptedIds.push(`${c.contract}:${cand.id}`); }
      if (!cand.established && t.invariant && cand.maintaining > 0) m.trueRejected.push(`${c.contract}:${cand.id}`);
    }
    for (const h of r.hypotheses) m.falsePositiveHypotheses.push(`${c.contract}.${h.claim.split(":")[0]!.split(".")[1]}: ${h.family}`);
  }
  m.falseInvariantRate = m.falseAccepted + m.trueAccepted ? m.falseAccepted / (m.falseAccepted + m.trueAccepted) : 0;
  m.falseAcceptanceRate = m.falseGenerated ? m.falseAccepted / m.falseGenerated : 0;
  return m;
}
