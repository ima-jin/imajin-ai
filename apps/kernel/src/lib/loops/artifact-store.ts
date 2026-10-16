import { createHash } from 'node:crypto';
import { canonicalize } from '@imajin/auth';
import { getClient } from '@imajin/db';
import type { LoopOutput, LoopOutputArtifactRef } from '@imajin/bus';

export interface LoopOutputArtifact extends LoopOutputArtifactRef {
  output: LoopOutput;
}

/** Store only already-redacted output; content address is scoped to both owner and loop. */
export async function putLoopOutputArtifact(
  loopId: string,
  principal: string,
  output: LoopOutput,
): Promise<LoopOutputArtifactRef> {
  const content = canonicalize(output);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const id = `loa_${createHash('sha256').update(JSON.stringify([principal, loopId, sha256])).digest('hex')}`;
  const byteLength = Buffer.byteLength(content, 'utf8');
  const sql = getClient();
  await sql`
    INSERT INTO kernel.loop_output_artifacts (id, loop_id, principal, sha256, byte_length, media_type, content)
    VALUES (${id}, ${loopId}, ${principal}, ${sha256}, ${byteLength}, 'application/json', ${content}::jsonb)
    ON CONFLICT (id) DO NOTHING
  `;
  return { id, sha256, byteLength, mediaType: 'application/json' };
}

/** An artifact id alone is never authority: both loop and principal must match. */
export async function getLoopOutputArtifact(
  loopId: string,
  principal: string,
  artifactId: string,
): Promise<LoopOutputArtifact | null> {
  const sql = getClient();
  const rows = await sql`
    SELECT id, sha256, byte_length, media_type, content
    FROM kernel.loop_output_artifacts
    WHERE id = ${artifactId} AND loop_id = ${loopId} AND principal = ${principal}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sha256: row.sha256,
    byteLength: row.byte_length,
    mediaType: row.media_type,
    output: row.content,
  };
}
