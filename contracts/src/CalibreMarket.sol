// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

/// @title CalibreMarket
/// @notice On-chain settlement core for calibre prediction markets, denominated
///         in USDC on Arc under the A-lite custody model: the LMSR pricing engine
///         stays off-chain; this contract handles only the custody-independent
///         primitives — complete-set mint, share transfer, resolve, and redeem.
/// @dev    W1.1 — custody-INDEPENDENT core. There is deliberately NO EIP-712
///         voucher logic here; that is W1.2 (HANSEL-LI/Calibre#422), which extends
///         this contract by crediting/debiting the same `yesBalance`/`noBalance`
///         storage from a signature-verified buy/redeem path. Solvent by
///         construction: every outstanding (YES + NO) pair is backed by exactly
///         one USDC unit locked at mint.
///
///         USDC decimals (W8 spike §3): Arc's *native* USDC gas token is
///         18-decimal, but the ERC-20 USDC interface is 6-decimal. All accounting
///         here goes exclusively through `IERC20`; `usdcUnit` is read from
///         `token.decimals()` at construction, so one complete set always locks
///         exactly `10**decimals` base units regardless of the deployed token.
contract CalibreMarket {
    /// @notice Resolution state of a market. UNRESOLVED until the resolver settles.
    enum Outcome {
        UNRESOLVED,
        YES,
        NO
    }

    struct Market {
        bool exists;
        Outcome outcome;
    }

    /// @notice The 6-decimal ERC-20 USDC token shares mint/redeem against.
    IERC20 public immutable usdc;

    /// @notice USDC base units that one complete set costs to mint / pays to
    ///         redeem: `10**usdc.decimals()`. Read once at construction.
    uint256 public immutable usdcUnit;

    /// @notice Authorized role for createMarket / resolve. A throwaway weekend
    ///         key at deploy; W1.3 hands it off to the backend resolver signer.
    address public resolver;

    // ---------------------------------------------------------------------
    // A-lite EIP-712 voucher extension (W1.2, #422) — STATE.
    // Isolated, excisable surface: if the W1.3 Saturday-noon checkpoint fails
    // and custody degrades to Model B, everything tagged "A-lite voucher
    // extension" can be removed without touching the mint/resolve/redeem core.
    // ---------------------------------------------------------------------

    /// @notice The backend key whose EIP-712 signature authorizes a `buy`. This
    ///         is calibre's standing-counterparty quote signer (W8 spike §5: a
    ///         hot env-var key in backend memory). Resolver-managed; rotatable.
    address public voucherSigner;

    /// @notice The address that holds pre-minted share inventory a `buy` draws
    ///         from. Calibre fronts the USDC at `seedInventory` to lock complete
    ///         sets here; buyers reimburse it for the side they take. Kept
    ///         distinct from `voucherSigner` so the hot signing key can rotate
    ///         without moving inventory.
    address public counterparty;

    /// @notice buyer => next expected voucher nonce. Per-user monotonic; replay
    ///         protection — a captured voucher is single-use.
    mapping(address => uint256) public nonces;

    /// @notice chainMarketId => max total USDC (6-dec base units) `buy` may pull
    ///         on that market. 0 disables the cap. Belt-and-suspenders bound
    ///         (W8 §5, ~1,000 USDC) so a fully-compromised signer still can't
    ///         mint unbounded exposure on one market. This is a CUMULATIVE
    ///         LIFETIME ceiling per market — `marketNotionalUsed` is never
    ///         decremented — not a concurrent / windowed exposure bound. Markets
    ///         are one-shot (single `resolve`), so lifetime == relevant exposure.
    mapping(uint256 => uint256) public marketNotionalCap;

    /// @notice chainMarketId => cumulative USDC (6-dec) ever pulled via `buy`.
    ///         Monotonically increasing; compared against `marketNotionalCap`.
    mapping(uint256 => uint256) public marketNotionalUsed;

    /// @notice chainMarketId => market state.
    mapping(uint256 => Market) public markets;

    /// @notice chainMarketId => holder => YES shares.
    mapping(uint256 => mapping(address => uint256)) public yesBalance;

    /// @notice chainMarketId => holder => NO shares.
    mapping(uint256 => mapping(address => uint256)) public noBalance;

    event ResolverChanged(address indexed previous, address indexed next);
    event MarketCreated(uint256 indexed chainMarketId);
    event Minted(uint256 indexed chainMarketId, address indexed account, uint256 sets);
    event SharesTransferred(
        uint256 indexed chainMarketId, bool isYes, address indexed from, address indexed to, uint256 amount
    );
    event Resolved(uint256 indexed chainMarketId, Outcome outcome);
    event Redeemed(uint256 indexed chainMarketId, address indexed account, uint256 shares, uint256 usdcOut);

    error NotResolver();
    error ZeroAddress();
    error MarketExists();
    error UnknownMarket();
    error ZeroSets();
    error AlreadyResolved();
    error InvalidOutcome();
    error NotResolved();
    error NothingToRedeem();
    error InsufficientShares();
    error UsdcTransferFailed();

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    /// @param usdc_ The 6-decimal ERC-20 USDC token on Arc (parameterized per deploy).
    /// @param resolver_ The initial resolver authority.
    constructor(IERC20 usdc_, address resolver_) {
        if (address(usdc_) == address(0) || resolver_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        usdcUnit = 10 ** uint256(usdc_.decimals());
        resolver = resolver_;
        emit ResolverChanged(address(0), resolver_);

        // A-lite voucher extension (W1.2): cache the EIP-712 domain separator.
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    /// @notice Hand the resolver role to a new address. Lets W1.3 migrate from the
    ///         deploy key to the backend signer. Guarded by the current resolver.
    function setResolver(address next) external onlyResolver {
        if (next == address(0)) revert ZeroAddress();
        emit ResolverChanged(resolver, next);
        resolver = next;
    }

    /// @notice Register a new binary market. Resolver-only; ids are minted off-chain.
    function createMarket(uint256 chainMarketId) external onlyResolver {
        if (markets[chainMarketId].exists) revert MarketExists();
        markets[chainMarketId] = Market({exists: true, outcome: Outcome.UNRESOLVED});
        emit MarketCreated(chainMarketId);
    }

    /// @notice Mint `sets` complete sets: pull `sets * usdcUnit` USDC from the
    ///         caller and credit `sets` YES + `sets` NO shares. Solvent by
    ///         construction — the locked USDC exactly backs the minted pair.
    function mint(uint256 chainMarketId, uint256 sets) external {
        if (!markets[chainMarketId].exists) revert UnknownMarket();
        if (sets == 0) revert ZeroSets();

        // We must receive funds before crediting, so pull then credit.
        // _safeTransferFrom reverts on failure (and under Arc's forbidden-target
        // rules), so a credit only ever follows a real receipt.
        _safeTransferFrom(msg.sender, address(this), sets * usdcUnit);

        yesBalance[chainMarketId][msg.sender] += sets;
        noBalance[chainMarketId][msg.sender] += sets;
        emit Minted(chainMarketId, msg.sender, sets);
    }

    /// @notice Transfer `amount` of one side's shares to another holder. The
    ///         minimal "share transfer" primitive; W1.2's voucher path moves the
    ///         same balances under a signature.
    function transferShares(uint256 chainMarketId, bool isYes, address to, uint256 amount) external {
        if (!markets[chainMarketId].exists) revert UnknownMarket();
        if (to == address(0)) revert ZeroAddress();

        mapping(address => uint256) storage side = isYes ? yesBalance[chainMarketId] : noBalance[chainMarketId];
        if (side[msg.sender] < amount) revert InsufficientShares();
        side[msg.sender] -= amount;
        side[to] += amount;
        emit SharesTransferred(chainMarketId, isYes, msg.sender, to, amount);
    }

    /// @notice Settle a market once. Resolver-only, one-shot, YES|NO only.
    function resolve(uint256 chainMarketId, Outcome outcome) external onlyResolver {
        Market storage m = markets[chainMarketId];
        if (!m.exists) revert UnknownMarket();
        if (m.outcome != Outcome.UNRESOLVED) revert AlreadyResolved();
        if (outcome != Outcome.YES && outcome != Outcome.NO) revert InvalidOutcome();
        m.outcome = outcome;
        emit Resolved(chainMarketId, outcome);
    }

    /// @notice Redeem the caller's winning-side shares 1:1 for USDC. Losing-side
    ///         shares are worthless and are not touched. Checks-effects-interactions:
    ///         the balance is zeroed before the external transfer.
    function redeem(uint256 chainMarketId) external {
        Market storage m = markets[chainMarketId];
        if (!m.exists) revert UnknownMarket();
        if (m.outcome == Outcome.UNRESOLVED) revert NotResolved();

        bool yesWon = m.outcome == Outcome.YES;
        mapping(address => uint256) storage winning = yesWon ? yesBalance[chainMarketId] : noBalance[chainMarketId];

        uint256 shares = winning[msg.sender];
        if (shares == 0) revert NothingToRedeem();

        winning[msg.sender] = 0;
        uint256 usdcOut = shares * usdcUnit;
        _safeTransfer(msg.sender, usdcOut);
        emit Redeemed(chainMarketId, msg.sender, shares, usdcOut);
    }

    /// @dev Wrap `IERC20.transfer` to honor both reverting and false-returning
    ///      ERC-20 implementations. Arc USDC reverts on failure; checking the
    ///      boolean return value is defensive and silences the unchecked-transfer
    ///      lint. A `false` return is treated as failure.
    function _safeTransfer(address to, uint256 amount) internal {
        if (!usdc.transfer(to, amount)) revert UsdcTransferFailed();
    }

    /// @dev See `_safeTransfer`; pulls `amount` from `from` to this contract.
    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        if (!usdc.transferFrom(from, to, amount)) revert UsdcTransferFailed();
    }

    // =====================================================================
    // A-lite EIP-712 voucher extension (W1.2, #422)
    //
    // Adds a backend-signed price-voucher buy path on top of the W1.1 core.
    // Calibre is the STANDING COUNTERPARTY: price discovery stays in the
    // off-chain LMSR; this contract verifies an EIP-712 voucher signed by
    // `voucherSigner`, then atomically pulls USDC from the buyer and transfers
    // shares from pre-minted `counterparty` inventory. Because shares move from
    // already-minted, already-backed inventory, the W1.1 solvency invariant
    // (every outstanding YES+NO pair backed by exactly one locked USDC unit) is
    // UNCHANGED by a buy. No on-chain pricing.
    //
    // This whole section is self-contained and references the core only through
    // the existing `yesBalance`/`noBalance` storage and `_safeTransferFrom`, so
    // it can be excised cleanly if W1.3 degrades custody to Model B (briefing §3).
    // =====================================================================

    /// @dev EIP-712 domain typehash.
    bytes32 internal constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev The Quote typehash. Field order is the FROZEN W1.2<->W3.1 interface;
    ///      the backend signer (W3.1) must encode byte-for-byte the same. `side`
    ///      is 0=NO, 1=YES (maps to the core's `isYes`). `maxCost` is 6-decimal
    ///      ERC-20 USDC base units (W8 §3 — never the 18-dec native asset).
    bytes32 internal constant _QUOTE_TYPEHASH = keccak256(
        "Quote(uint256 marketId,address buyer,uint8 side,uint256 size,uint256 maxCost,uint256 nonce,uint256 expiry)"
    );

    /// @notice EIP-712 domain fields (W8 §3: chainId 5042002 on Arc testnet).
    string public constant EIP712_NAME = "CalibreMarket";
    string public constant EIP712_VERSION = "1";

    /// @dev Cached domain separator + the chainId it was built for. Recomputed
    ///      if `block.chainid` ever differs (fork safety).
    bytes32 private _cachedDomainSeparator;
    uint256 private _cachedChainId;

    /// @notice A backend price voucher. Verified by `buy`. See `_QUOTE_TYPEHASH`.
    struct Quote {
        uint256 marketId; // chainMarketId the shares belong to
        address buyer; // the only address allowed to redeem this voucher (== msg.sender)
        uint8 side; // 0 = NO, 1 = YES
        uint256 size; // shares to credit the buyer
        uint256 maxCost; // signed slippage ceiling, 6-dec USDC; pulled cost must be <=
        uint256 nonce; // per-buyer monotonic; replay protection
        uint256 expiry; // unix ts; signer sets <=30s out (W8 §5); contract checks < expiry
    }

    event VoucherSignerChanged(address indexed previous, address indexed next);
    event CounterpartyChanged(address indexed previous, address indexed next);
    event MarketNotionalCapSet(uint256 indexed chainMarketId, uint256 cap);
    event InventorySeeded(uint256 indexed chainMarketId, uint256 sets);
    event Bought(
        uint256 indexed chainMarketId,
        address indexed buyer,
        bool isYes,
        uint256 size,
        uint256 cost,
        uint256 nonce
    );

    error SignerUnset();
    error CounterpartyUnset();
    error InvalidSide();
    error VoucherExpired();
    error BadNonce();
    error WrongBuyer();
    error MaxCostExceeded();
    error BadSignature();
    error NotionalCapExceeded();

    /// @notice Set the EIP-712 voucher signing key. Resolver-only; rotatable.
    function setVoucherSigner(address next) external onlyResolver {
        if (next == address(0)) revert ZeroAddress();
        emit VoucherSignerChanged(voucherSigner, next);
        voucherSigner = next;
    }

    /// @notice Set the address holding pre-minted share inventory. Resolver-only.
    function setCounterparty(address next) external onlyResolver {
        if (next == address(0)) revert ZeroAddress();
        emit CounterpartyChanged(counterparty, next);
        counterparty = next;
    }

    /// @notice Optional per-market USDC notional cap on `buy` (W8 §5). 0 disables.
    function setMarketNotionalCap(uint256 chainMarketId, uint256 cap) external onlyResolver {
        if (!markets[chainMarketId].exists) revert UnknownMarket();
        marketNotionalCap[chainMarketId] = cap;
        emit MarketNotionalCapSet(chainMarketId, cap);
    }

    /// @notice Seed `sets` complete sets of inventory into `counterparty`: pull
    ///         `sets * usdcUnit` USDC from `counterparty` (which fronts its own
    ///         backing) and credit it `sets` YES + `sets` NO shares. This is the
    ///         standing-counterparty's locked backing; buyers later reimburse it
    ///         for the side they take in `buy`.
    /// @dev    Resolver-only (the resolver triggers seeding; the USDC comes from
    ///         the `counterparty`, which must have approved this contract).
    ///         Identical solvency math to `mint` — every seeded pair locks
    ///         exactly one USDC unit — so the W1.1 invariant holds.
    function seedInventory(uint256 chainMarketId, uint256 sets) external onlyResolver {
        if (counterparty == address(0)) revert CounterpartyUnset();
        if (!markets[chainMarketId].exists) revert UnknownMarket();
        if (sets == 0) revert ZeroSets();

        _safeTransferFrom(counterparty, address(this), sets * usdcUnit);
        yesBalance[chainMarketId][counterparty] += sets;
        noBalance[chainMarketId][counterparty] += sets;
        emit InventorySeeded(chainMarketId, sets);
    }

    /// @notice The EIP-712 domain separator (recomputed on a chainId change).
    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == _cachedChainId) return _cachedDomainSeparator;
        return _buildDomainSeparator();
    }

    /// @notice Hash a Quote under EIP-712 (the digest `voucherSigner` signs).
    ///         Exposed for the W3.1 reference signer to assert parity against.
    function hashQuote(Quote calldata q) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(_QUOTE_TYPEHASH, q.marketId, q.buyer, q.side, q.size, q.maxCost, q.nonce, q.expiry)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Execute a backend-signed price voucher: verify the EIP-712
    ///         signature against `voucherSigner`, enforce buyer / expiry /
    ///         monotonic nonce / `maxCost` / optional notional cap, then pull
    ///         `cost` USDC from the buyer to `counterparty` and transfer `q.size`
    ///         shares of the signed side from counterparty inventory to the buyer.
    /// @param  q    the signed quote.
    /// @param  cost the USDC (6-dec base units) actually charged; must be
    ///              `<= q.maxCost`. The off-chain LMSR sets it ≤ the quoted price;
    ///              `maxCost` (= quote × 1.01, W8 §5) is the signed leak ceiling.
    /// @param  sig  the 65-byte ECDSA signature over `hashQuote(q)`.
    function buy(Quote calldata q, uint256 cost, bytes calldata sig) external {
        if (voucherSigner == address(0)) revert SignerUnset();
        if (counterparty == address(0)) revert CounterpartyUnset();
        if (!markets[q.marketId].exists) revert UnknownMarket();
        if (q.side > 1) revert InvalidSide();
        if (q.size == 0) revert ZeroSets();
        if (msg.sender != q.buyer) revert WrongBuyer();
        if (block.timestamp >= q.expiry) revert VoucherExpired();
        if (q.nonce != nonces[q.buyer]) revert BadNonce();
        if (cost > q.maxCost) revert MaxCostExceeded();

        // Verify the voucher signature BEFORE any state change.
        if (_recover(hashQuote(q), sig) != voucherSigner) revert BadSignature();

        // Optional per-market notional cap (belt-and-suspenders, W8 §5).
        uint256 cap = marketNotionalCap[q.marketId];
        if (cap != 0 && marketNotionalUsed[q.marketId] + cost > cap) revert NotionalCapExceeded();

        // Effects: burn the nonce (single-use) and book the notional before the
        // external USDC pull (checks-effects-interactions).
        nonces[q.buyer] = q.nonce + 1;
        marketNotionalUsed[q.marketId] += cost;

        // Move shares from counterparty inventory to the buyer. Reverts on
        // InsufficientShares if the signer quoted beyond seeded inventory.
        bool isYes = q.side == 1;
        mapping(address => uint256) storage book = isYes ? yesBalance[q.marketId] : noBalance[q.marketId];
        if (book[counterparty] < q.size) revert InsufficientShares();
        book[counterparty] -= q.size;
        book[q.buyer] += q.size;

        // Pull the buyer's USDC to the counterparty (reimburses the set it fronted).
        if (cost != 0) _safeTransferFrom(q.buyer, counterparty, cost);

        emit Bought(q.marketId, q.buyer, isYes, q.size, cost, q.nonce);
    }

    /// @dev Build the EIP-712 domain separator for the current chain.
    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(EIP712_NAME)),
                keccak256(bytes(EIP712_VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev Recover the signer of a 65-byte (r,s,v) ECDSA signature over `digest`.
    ///      Rejects malformed lengths and high-s malleable signatures (EIP-2).
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        // Reject the upper half of the curve order (signature malleability, EIP-2).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
