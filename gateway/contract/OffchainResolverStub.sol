// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title OffchainResolverStub — reference on-chain side for the calibre.eth gateway
 *
 * Reference artifact (W6.2, HANSEL-LI/Calibre#429). The ENS booth designates the
 * real resolver / testnet at the event; this stub makes the gateway's signature
 * scheme self-documenting and lets a real `calibre.eth` (or testnet equivalent)
 * point its offchain resolver at the gateway URL. It mirrors
 * `ensdomains/offchain-resolver` so any compliant ENS client interoperates.
 *
 * Flow (EIP-3668 / ENSIP-10):
 *   1. client calls resolve(name, data) on this contract
 *   2. it reverts OffchainLookup(this, [gatewayUrl], callData, this.resolveWithProof.selector, callData)
 *   3. client POSTs { sender, data } to gatewayUrl, gets abi.encode(result, expires, sig)
 *   4. client calls resolveWithProof(response, extraData); the contract verifies
 *      the signer is allowlisted and the signature covers (target, expires,
 *      keccak(request), keccak(result)), then returns `result`.
 *
 * NOT deployed by this repo — deployment + ENS wiring is a demo-day op gated on
 * the booth-designated resolver address (see GATEWAY_RESOLVER_ADDRESS).
 */

interface IExtendedResolver {
    function resolve(bytes memory name, bytes memory data) external view returns (bytes memory);
}

error OffchainLookup(
    address sender,
    string[] urls,
    bytes callData,
    bytes4 callbackFunction,
    bytes extraData
);

contract OffchainResolverStub is IExtendedResolver {
    string public url;
    mapping(address => bool) public signers;

    constructor(string memory _url, address[] memory _signers) {
        url = _url;
        for (uint256 i = 0; i < _signers.length; i++) {
            signers[_signers[i]] = true;
        }
    }

    /// @dev ENSIP-10 entrypoint. Always defers to the offchain gateway.
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        override
        returns (bytes memory)
    {
        bytes memory callData = abi.encodeWithSelector(IExtendedResolver.resolve.selector, name, data);
        string[] memory urls = new string[](1);
        urls[0] = url;
        revert OffchainLookup(address(this), urls, callData, this.resolveWithProof.selector, callData);
    }

    /// @dev EIP-3668 callback. Verifies the gateway signature, returns the record.
    function resolveWithProof(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bytes memory)
    {
        (bytes memory result, uint64 expires, bytes memory sig) =
            abi.decode(response, (bytes, uint64, bytes));
        require(expires >= block.timestamp, "resolver: signature expired");

        bytes32 hash = makeSignatureHash(address(this), expires, extraData, result);
        address signer = recover(hash, sig);
        require(signers[signer], "resolver: untrusted signer");
        return result;
    }

    /// @dev The signed message: keccak(0x1900 || target || expires || keccak(request) || keccak(result)).
    function makeSignatureHash(address target, uint64 expires, bytes memory request, bytes memory result)
        public
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(hex"1900", target, expires, keccak256(request), keccak256(result))
        );
    }

    /// @dev Minimal ecrecover for a 65-byte (r,s,v) signature.
    function recover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "resolver: bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        return ecrecover(hash, v, r, s);
    }
}
