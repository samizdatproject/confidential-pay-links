import { beforeEach, describe, expect, it } from 'vitest';
import { _resetDiscovery, choose, discoverProviders, safeIcon, startDiscovery } from '../src/discovery';

const w = (rdns: string) => ({ info: { uuid: rdns, name: rdns, icon: '', rdns } });

describe('choose', () => {
  it('falls back to window.ethereum only when nothing announced', () => {
    expect(choose([], null)).toEqual({ kind: 'fallback' });
    expect(choose([], 'io.metamask')).toEqual({ kind: 'fallback' });
  });
  it('uses the only wallet', () => {
    expect(choose([w('app.phantom')], null)).toEqual({ kind: 'use', provider: w('app.phantom') });
  });
  it('asks when several wallets announce and none was remembered', () => {
    const opts = [w('app.phantom'), w('io.metamask')];
    expect(choose(opts, null)).toEqual({ kind: 'ask', options: opts });
  });
  it('uses the remembered wallet if it is still there, otherwise asks', () => {
    const opts = [w('app.phantom'), w('io.metamask')];
    expect(choose(opts, 'io.metamask')).toEqual({ kind: 'use', provider: opts[1] });
    expect(choose(opts, 'io.rabby')).toEqual({ kind: 'ask', options: opts });
  });
});

describe('safeIcon', () => {
  it('accepts image data URIs only', () => {
    expect(safeIcon('data:image/svg+xml;base64,PHN2Zy8+')).toBeDefined();
    expect(safeIcon('data:image/png;base64,AAAA')).toBeDefined();
    expect(safeIcon('https://evil.example/x.png')).toBeUndefined();
    expect(safeIcon('javascript:alert(1)')).toBeUndefined();
    expect(safeIcon('data:text/html,<script>')).toBeUndefined();
  });
});

describe('discovery events', () => {
  beforeEach(() => _resetDiscovery());
  it('collects valid announcements, ignores malformed ones, de-duplicates by uuid', async () => {
    const target = new EventTarget() as unknown as Window;
    const provider = { request: async () => null };
    target.addEventListener('eip6963:requestProvider', () => {
      const announce = (detail: unknown) => target.dispatchEvent(Object.assign(new Event('eip6963:announceProvider'), { detail }));
      announce({ info: { uuid: 'a', name: 'MetaMask', icon: 'data:image/png;base64,AA', rdns: 'io.metamask' }, provider });
      announce({ info: { uuid: 'a', name: 'MetaMask', icon: 'data:image/png;base64,AA', rdns: 'io.metamask' }, provider });
      announce({ info: { uuid: 'b', name: 'Phantom', icon: '', rdns: 'app.phantom' }, provider });
      announce({ info: { uuid: 'c' }, provider }); // malformed info
      announce({ info: { uuid: 'd', name: 'x', icon: '', rdns: 'x' }, provider: {} }); // no request()
    });
    startDiscovery(target);
    const found = await discoverProviders(0, target);
    expect(found.map((f) => f.info.rdns).sort()).toEqual(['app.phantom', 'io.metamask']);
  });
});
