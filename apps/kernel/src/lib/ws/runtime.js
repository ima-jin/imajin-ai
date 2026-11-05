const RUNTIME = Symbol.for('imajin.kernel.ws-runtime');

/** Shared between Next's bundled instrumentation and the plain CJS server. */
function provideWsRuntime(runtime) {
  globalThis[RUNTIME] = runtime;
}

function getWsRuntime() {
  return globalThis[RUNTIME];
}

async function boundedWsOperation(operation, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WS_OPERATION_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = { provideWsRuntime, getWsRuntime, boundedWsOperation };
