// Read-only check against the real Sepolia FHEVM, spending nothing: encrypt an invoice amount with Zama's
// testnet relayer (real FHE + real input proof), then eth_call createInvoice on a ConfidentialPayLinks whose
// bytecode is injected with a state override. The real Sepolia InputVerifier/ACL contracts check the proof.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createConfig, memoryStorage, ZamaSDK } from '@zama-fhe/sdk';
import { sepolia } from '@zama-fhe/sdk/chains';
import { node } from '@zama-fhe/sdk/node';
import { ViemProvider } from '@zama-fhe/sdk/viem';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, keccak256, toHex } from 'viem';
import { sepolia as viemSepolia } from 'viem/chains';

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const art = JSON.parse(readFileSync(fileURLToPath(new URL('../../contracts/out/ConfidentialPayLinks.sol/ConfidentialPayLinks.json', import.meta.url)), 'utf8'));
const pub = createPublicClient({ chain: viemSepolia, transport: http(RPC) });
const sdk = new ZamaSDK(createConfig({ chains: [{ ...sepolia, network: RPC }], provider: new ViemProvider({ publicClient: pub }), storage: memoryStorage, relayers: { [sepolia.id]: node() } }));

const contract = '0x00000000000000000000000000000000C0Ff1e00';
// ZamaEthereumConfig's constructor stores the Sepolia host addresses at this namespaced slot (fhevm Impl.sol);
// a code-only override skips the constructor, so set them too (values from ZamaConfig._getSepoliaConfig()).
const CFG = 0x9e7b61f58c47dc699ac88507c4f5bb9f121c03808c5676a8078fe583e4649700n;
const slot = (i) => `0x${(CFG + BigInt(i)).toString(16).padStart(64, '0')}`;
const word = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const override = [{
  address: contract,
  code: null,
  stateDiff: [
    { slot: slot(0), value: word('0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D') }, // ACL
    { slot: slot(1), value: word('0x92C920834Ec8941d2C77D188936E1f7A6f49c127') }, // FHEVMExecutor
    { slot: slot(2), value: word('0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A') }, // KMSVerifier
  ],
}];
const merchant = '0x000000000000000000000000000000000000bEEF';
const cUSDC = '0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639';
const t0 = Date.now();
const enc = await sdk.encrypt({ values: [{ value: 25_000_000n, type: 'euint64' }], contractAddress: contract, userAddress: merchant });
const tEnc = Date.now() - t0;
const nonce = keccak256(toHex('readonly-check'));
const data = encodeFunctionData({ abi: art.abi, functionName: 'createInvoice', args: [nonce, cUSDC, '0x0000000000000000000000000000000000000000', 0, `0x${'00'.repeat(32)}`, enc.encryptedValues[0], enc.inputProof] });
override[0].code = art.deployedBytecode.object;
const res = await pub.call({ account: merchant, to: contract, data, stateOverride: override });
const id = decodeFunctionResult({ abi: art.abi, functionName: 'createInvoice', data: res.data });
const expected = keccak256(`0x${[11155111n, BigInt(contract), BigInt(merchant)].map((v) => v.toString(16).padStart(64, '0')).join('')}${nonce.slice(2)}`);
// Wrong user: a proof made for another address must be rejected by the real InputVerifier.
let wrongUserRejected = false;
try {
  await pub.call({ account: '0x000000000000000000000000000000000000dEaD', to: contract, data, stateOverride: override });
} catch { wrongUserRejected = true; }
const out = { network: 'sepolia', relayer: sepolia.relayerUrl, encryptMs: tEnc, handle: enc.encryptedValues[0], invoiceIdFromCall: id, matchesFormula: id === expected, wrongUserRejected, at: new Date().toISOString() };
mkdirSync(fileURLToPath(new URL('../../e2e-results/', import.meta.url)), { recursive: true });
writeFileSync(fileURLToPath(new URL('../../e2e-results/sepolia-readonly.json', import.meta.url)), JSON.stringify(out, null, 2));
console.log(out);
await sdk.terminate?.();
process.exit(0);
