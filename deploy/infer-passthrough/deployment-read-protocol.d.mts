import type { KeyObject } from 'node:crypto';
export const PURPOSE: 'infer-passthrough/github-deploy-read';
export const REPOSITORY: 'ima-jin/imajin-ai';
export const HEADER: 'x-imajin-deployment-read';
export interface DeliveryBinding { repository: string; ownerDid: string; recipientDid: string }
export interface DeliveryClaim extends DeliveryBinding {
  purpose: string; nonce: string; timestamp: number; ephemeralKey: string;
}
export function signingKey(seed: string): KeyObject;
export function signingPublicKey(key: KeyObject): string;
export function createDeliveryRequest(method: string, path: string, body: string, binding: DeliveryBinding,
  key: KeyObject, now?: number): { header: string; claim: DeliveryClaim; privateKey: KeyObject };
export function verifyDeliveryRequest(header: string | null, method: string, path: string, body: string,
  binding: DeliveryBinding, recipientPublicKey: string, now?: number): DeliveryClaim;
export function sealDeliveryResponse(value: unknown, claim: DeliveryClaim, expiresAt: number, key: KeyObject): object;
export function openDeliveryResponse(envelope: unknown, request: ReturnType<typeof createDeliveryRequest>,
  kernelPublicKey: string, now?: number): unknown;
