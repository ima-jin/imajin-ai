import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { STEP_EVENT_TYPES } from '../step-types';

const spec = parse(readFileSync(new URL('../../../../api-spec/jin.yaml', import.meta.url), 'utf8'));
const detail = spec.paths['/api/loops/{loopId}'].get;

describe('published horizon API contract', () => {
  it('requires loop/events/horizon on loop detail, not on the unchanged Record response', () => {
    const schema = detail.responses['200'].content['application/json'].schema;
    expect(schema.required).toEqual(['loop', 'events', 'horizon']);
    expect(schema.properties.horizon.$ref).toBe('#/components/schemas/Horizon');
    const record = spec.paths['/api/events'].get.responses['200'].content['application/json'].schema;
    expect(record.required ?? []).not.toContain('horizon');
    expect(record.properties).not.toHaveProperty('horizon');
  });
  it('distinguishes historical step claims from authoritative live lease output', () => {
    const schemas = spec.components.schemas;
    expect(schemas.StepEnvelope.allOf[1].properties.claim.$ref).toBe('#/components/schemas/StepClaim');
    expect(schemas.HorizonStep.allOf[0].properties.claim.$ref).toBe('#/components/schemas/HorizonClaim');
    expect(schemas.HorizonClaim.required).toEqual(['leaseId', 'holderDid', 'acquiredAt', 'expiresAt']);
    expect(schemas.SurfaceEnvelope.allOf[1].required).toEqual(['surface']);
    expect(schemas.LoopRefs.properties.conflictingHolderDid.type).toBe('string');
  });
  it('publishes every accepted step type and the opt-in exited audit flag', () => {
    const ingest = spec.paths['/api/loops'].post.requestBody.content['application/json'].schema;
    expect(ingest.properties.type.enum).toEqual(expect.arrayContaining([...STEP_EVENT_TYPES]));
    expect(detail.parameters.find((parameter: { name: string }) => parameter.name === 'includeExited').schema)
      .toEqual({ type: 'boolean', default: false });
    expect(spec.components.schemas.Horizon.properties.depth.readOnly).toBe(true);
    expect(spec.components.schemas.StepUpdate.properties).not.toHaveProperty('zone');
  });
  it('documents ref-only issue binding without dropping the optional OUTCOME regex', () => {
    const issue = spec.components.schemas.StepUpdate.properties.issue;
    expect(issue.required).toEqual(['ref']);
    expect(issue.properties.outcome.pattern).toBe(String.raw`^OUTCOME\b`);
    expect(issue.description).toContain('never invented');
  });
  it('publishes the signed kernel-root receipt path and non-disclosing responses', () => {
    const receipt = spec.paths['/api/loops/receipts'].post;
    expect(receipt.operationId).toBe('lookupLoopReceipt');
    expect(receipt.security).toEqual([]);
    expect(receipt.servers[0].url).toBe('https://{node}.imajin.ai');
    expect(receipt.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/LoopReceiptRequest');
    const schemas = spec.components.schemas;
    expect(schemas.LoopReceiptRequest.required).toEqual(['type', 'payload', 'publisherDid', 'signature']);
    expect(schemas.LoopReceiptRequest.properties.type.const).toBe('loop.receipt');
    const payload = schemas.LoopReceiptRequest.properties.payload;
    expect(payload.required).toEqual(['loopId', 'principal', 'envelopeHash', 'at']);
    expect(payload.additionalProperties).toBe(false);
    expect(payload.properties.envelopeHash.pattern).toBe('^[0-9a-f]{64}$');
    expect(payload.properties.at.description).toContain('original envelope at is never changed');
    expect(schemas.LoopReceipt.required).toEqual(['status', 'eventId']);
    expect(schemas.LoopReceiptNotFound.properties.status.const).toBe('not_found');
    expect(Object.keys(receipt.responses)).toEqual(expect.arrayContaining(['200', '400', '404', '413', '500']));
    expect(receipt.responses['404'].content['application/json'].schema.$ref).toBe('#/components/schemas/LoopReceiptNotFound');
  });
});
