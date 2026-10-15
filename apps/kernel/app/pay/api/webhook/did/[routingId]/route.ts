/**
 * Pay ingress shares the connector's opaque routing-id lookup and sealed-secret
 * verifier. The URL is bound to an owner before any payload is parsed; signatures
 * from another DID's endpoint cannot authorize settlement on this endpoint.
 */
export { dynamic, POST } from '@/app/stripe/api/webhook/[routingId]/route';
