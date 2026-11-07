import { BinaryNode, getBinaryNodeChild, WASocket } from 'baileys';

/**
 * Pull-based offline backlog (WhatsApp Web `WAWebOfflineHandler`).
 *
 * On (re)connect the server announces the backlog with `<ib><offline_preview count="N"/>`,
 * delivers a small primer and then WAITS for successive `<ib><offline_batch count="200"/>`
 * requests before sending more. Baileys (7.0.0-rc.9 .. rc14) sends only ONE request
 * (count=100) and never asks again, so when more than ~100 stanzas are pending the server
 * never finishes the backlog, never sends `<ib><offline/>`, and every live message stays
 * queued behind it until the next reconnection (~50 min). Symptom: an instance shows
 * `open` but only receives bursts of old messages ~30 s after each reconnect.
 *
 * This mirrors WA Web's non-adaptive loop: the first offline stanza that arrives after a
 * batch request schedules the next request (debounced 100 ms) until the announced total
 * has been received or `<ib><offline/>` arrives. A stall timer re-requests if the server
 * goes quiet mid-drain. Disable with OFFLINE_BATCH_PULL=false.
 */

type PullerLogger = { info: (value: any) => void; warn: (value: any) => void };

const BATCH_SIZE = 200; // WAWebOfflineHandler.v
const BAILEYS_FIRST_BATCH = 100; // what Baileys requests itself on offline_preview
const REQUEST_DEBOUNCE_MS = 100; // WAWebOfflineHandler.S
const STALL_TIMEOUT_MS = 20_000;
const EXTRA_REQUESTS_ALLOWANCE = 10;

export function attachOfflineBatchPuller(client: WASocket, logger: PullerLogger, instanceName: string): void {
  if ((process.env.OFFLINE_BATCH_PULL || '').toLowerCase() === 'false') {
    return;
  }

  const ws = client.ws as unknown as {
    on: (event: string, listener: (...args: any[]) => void) => void;
  };
  const tag = `[OfflinePull] ${instanceName}`;

  let active = false;
  let total = 0;
  let received = 0;
  let booked = 0; // stanzas already requested from the server
  let requests = 0;
  let maxRequests = 0;
  let batchInFlight = false;
  let debounceTimer: NodeJS.Timeout | undefined;
  let stallTimer: NodeJS.Timeout | undefined;

  const clearTimers = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (stallTimer) clearTimeout(stallTimer);
    debounceTimer = undefined;
    stallTimer = undefined;
  };

  const stop = (reason: string) => {
    if (!active) return;
    active = false;
    clearTimers();
    logger.info(`${tag}: drain ended (${reason}) received=${received}/${total} extraRequests=${requests}`);
  };

  const armStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallTimer = undefined;
      if (active && received < total) {
        void requestBatch('stall');
      }
    }, STALL_TIMEOUT_MS);
  };

  const requestBatch = async (reason: string) => {
    if (!active) return;
    // A continuation is only needed while the announced backlog is not fully booked;
    // a stall re-request ignores this (the server is evidently still waiting for one).
    if (reason === 'continuation' && booked >= total) return;
    if (requests >= maxRequests) {
      logger.warn(`${tag}: request limit reached (${requests}), received=${received}/${total}`);
      stop('request limit');
      return;
    }
    requests++;
    booked += BATCH_SIZE;
    batchInFlight = true;
    try {
      await client.sendNode({
        tag: 'ib',
        attrs: {},
        content: [{ tag: 'offline_batch', attrs: { count: String(BATCH_SIZE) } }],
      });
      logger.info(`${tag}: requested offline batch #${requests} (${reason}) received=${received}/${total}`);
    } catch (error) {
      batchInFlight = false;
      logger.warn(`${tag}: failed to request offline batch: ${error?.message || error}`);
    }
    armStallTimer();
  };

  ws.on('CB:ib,,offline_preview', (node: BinaryNode) => {
    const preview = getBinaryNodeChild(node, 'offline_preview');
    clearTimers();
    total = Number(preview?.attrs?.count || 0);
    received = 0;
    booked = BAILEYS_FIRST_BATCH;
    requests = 0;
    maxRequests = Math.ceil(total / BATCH_SIZE) + EXTRA_REQUESTS_ALLOWANCE;
    // Baileys itself answers this preview with the first offline_batch request.
    batchInFlight = true;
    active = total > 0;
    logger.info(`${tag}: offline preview ${JSON.stringify(preview?.attrs || {})}`);
    if (active) armStallTimer();
  });

  ws.on('frame', (frame: BinaryNode | Uint8Array) => {
    if (!active || !frame || frame instanceof Uint8Array || !frame.attrs) return;
    if (frame.attrs.offline === undefined) return;

    received++;
    armStallTimer();

    if (received >= total) return; // everything announced has arrived; <ib><offline/> closes the drain
    if (!batchInFlight) return; // only the first stanza of each requested batch schedules the next one
    batchInFlight = false;

    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void requestBatch('continuation');
    }, REQUEST_DEBOUNCE_MS);
  });

  ws.on('CB:ib,,offline', () => stop('end marker'));
  ws.on('close', () => stop('socket closed'));
}
