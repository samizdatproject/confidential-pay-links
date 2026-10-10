import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { payLinksAbi } from '../src/abi.generated';
import {
  checkDetails,
  decodeLink,
  detailsHashOf,
  encodeLink,
  formatAmount,
  invoiceIdOf,
  MAX_UINT64,
  parseAmount,
  randomBytes32,
  type PayLink,
} from '../src/link';

const nonce1 = `0x${'0'.repeat(63)}1` as const;

describe('invoiceIdOf', () => {
  it('matches the Solidity vector (contracts/test test_invoiceId_vector)', () => {
    expect(
      invoiceIdOf(31337, '0x5FbDB2315678afecb367f032d93F642f64180aa3', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', nonce1),
    ).toBe('0xcb10e8b297c3ee03508b03f6ce4ed47f9d6a903b794ebbab8689351b60962dbd');
  });

  it('is bound to chain, contract, merchant and nonce', () => {
    const c = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
    const m = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const id = invoiceIdOf(31337, c, m, nonce1);
    expect(invoiceIdOf(11155111, c, m, nonce1)).not.toBe(id);
    expect(invoiceIdOf(31337, '0x5fbdb2315678afecb367f032d93f642f64180aa4', m, nonce1)).not.toBe(id);
    expect(invoiceIdOf(31337, c, '0x70997970c51812dc3a010c7d01b50e0d17dc79c9', nonce1)).not.toBe(id);
    expect(invoiceIdOf(31337, c, m, `0x${'0'.repeat(63)}2`)).not.toBe(id);
  });
});

describe('link details commitment', () => {
  const base: PayLink = { chainId: 11155111, invoiceId: `0x${'ab'.repeat(32)}`, salt: `0x${'cd'.repeat(32)}`, memo: 'Invoice #7', amount: 25_000_000n };

  it('verifies an untouched link and flags any edit', () => {
    const onChain = detailsHashOf(base);
    expect(checkDetails(base, onChain)).toBe('verified');
    expect(checkDetails({ ...base, memo: 'Invoice #8' }, onChain)).toBe('modified');
    expect(checkDetails({ ...base, amount: 24_000_000n }, onChain)).toBe('modified');
    expect(checkDetails({ ...base, amount: undefined }, onChain)).toBe('modified');
    expect(checkDetails({ ...base, salt: randomBytes32() }, onChain)).toBe('modified');
  });

  it('commits to the absence of an amount', () => {
    const noAmount = { ...base, amount: undefined };
    const onChain = detailsHashOf(noAmount);
    expect(checkDetails(noAmount, onChain)).toBe('verified');
    expect(checkDetails({ ...noAmount, amount: 1n }, onChain)).toBe('modified');
  });

  it('is case-insensitive on the stored hash', () => {
    expect(checkDetails(base, detailsHashOf(base).toUpperCase().replace('0X', '0x') as `0x${string}`)).toBe('verified');
  });
});

describe('encode / decode', () => {
  const link: PayLink = { chainId: 11155111, invoiceId: randomBytes32(), salt: randomBytes32(), memo: 'café ☕ #42', amount: 1_234_567n };

  it('round-trips', () => {
    expect(decodeLink(encodeLink(link))).toEqual(link);
    const noAmt = { ...link, amount: undefined, memo: '' };
    expect(decodeLink(encodeLink(noAmt))).toEqual(noAmt);
  });

  it('keeps the amount in base units (no decimals in the URL)', () => {
    expect(encodeLink(link)).toContain('a=1234567');
  });

  it('rejects malformed links', () => {
    const q = new URLSearchParams(encodeLink(link));
    const bad = (k: string, v: string | null) => {
      const p = new URLSearchParams(q);
      if (v === null) p.delete(k);
      else p.set(k, v);
      return () => decodeLink(p.toString());
    };
    expect(bad('id', null)).toThrow(/missing "id"/);
    expect(bad('id', '0x1234')).toThrow(/invoice id/);
    expect(bad('s', '0xzz')).toThrow(/salt/);
    expect(bad('a', '-5')).toThrow(/amount/i);
    expect(bad('a', '1.5')).toThrow(/amount/i);
    expect(bad('a', '0')).toThrow(/amount/i);
    expect(bad('a', (MAX_UINT64 + 1n).toString())).toThrow(/amount/i);
    expect(bad('c', 'abc')).toThrow(/chain/);
  });

  it('rejects hidden and direction-changing characters in the memo', () => {
    for (const ch of [
      '\u202E', '\u200B', '\u2066', '\uFEFF', '\u00AD', '\u{E0041}', '\uFE0F', '\u{E0100}', '\u2028', '\u2029',
      '\u206A', '\u180B', '\u17B4', '\uFFF9', '\u2800', '\u{1D173}', '\u0085', '\u0007', '\n', '\u009B',
    ]) {
      expect(() => encodeLink({ ...link, memo: `pay${ch}me` })).toThrow(/invisible/);
    }
  });

  it('still allows ordinary text, accents and simple emoji', () => {
    expect(() => encodeLink({ ...link, memo: 'Facture n°42 — café 🍰 日本' })).not.toThrow();
  });

  it('limits memo length in bytes', () => {
    expect(() => encodeLink({ ...link, memo: 'é'.repeat(71) })).toThrow(/longer/);
    expect(() => encodeLink({ ...link, memo: 'é'.repeat(70) })).not.toThrow();
  });
});

describe('amounts', () => {
  it('parses with token decimals and enforces uint64', () => {
    expect(parseAmount('25', 6)).toBe(25_000_000n);
    expect(parseAmount('0.000001', 6)).toBe(1n);
    expect(() => parseAmount('0.0000001', 6)).toThrow(/decimals/);
    expect(() => parseAmount('0', 6)).toThrow(/greater than zero/);
    expect(() => parseAmount('1e3', 6)).toThrow(/number/);
    expect(() => parseAmount('18446744073709.551616', 6)).toThrow(/uint64/);
    expect(parseAmount('18446744073709.551615', 6)).toBe(MAX_UINT64);
    expect(formatAmount(25_500_000n, 6)).toBe('25.5');
  });
});

describe('ABI', () => {
  it('matches the Foundry build', () => {
    const art = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../contracts/out/ConfidentialPayLinks.sol/ConfidentialPayLinks.json', import.meta.url)), 'utf8'),
    );
    expect(payLinksAbi).toEqual(art.abi);
  });
});
