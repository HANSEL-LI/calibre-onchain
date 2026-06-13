# calibre_onchain (SDK)

The pip package the **private calibre app** imports to mirror prediction markets
on the Arc `CalibreMarket` contract.

W0 scaffold — package skeleton only. The contract client (`create_market`,
`resolve`) and tx-signing helpers land in W1.x. The SDK's settlement inputs are
`(chain_market_id, outcome)` and nothing more — it carries no LMSR state,
points, or ledger internals across the public/private boundary (see the repo
root README).
