/**
 * Pequenos complementos para navegadores antigos (TV box, celulares sem
 * atualização). O restante vem dos polyfills gerados no build.
 */
if (typeof AbortSignal !== 'undefined' && !('timeout' in AbortSignal)) {
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };
}
export {};
