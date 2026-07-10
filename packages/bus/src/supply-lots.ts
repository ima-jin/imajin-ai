/**
 * #1136 — read side of the supply-chain spine. Returns a lot and its ordered
 * stage history (declared -> collected -> processed -> listed [-> settled]) for a
 * correlationId. Consumed by #1135's GET /api/supply/lot/[correlationId] route.
 *
 * Raw SQL via @imajin/db — packages/bus must not import apps/kernel. Columns are
 * aliased to camelCase so the returned shape is stable regardless of any client
 * column transform.
 */

export interface SupplyLotRecord {
  correlationId: string;
  originatingDid: string;
  commodity: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupplyStageRecord {
  id: string;
  correlationId: string;
  stage: string;
  actorDid: string;
  attestationCid: string | null;
  priorCid: string | null;
  payload: unknown;
  createdAt: string;
}

export interface LotChain {
  lot: SupplyLotRecord | null;
  stages: SupplyStageRecord[];
}

export async function getLotChain(correlationId: string): Promise<LotChain> {
  const { getClient } = await import('@imajin/db');
  const sql = getClient();

  const lotRows = (await sql`
    SELECT correlation_id  AS "correlationId",
           originating_did AS "originatingDid",
           commodity,
           status,
           created_at      AS "createdAt",
           updated_at      AS "updatedAt"
    FROM kernel.supply_lots
    WHERE correlation_id = ${correlationId}
    LIMIT 1
  `) as unknown as SupplyLotRecord[];

  const stageRows = (await sql`
    SELECT id,
           correlation_id  AS "correlationId",
           stage,
           actor_did       AS "actorDid",
           attestation_cid AS "attestationCid",
           prior_cid       AS "priorCid",
           payload,
           created_at      AS "createdAt"
    FROM kernel.supply_stages
    WHERE correlation_id = ${correlationId}
    ORDER BY created_at ASC, id ASC
  `) as unknown as SupplyStageRecord[];

  return { lot: lotRows[0] ?? null, stages: stageRows };
}
