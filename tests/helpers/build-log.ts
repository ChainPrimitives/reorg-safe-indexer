import { Interface } from "ethers";
import type { MockLog } from "./mock-provider";

export const TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const iface = new Interface(TRANSFER_ABI);

/**
 * Build a realistically ABI-encoded `Transfer` log so tests exercise the same
 * decoding path as production.
 */
export function buildTransferLog(params: {
  blockNumber: number;
  blockHash: string;
  txHash: string;
  index: number;
  address: string;
  from: string;
  to: string;
  value: bigint;
  removed?: boolean;
}): MockLog {
  const encoded = iface.encodeEventLog("Transfer", [
    params.from,
    params.to,
    params.value,
  ]);
  return {
    blockNumber: params.blockNumber,
    blockHash: params.blockHash,
    transactionHash: params.txHash,
    index: params.index,
    address: params.address,
    topics: [...encoded.topics],
    data: encoded.data,
    removed: params.removed ?? false,
  };
}

export const ADDR_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const ADDR_ALICE = "0x1111111111111111111111111111111111111111";
export const ADDR_BOB = "0x2222222222222222222222222222222222222222";
