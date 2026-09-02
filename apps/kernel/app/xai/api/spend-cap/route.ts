/**
 * GET + PUT + DELETE /xai/api/spend-cap (#1923)
 *
 * Owner-settable spend ceiling for the xAI connector, enforced kernel-side by
 * `/infer/v1/chat/completions` before every forwarded call. Wired through the
 * shared spend-cap route factory — see its header for the field format.
 */
import { createConnectorSpendCapRoute } from '@/src/lib/kernel/connector-spend-cap-route';

export const { GET, PUT, DELETE, OPTIONS } = createConnectorSpendCapRoute('xai');
