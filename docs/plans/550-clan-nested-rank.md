# #550 — Discord bot: clan-nested rank resolution

Tracking issue: `HANSEL-LI/Calibre#550` (P1). Part of #545. Finishes the
clan-as-subname-registry angle: `<user>.<clan>.hicalibre.eth` must resolve the
**user leaf** end-to-end. The gateway already does this (W6.3, `displayNameFor`);
the Discord bot's nested path was stubbed behind the now-closed #430.

## Plan

1. **Lift the top-level-only restriction in `discord-bot/src/rank.ts`.**
   `isAcceptedName` currently rejects any name with more than one label under the
   parent (the `head.includes(".")` guard). Replace that with: accept any name
   ending in `.<parent>` whose leftmost label is the user, matching the gateway's
   `displayNameFor` leftmost-label contract exactly. The bare parent, foreign
   suffixes, and empty leftmost labels stay rejected.
2. **Add tests** for `<user>.<clan>.<parent>` (accept + resolve), deeper nesting,
   the existing `<user>.<parent>` (no regression), and graceful misses. Update the
   stale "rejects clan-nested" test to assert the new accept behavior.
3. `npm test` green in `discord-bot`; confirm `gateway` already covers nested
   resolution (no gateway change expected).

## Contract boundary

The bot's accepted-name + leftmost-label semantics must agree byte-for-byte with
the gateway's `displayNameFor` (`labels.length > 2` → `labels[0]`). Both are pure,
parent-agnostic, leftmost-label extraction. Parent name is `hicalibre.eth`.
