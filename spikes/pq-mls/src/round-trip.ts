import {
  ciphersuites, createApplicationMessage, createCommit, createGroup,
  decodeMlsMessage, defaultCapabilities, defaultLifetime, emptyPskIndex,
  encodeMlsMessage, generateKeyPackage, getCiphersuiteFromName,
  getCiphersuiteImpl, joinGroup, processPrivateMessage, zeroOutUint8Array,
  type CiphersuiteName, type MLSMessage,
} from 'ts-mls';

export const suite = 'MLS_256_XWING_AES256GCM_SHA512_Ed25519' as const;

export function requireXWing(name: CiphersuiteName): void {
  if (name !== suite) throw new Error('Only the pinned X-Wing suite is allowed');
}
async function rejects(operation: () => Promise<unknown>, label: string) {
  let rejected = false;
  try { await operation(); } catch { rejected = true; }
  check(rejected, label);
}

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function decode(wire: Uint8Array): MLSMessage {
  const decoded = decodeMlsMessage(wire, 0);
  check(decoded && decoded[1] === wire.length, 'Exact wire decoding');
  return decoded[0];
}

export async function roundTrip() {
  requireXWing(suite);
  const impl = await getCiphersuiteImpl(getCiphersuiteFromName(suite));
  const capabilities = { ...defaultCapabilities(), ciphersuites: [suite] };
  const member = (identity: string) => generateKeyPackage(
    { credentialType: 'basic', identity: new TextEncoder().encode(identity) },
    capabilities, defaultLifetime, [], impl,
  );
  const aliceKeys = await member('alice');
  const bobKeys = await member('bob');
  let alice = await createGroup(
    new TextEncoder().encode('pq-mls-spike'), aliceKeys.publicPackage, aliceKeys.privatePackage, [], impl,
  );
  const keyPackage = decode(encodeMlsMessage({
    version: 'mls10', wireformat: 'mls_key_package', keyPackage: bobKeys.publicPackage,
  }));
  check(keyPackage.wireformat === 'mls_key_package', 'KeyPackage wire format');
  check(keyPackage.keyPackage.cipherSuite === suite, 'KeyPackage suite');
  const added = await createCommit({ state: alice, cipherSuite: impl }, {
    extraProposals: [{ proposalType: 'add', add: { keyPackage: keyPackage.keyPackage } }],
  });
  alice = added.newState;
  added.consumed.forEach(zeroOutUint8Array);
  check(added.welcome, 'Welcome exists');
  const commitWire = encodeMlsMessage(added.commit);
  check(decode(commitWire).wireformat === added.commit.wireformat, 'Commit serialization');
  const welcomeWire = encodeMlsMessage({ version: 'mls10', wireformat: 'mls_welcome', welcome: added.welcome });
  const welcome = decode(welcomeWire);
  check(welcome.wireformat === 'mls_welcome', 'Welcome wire format');
  let bob = await joinGroup(
    welcome.welcome, bobKeys.publicPackage, bobKeys.privatePackage, emptyPskIndex, impl, alice.ratchetTree,
  );
  check(alice.groupContext.cipherSuite === suite && bob.groupContext.cipherSuite === suite, 'No downgrade');
  check(alice.groupContext.epoch === bob.groupContext.epoch, 'Same epoch');

  // Exercise a commit received by an existing member, not only the Welcome.
  const update = await createCommit({ state: alice, cipherSuite: impl });
  alice = update.newState;
  update.consumed.forEach(zeroOutUint8Array);
  const commit = decode(encodeMlsMessage(update.commit));
  check(commit.wireformat === 'mls_private_message', 'Encrypted commit');
  const applied = await processPrivateMessage(bob, commit.privateMessage, emptyPskIndex, impl);
  check(applied.kind === 'newState', 'Commit applied');
  bob = applied.newState;
  applied.consumed.forEach(zeroOutUint8Array);
  const messages = [];
  for (const length of [0, 32, 1024]) {
    const plaintext = new Uint8Array(length).fill(42);
    const sent = await createApplicationMessage(alice, plaintext, impl);
    alice = sent.newState;
    sent.consumed.forEach(zeroOutUint8Array);
    const wire = encodeMlsMessage({ version: 'mls10', wireformat: 'mls_private_message', privateMessage: sent.privateMessage });
    const message = decode(wire);
    check(message.wireformat === 'mls_private_message', 'Encrypted application');
    const tampered = wire.slice();
    tampered[tampered.length - 1] ^= 1;
    const damaged = decode(tampered);
    check(damaged.wireformat === 'mls_private_message', 'Tampered wire format');
    await rejects(() => processPrivateMessage(bob, damaged.privateMessage, emptyPskIndex, impl), 'Reject modified ciphertext');
    const received = await processPrivateMessage(bob, message.privateMessage, emptyPskIndex, impl);
    check(received.kind === 'applicationMessage', 'Application received');
    check(received.message.length === plaintext.length && received.message.every((v, i) => v === plaintext[i]), 'Plaintext round-trip');
    bob = received.newState;
    received.consumed.forEach(zeroOutUint8Array);
    await rejects(() => processPrivateMessage(bob, message.privateMessage, emptyPskIndex, impl), 'Reject replay');
    messages.push({ plaintext: length, wire: wire.length, overhead: wire.length - length });
  }
  return { library: 'ts-mls', suite: ciphersuites[suite], commitBytes: commitWire.length, welcomeBytes: welcomeWire.length, messages };
}
