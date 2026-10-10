import { describe, expect, it } from 'vitest';
import { chainIdFrom, firstAccount, sameAccount } from '../src/account';

describe('account helpers', () => {
  it('reads the first account of an accountsChanged payload', () => {
    expect(firstAccount(['0x7178e85cE66fadE2eD97bcB81B4e955A4ec86eFb', '0x63303434a68D715c0Ed3c4abAC4236588e460AF8'])).toBe('0x7178e85cE66fadE2eD97bcB81B4e955A4ec86eFb');
    expect(firstAccount([])).toBeUndefined();
    expect(firstAccount(['nope'])).toBeUndefined();
    expect(firstAccount(undefined)).toBeUndefined();
  });
  it('parses chainChanged hex ids', () => {
    expect(chainIdFrom('0xaa36a7')).toBe(11155111);
    expect(chainIdFrom('11155111')).toBeUndefined();
    expect(chainIdFrom(5)).toBeUndefined();
  });
  it('compares accounts case-insensitively and never equal when missing', () => {
    expect(sameAccount('0xAbC', '0xabc')).toBe(true);
    expect(sameAccount(undefined, undefined)).toBe(false);
    expect(sameAccount('0xabc', undefined)).toBe(false);
  });
});
