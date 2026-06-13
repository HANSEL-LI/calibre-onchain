# calibre_onchain (SDK)

The pip package the **private calibre app** imports to mirror prediction markets
on the Arc `CalibreMarket` contract.

The SDK's settlement inputs are `(chain_market_id, outcome)` and nothing more —
it carries no LMSR state, points, or ledger internals across the public/private
boundary (see the repo root README). This seam is **create/resolve only**;
mint/redeem/trading are user- or out-of-scope paths.

## Usage

```python
from calibre_onchain import OnchainClient, OnchainConfig

client = OnchainClient(OnchainConfig(
    rpc_url="https://rpc.testnet.arc.network",
    contract_address="0x...",      # deployed CalibreMarket
    resolver_key="0x...",          # the onlyResolver key (never committed)
    chain_id=5042002,              # Arc testnet
))

client.create_market(chain_market_id=42)        # → tx hash
client.resolve(chain_market_id=42, outcome="yes")  # → tx hash
```

`outcome` is the points-side `"yes"` / `"no"` string; it maps to the contract's
`Outcome` enum (`YES = 1`, `NO = 2`; `UNRESOLVED = 0` is rejected by the
contract). web3 is imported only at `OnchainClient(...)` construction, so
`from calibre_onchain import OnchainClient` is safe to do behind a feature flag
without pulling the web3 stack onto a flag-off boot path.
