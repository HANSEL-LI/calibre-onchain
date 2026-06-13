/**
 * EIP-3668 / ENS offchain-resolver response signing.
 *
 * The scheme matches `ensdomains/offchain-resolver` so any compliant ENS client
 * (viem/ethers) following the `OffchainLookup` interoperates:
 *
 *   hash = keccak256(abi.encodePacked(
 *            0x1900,                 // EIP-191 version-0x00 prefix
 *            address target,         // the resolver contract that reverted
 *            uint64  expires,        // signature validity deadline (unix secs)
 *            bytes32 keccak256(request),  // original resolve(name,data) calldata
 *            bytes32 keccak256(result)))  // ABI-encoded record answer
 *
 * The gateway signs `hash` with GATEWAY_SIGNER_KEY and returns
 *   abi.encode(bytes result, uint64 expires, bytes sig)
 * which the resolver's callback verifies against its signer allowlist before
 * returning `result` to the client.
 */
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodePacked,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** The signature hash, per the ENS offchain-resolver scheme above. */
export function makeSignatureHash(
  target: Address,
  expires: bigint,
  request: Hex,
  result: Hex,
): Hex {
  return keccak256(
    encodePacked(
      ["bytes2", "address", "uint64", "bytes32", "bytes32"],
      ["0x1900", target, expires, keccak256(request), keccak256(result)],
    ),
  );
}

export interface SignedResponse {
  /** ABI-encoded (bytes result, uint64 expires, bytes sig) for the HTTP body. */
  data: Hex;
  expires: bigint;
}

/**
 * Sign a record answer for the EIP-3668 callback.
 *
 * @param signerKey  GATEWAY_SIGNER_KEY (32-byte hex).
 * @param target     resolver address from the request's extraData.
 * @param request    original resolve(name,data) calldata being answered.
 * @param result     ABI-encoded record answer (addr/text), possibly empty.
 * @param ttlSeconds signature lifetime; default 300s.
 */
export async function signResult(
  signerKey: Hex,
  target: Address,
  request: Hex,
  result: Hex,
  ttlSeconds = 300,
): Promise<SignedResponse> {
  const account = privateKeyToAccount(signerKey);
  const expires = BigInt(Math.floor(Date.now() / 1000) + ttlSeconds);
  const hash = makeSignatureHash(target, expires, request, result);
  const sig = await account.sign({ hash });
  const data = encodeAbiParameters(
    [{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }],
    [result, expires, sig],
  );
  return { data, expires };
}
