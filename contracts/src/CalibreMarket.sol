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
        // transferFrom reverts on failure (and under Arc's forbidden-target
        // rules), so a credit only ever follows a real receipt.
        usdc.transferFrom(msg.sender, address(this), sets * usdcUnit);

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
        usdc.transfer(msg.sender, usdcOut);
        emit Redeemed(chainMarketId, msg.sender, shares, usdcOut);
    }
}
