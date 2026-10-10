import { describe, expect, it } from 'vitest';
import { GAS_FLOORS, gasLimitFor, looksOutOfGas, TX_GAS_CAP } from '../src/gas';

describe('gasLimitFor', () => {
  it('uses the floor when the estimate is low or missing', () => {
    expect(gasLimitFor('createInvoice', 1_309_469n)).toBe(GAS_FLOORS.createInvoice); // 1.96M < 2.8M floor
    expect(gasLimitFor('createInvoice', undefined)).toBe(GAS_FLOORS.createInvoice);
    expect(gasLimitFor('somethingElse', undefined)).toBe(1_000_000n);
  });
  it('pads the estimate by 50% when that is above the floor', () => {
    expect(gasLimitFor('createInvoice', 1_985_289n)).toBe(2_977_933n); // fixed payer, measured on Sepolia
    expect(gasLimitFor('confidentialTransferAndCall', 4_701_641n)).toBe(7_052_461n);
  });
  it('never exceeds the per-transaction cap', () => {
    expect(gasLimitFor('confidentialTransferAndCall', 15_000_000n)).toBe(TX_GAS_CAP - 1n);
  });
  it('covers every write the app sends with a floor above the real failure (1.83M createInvoice)', () => {
    for (const f of ['createInvoice', 'confidentialTransferAndCall', 'mint', 'approve', 'wrap', 'addViewer', 'cancelInvoice', 'publishPaidStatus', 'confirmPaidStatus'])
      expect(GAS_FLOORS[f], f).toBeGreaterThan(0n);
    expect(GAS_FLOORS.createInvoice).toBeGreaterThan(1_830_132n);
  });
});

describe('looksOutOfGas', () => {
  it('flags reverts that used ~all their gas', () => {
    expect(looksOutOfGas(1_829_000n, 1_830_132n)).toBe(true);
    expect(looksOutOfGas(100_000n, 1_830_132n)).toBe(false);
    expect(looksOutOfGas(100_000n, undefined)).toBe(false);
  });
});
