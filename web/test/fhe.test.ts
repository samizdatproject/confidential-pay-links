import { RelayerRequestFailedError, SigningRejectedError, NotEntitledError } from '@zama-fhe/sdk';
import { describe, expect, it, vi } from 'vitest';
import { fheErrorText, isTransient, withRetry } from '../src/fhe';

const relayerError = (statusCode: number) =>
  Object.assign(Object.create(RelayerRequestFailedError.prototype), { code: 'RELAYER_REQUEST_FAILED', statusCode, message: `HTTP ${statusCode}`, retryable: statusCode >= 500 || statusCode === 429 });

describe('isTransient', () => {
  it('retries relayer outages, rate limits and network failures', () => {
    expect(isTransient(relayerError(503))).toBe(true);
    expect(isTransient(relayerError(429))).toBe(true);
    expect(isTransient(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransient(new Error('request timed out'))).toBe(true);
  });

  it('does not retry terminal errors', () => {
    expect(isTransient(relayerError(400))).toBe(false);
    expect(isTransient(Object.assign(Object.create(SigningRejectedError.prototype), { code: 'SIGNING_REJECTED', retryable: false }))).toBe(false);
    expect(isTransient(Object.assign(Object.create(NotEntitledError.prototype), { code: 'NOT_ENTITLED', retryable: false }))).toBe(false);
    expect(isTransient(new Error('execution reverted'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries transient failures with backoff and reports pending states', async () => {
    vi.useFakeTimers();
    const op = vi.fn().mockRejectedValueOnce(relayerError(503)).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(42);
    const states: string[] = [];
    const p = withRetry(op, { label: 'Decrypting', baseDelayMs: 1000, onProgress: (s) => states.push(s.message) });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(42);
    expect(op).toHaveBeenCalledTimes(3);
    expect(states.some((s) => /Retrying in 1 s/.test(s))).toBe(true);
    expect(states.some((s) => /Retrying in 2 s/.test(s))).toBe(true);
    expect(states.at(-1)).toMatch(/attempt 3 of 4/);
    vi.useRealTimers();
  });

  it('gives up after the last attempt', async () => {
    vi.useFakeTimers();
    const op = vi.fn().mockRejectedValue(relayerError(502));
    const p = withRetry(op, { label: 'x', attempts: 3, baseDelayMs: 10 });
    const settled = expect(p).rejects.toMatchObject({ statusCode: 502 });
    await vi.runAllTimersAsync();
    await settled;
    expect(op).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('throws terminal errors at once', async () => {
    const op = vi.fn().mockRejectedValue(new Error('execution reverted'));
    await expect(withRetry(op, { label: 'x' })).rejects.toThrow('execution reverted');
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe('fheErrorText', () => {
  it('explains relayer outages without blaming the user', () => {
    expect(fheErrorText(relayerError(503))).toMatch(/unavailable right now/);
  });
});
