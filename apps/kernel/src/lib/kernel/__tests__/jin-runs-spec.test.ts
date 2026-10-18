import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const spec = parse(readFileSync(resolve('apps/kernel/api-spec/jin.yaml'), 'utf8'));

describe('Runs command discovery (#2404 / plugin #77)', () => {
  it('documents one self-only prepare/dispatch endpoint with an opaque command ID', () => {
    const operation = spec.paths['/api/runs/{loopId}/commands'].post;
    expect(operation.operationId).toBe('commandRun');
    expect(operation.security).toEqual([{ cookieAuth: [] }]);
    expect(operation.parameters).toEqual([
      { name: 'loopId', in: 'path', required: true, schema: { type: 'string' } },
    ]);
    const choices = operation.requestBody.content['application/json'].schema.oneOf;
    expect(choices[0].required).toEqual(['action', 'type', 'payload']);
    expect(choices[0].properties.action.const).toBe('prepare');
    expect(choices[1].required).toEqual(['action', 'command']);
    expect(choices[1].properties.action.const).toBe('dispatch');
    expect(operation.description).toContain('Delivery is not execution');
    expect(operation.description).toContain('shared approval decision');
  });

  it('pins the complete two-signature frame without harness addressing fields', () => {
    const command = spec.components.schemas.SessionCommand;
    expect(command.required).toEqual([
      'type', 'commandId', 'to', 'principal', 'issuer', 'issuedAt', 'expiresAt', 'payload', 'signature',
    ]);
    expect(command.properties.type.enum).toEqual([
      'session.send', 'session.abort', 'session.spawn', 'session.approve', 'session.deny',
    ]);
    expect(command.properties.signature).toEqual({ $ref: '#/components/schemas/SessionCommandSignature' });
    expect(command.properties.countersignature).toEqual(command.properties.signature);
    expect(command.properties.payload.description).toContain('parentLoopId');
    expect(command.properties.payload.description).not.toContain('sessionKey');
    expect(command.additionalProperties).toBe(false);
  });

  it('keeps converted decisions on the existing approval endpoint and exact signed binding', () => {
    const decision = spec.paths['/api/operator-approvals/{proposalId}/decision'].post;
    expect(decision.requestBody.content['application/json'].schema.properties.sessionCommand)
      .toEqual({ $ref: '#/components/schemas/SessionCommand' });
    expect(decision.description).toContain('suppresses all legacy executable fan-out');
    const binding = spec.components.schemas.SessionApprovalBinding;
    expect(binding.required).toEqual(['loopId', 'principalDid', 'agentDid', 'approvalId']);
    expect(Object.keys(binding.properties)).toEqual(binding.required);
    expect(binding.additionalProperties).toBe(false);
  });
});
