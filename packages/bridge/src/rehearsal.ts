import { readExistingConfig } from './config';
import { openRehearsalBrowser, RehearsalCleanupError } from './rehearsal-browser';
import { BridgeClient } from '../../mcp/src/client';

export type RehearsalResult = 'passed' | 'denied' | 'expired' | 'timed-out' | 'cancelled';
export class RehearsalError extends Error {}

function pause(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, 1000);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Practice cancelled.')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Agent-only rehearsal. Never reads owner authority into an API call or controls
 * the browser between creating the handoff and explicit owner completion. */
export async function runRehearsal(options: { configDirectory: string; port: number; signal?: AbortSignal; log: (message: string) => void }): Promise<RehearsalResult> {
  options.signal?.throwIfAborted();
  const config = await readExistingConfig(options.configDirectory);
  const client = new BridgeClient({ url: `http://127.0.0.1:${options.port}`, token: config.agentToken });
  let browser: Awaited<ReturnType<typeof openRehearsalBrowser>> | undefined;
  let creationStarted = false;
  try {
    options.signal?.throwIfAborted();
    options.log('Starting an isolated practice browser. Never enter real credentials.');
    browser = await openRehearsalBrowser();
    options.signal?.throwIfAborted();
    creationStarted = true;
    const request = await client.create({
      agent: 'Keep Safe rehearsal', title: 'Practice browser handoff',
      reason: 'Local synthetic practice only. Type PRACTICE in the practice field, choose Practice sign-in, then Done, hand back. Never enter real credentials. No external website is contacted.',
      url: browser.url, cdpUrl: browser.cdpUrl, ttlSeconds: 300,
    });
    options.log(`Practice request ${request.id} queued for five minutes.`);
    options.log('On your paired phone, open Practice browser handoff and approve it. Type PRACTICE, choose Practice sign-in, then Done, hand back.');
    const deadline = Math.min(Date.now() + 300_000, Date.parse(request.expiresAt));
    if (!Number.isFinite(deadline)) throw new Error('Invalid practice deadline.');
    let previous = '';
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      const current = await client.get(request.id);
      options.signal?.throwIfAborted();
      if (current.status === 'denied' || current.status === 'expired') return current.status;
      if (current.status === 'completed') {
        options.log('Handback received. Checking the returned practice browser.');
        await browser.verify();
        options.signal?.throwIfAborted();
        return 'passed';
      }
      if (current.status !== previous) {
        options.log(current.status === 'pending' ? 'Waiting for phone approval.' : 'The phone has control. Waiting for explicit handback.');
        previous = current.status;
      }
      await pause(options.signal);
    }
    return 'timed-out';
  } catch (error) {
    if (error instanceof RehearsalCleanupError) throw new RehearsalError(error.message);
    if (options.signal?.aborted) return 'cancelled';
    throw new RehearsalError('Practice could not be verified. Check the running bridge, Chromium installation and phone connection, then try again.');
  } finally {
    try { await browser?.close(); }
    catch { throw new RehearsalError('Practice browser cleanup could not be confirmed. Check that the practice process stopped before retrying.'); }
    if (creationStarted) options.log('The practice browser is closed. Any unfinished practice request can be declined on your phone or will expire at its original five-minute deadline.');
  }
}
