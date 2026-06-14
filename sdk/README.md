# calibre_onchain (SDK)

The pip package the **private calibre app** imports to mirror prediction markets
on the Arc `CalibreMarket` contract.

The SDK's settlement inputs are a chain market id, an outcome string, and a bare
set count — nothing more. It carries no LMSR state, points, or ledger internals
across the public/private boundary (see the repo root README). This seam is
**create/seed/resolve only**; the user `buy`/redeem paths are out of scope.

## Usage

```python
from calibre_onchain import OnchainClient, OnchainConfig

client = OnchainClient(OnchainConfig(
    rpc_url="https://rpc.testnet.arc.network",
    contract_address="0x...",      # deployed CalibreMarket
    resolver_key="0x...",          # the onlyResolver key (never committed)
    chain_id=5042002,              # Arc testnet
))

client.create_market(chain_market_id=42)           # → tx hash
client.seed_inventory(chain_market_id=42, sets=100)  # → tx hash (counterparty inventory)
client.resolve(chain_market_id=42, outcome="yes")  # → tx hash
```

`seed_inventory` pulls `sets * usdcUnit` USDC from the contract's `counterparty`
(which must hold that USDC and have approved the contract) and credits it `sets`
complete share pairs — the inventory a voucher `buy` draws from. A market is
tradeable only after both `create_market` and `seed_inventory`.

`outcome` is the points-side `"yes"` / `"no"` string; it maps to the contract's
`Outcome` enum (`YES = 1`, `NO = 2`; `UNRESOLVED = 0` is rejected by the
contract). web3 is imported only at `OnchainClient(...)` construction, so
`from calibre_onchain import OnchainClient` is safe to do behind a feature flag
without pulling the web3 stack onto a flag-off boot path.
