import { cacheTokens } from './config';

describe('cacheTokens', () => {
  it('reuses a token per path until it is too old, and shares concurrent calls', async () => {
    let calls = 0;
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const get = cacheTokens(async (path) => `${path}-${++calls}`, { maxAgeSec: 60 });
    const [a, b] = await Promise.all([get('x'), get('x')]);
    expect([a, b]).toEqual(['x-1', 'x-1']);
    expect(await get('y')).toBe('y-2');
    now.mockReturnValue(1_000_000 + 61_000);
    expect(await get('x')).toBe('x-3');
    now.mockRestore();
  });

  it('does not cache failures', async () => {
    let fail = true;
    const get = cacheTokens(async () => {
      if (fail) throw new Error('main server down');
      return 't';
    });
    await expect(get('x')).rejects.toThrow('main server down');
    fail = false;
    expect(await get('x')).toBe('t');
  });
});
