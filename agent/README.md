# calibre_agent

Standalone open-source on-chain market-maker agent. It runs from its own Dynamic
server wallet, reads calibre's live public market price as its prior, and quotes
/ trades on the Arc `CalibreMarket` contract.

W0 scaffold — package skeleton only. This is a **new** agent created during the
hackathon, not a mirror of the private bot fleet: archetype bodies, `behavior`,
and the PM-anchor stack stay private; on-chain agents are new pseudonymous
personas (addresses, no names). Implementation lands in W7.2.
