# Scope evidence: USX (Sherlock bug bounty 273), first research run

- **Programme:** USX, `sherlock:273`, `official_confirmed`, max reward $100,000 (production record).
- **Official page:** https://audits.sherlock.xyz/bug-bounties/273, fetched 2026-11-28 by a passive GET. `robots.txt` allows all agents. The page's sha256 is `1cdc83533cb8e55f89b57ae3d643cc8b16e1bdd5ea7d6b64492cbf83c19170b3`.
- **Repository association:**
  - the official scope entries name `repoName: scroll-tech/usx-contracts`, `branchName: main`, `commitHash: 9e972566deb59b4d2c499015c2557c5e5f236e3c`;
  - the "Protocol Resources" section links to https://github.com/scroll-tech/usx-contracts;
  - production enrichment recorded it as `official_documentation`, confidence high, GitHub id `1057730048`.
- **Pinned commit:** `9e972566deb59b4d2c499015c2557c5e5f236e3c`. It **equals** the commit in the official scope and the default-branch HEAD resolved on 2026-11-27.
- **Deployed contracts in scope** (Scroll): `0xcb14bcdf6cd483665d10dfd6f87d908996c7f922`, `0xd16909ecc9c71d481ee3b2cb1968c0dadcf0d300`, `0x3b005fefc63ca7c8d25ee21fba3787229ba4cf03`, `0x9f3d4b0c9e930ca3957ecd3dedb7417f8e0e4c35`. The run does not interact with them.
- **Page note:** "The link to the GitHub repo in 'Scope' tab may lead to older commit. Please make sure to audit the newest commit of the codebase." The scope commit and the current HEAD are the same commit, so there is no conflict.

## In scope (selected): 20 files
- `src/BridgedToken.sol`
- `src/StakedUSX.sol`
- `src/TreasuryDiamond.sol`
- `src/TreasuryStorage.sol`
- `src/USX.sol`
- `src/asset-manager/AssetManager.sol`
- `src/facets/AssetManagerAllocatorFacet.sol`
- `src/facets/RewardDistributorFacet.sol`
- `src/interfaces/IAssetManager.sol`
- `src/interfaces/IScrollERC20Bridge.sol`
- `src/interfaces/IStakedUSX.sol`
- `src/interfaces/ITreasury.sol`
- `src/interfaces/IUSX.sol`
- `src/misc/ERC20Relayer.sol`
- `src/mocks/MockAssetManager.sol`
- `src/oft/BridgedTokenOFTAdapter.sol`
- `src/oft/StakedUSXOFT.sol`
- `src/oft/StakedUSXOFTAdaptor.sol`
- `src/oft/USXOFT.sol`
- `src/oft/USXOFTAdaptor.sol`

## Listed but NOT selected (out of scope): 27 files
- `package.json`
- `script/DeployHelper.s.sol`
- `script/DeployPrivateGateway.s.sol`
- `script/DeployScroll.s.sol`
- `script/RunDeployment.s.sol`
- `src/cloak/IL1ERC20GatewayValidium.sol`
- `src/cloak/IL2ERC20GatewayValidium.sol`
- `src/cloak/IScrollMessengerValidium.sol`
- `src/cloak/PrivateGatewayCloak.sol`
- `src/cloak/PrivateGatewayScroll.sol`
- `src/cloak/USXRebalancer.sol`
- `test/LocalDeployTestSetup.sol`
- `test/StakedUSX.t.sol`
- `test/TreasuryDiamond.t.sol`
- `test/USX.t.sol`
- `test/asset-manager/AssetManager.t.sol`
- `test/cloak/PrivateGatewayCloak.t.sol`
- `test/cloak/PrivateGatewayScroll.t.sol`
- `test/cloak/USXRebalancer.t.sol`
- `test/facets/AssetManagerAllocatorFacet.t.sol`
- `test/facets/RewardDistributorFacet.t.sol`
- `test/mocks/MockScrollValidiumInfra.sol`
- `test/mocks/MockUSDC.sol`
- `test/mocks/MockUSXInfra.sol`
- `tools/abi.ts`
- `tools/index.ts`
- `tsconfig.json`

**Consequence for the dossier:** the analyzer reads every `.sol` file in the snapshot. Leads in files outside the selected list are out of bounty scope and are reported as such.
