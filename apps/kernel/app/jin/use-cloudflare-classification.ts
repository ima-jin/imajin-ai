'use client';

import { useRef, useState } from 'react';
import { requestApprovalsRefresh } from './approval-anchor';
import { cloudflareRequest, type CloudflareZone } from './cloudflare-client';
import { classificationPlans, isEdgeClassification, type EdgeClassification } from './cloudflare-classification-client';

export function useCloudflareClassification() {
  const [classification, setClassification] = useState<EdgeClassification | null>(null);
  const [previews, setPreviews] = useState<unknown[]>([]);
  const [complete, setComplete] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [proposals, setProposals] = useState<string[]>([]);
  const [stagingStarted, setStagingStarted] = useState(false);
  const revision = useRef(0);
  const lock = useRef(false);
  const approvedPreview = useRef<number | null>(null);
  const stageLock = useRef(false);
  const invalidate = () => {
    revision.current += 1; approvedPreview.current = null; stageLock.current = false;
    setComplete(false); setPreviews([]); setMessage(''); setProposals([]); setStagingStarted(false);
    setClassification(null);
  };
  const loadClassification = async (zone: CloudflareZone) => {
    const current = revision.current;
    const data = await cloudflareRequest<{ classification: unknown }>(zone, 'classification');
    if (current !== revision.current) return;
    if (!isEdgeClassification(data.classification) || data.classification.domain !== zone.domain) throw new Error('Invalid report');
    classificationPlans(data.classification);
    setClassification(data.classification);
  };
  const previewClassification = async (zone: CloudflareZone) => {
    if (!classification || lock.current || stageLock.current) return;
    lock.current = true; setWorking(true); setComplete(false); setPreviews([]); setMessage('');
    approvedPreview.current = null;
    const current = revision.current;
    try {
      const results: unknown[] = [];
      for (const plan of classificationPlans(classification)) {
        const result = await cloudflareRequest(zone, plan.resource, plan.method, { domain: zone.domain, ...plan.body, dryRun: true });
        if (current !== revision.current) return;
        results.push(result); setPreviews([...results]);
      }
      approvedPreview.current = current; setComplete(true);
      setMessage('All dry runs complete. Review every before/after before requesting approval.');
    } catch {
      if (current === revision.current) setMessage('Preview incomplete. No proposals requested. Retry all dry runs before approval.');
    } finally { lock.current = false; setWorking(false); }
  };
  const requestClassificationApproval = async (zone: CloudflareZone) => {
    if (!classification || lock.current || stageLock.current || approvedPreview.current !== revision.current) return;
    // Set synchronously: double clicks cannot stage the same plan twice.
    lock.current = true; stageLock.current = true; setStagingStarted(true); setWorking(true);
    setComplete(false); approvedPreview.current = null;
    const current = revision.current;
    let staged = 0;
    try {
      for (const plan of classificationPlans(classification)) {
        const result = await cloudflareRequest<{ approval?: { proposalId?: string } }>(
          zone, plan.resource, plan.method, { domain: zone.domain, ...plan.body, dryRun: false },
        );
        if (current !== revision.current) return;
        if (typeof result.approval?.proposalId !== 'string' || !result.approval.proposalId) throw new Error('Invalid proposal');
        const id = result.approval.proposalId;
        setProposals(previous => [...previous, id]); staged += 1; requestApprovalsRefresh();
      }
      setMessage('All proposals pending approval. No changes until countersigned by the operator in Operator approvals.');
    } catch {
      if (current === revision.current) setMessage(`Approval request stopped (${staged} confirmed proposals). No execution was requested. Check Operator approvals and signed history before refreshing; an interrupted request may already have staged a proposal. Automatic retry is disabled to prevent duplicates.`);
    } finally { lock.current = false; setWorking(false); }
  };
  return { classification, previews, complete, working, message, proposals, stagingStarted,
    invalidate, loadClassification, previewClassification, requestClassificationApproval };
}
