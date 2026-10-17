/** Private principal Reach frames use the notification rail, not bus cursors. */
function isReachEventType(type) {
  return type === 'agent.reach.delivered' || type === 'agent.reach.replied';
}
function isPrivateReachNotification(frame) {
  return frame?.type === 'notification'
    && (isReachEventType(frame.scope) || isReachEventType(frame.data?.eventType));
}

function isPrivateReachFrame(frame) {
  return isPrivateReachNotification(frame) || (frame?.type === 'bus_event' && isReachEventType(frame.eventType));
}

const MAX_OBSERVED_NOTIFICATIONS = 1000;

function createPrivateNotifications({ getMeta, registry, verifyDelegation, fetchBacklog, ack, log = () => {} }) {
  const observed = new WeakMap();

  function observe(ws, did, frame) {
    if (frame?.type !== 'notification' || typeof frame.id !== 'string') return;
    let ids = observed.get(ws);
    if (!ids) {
      ids = new Map();
      observed.set(ws, ids);
    }
    ids.set(frame.id, { did, privateReach: isPrivateReachNotification(frame) });
    if (ids.size > MAX_OBSERVED_NOTIFICATIONS) ids.delete(ids.keys().next().value);
  }

  /** Capture identity/registration before awaiting; never resurrect stale work. */
  async function authorized(ws, did) {
    const meta = getMeta(ws);
    if (!meta?.authenticated || ws.readyState !== 1) return null;
    const version = registry.versionFor(ws);
    const current = () => ws.readyState === 1 && getMeta(ws) === meta
      && (meta.did === did || (meta.alsoDids.has(did) && registry.versionFor(ws) === version));
    if (meta.did === did) return current;
    if (!meta.alsoDids.has(did)) return null;
    try {
      const allowed = await verifyDelegation(meta.did, did);
      return allowed === true ? current : null;
    } catch {
      return null;
    }
  }

  async function send(ws, did, frame) {
    const current = await authorized(ws, did);
    if (!current?.()) return false;
    try {
      // Do not project, reconstruct, sign or otherwise alter the original data.
      ws.send(JSON.stringify(frame));
      observe(ws, did, frame);
      return true;
    } catch {
      log('Private notification send failed');
      return false;
    }
  }

  async function replay(ws, did) {
    try {
      const current = await authorized(ws, did);
      if (!current?.()) return;
      const result = await fetchBacklog(did, true);
      // A cancelled batch retains its existing WS attempt claims until the
      // ACK grace period expires, just like own-DID replay after disconnect.
      // Never release all claims for a principal: another socket may be
      // processing a concurrent delivery. No delivered_at is set without ACK.
      for (const frame of result.frames ?? []) {
        if (!current()) break;
        if (isPrivateReachNotification(frame) && !await send(ws, did, frame)) break;
      }
    } catch {
      log('Private notification replay failed');
    }
  }

  async function acknowledge(ws, id) {
    if (typeof id !== 'string' || id.length === 0) return;
    const meta = getMeta(ws);
    if (!meta?.authenticated || ws.readyState !== 1) return;
    const binding = observed.get(ws)?.get(id);
    if (binding?.privateReach) {
      const current = await authorized(ws, binding.did);
      if (current?.()) await ack(id, binding.did);
      return;
    }
    // Existing own-DID ACK semantics remain; unobserved ids cannot select a
    // principal, and a client-supplied did is never consulted.
    await ack(id, meta.did);
  }

  return { send, replay, acknowledge, observe, cleanup: (ws) => observed.delete(ws) };
}

module.exports = { createPrivateNotifications, isPrivateReachNotification, isPrivateReachFrame };
