import { type VaultSignedPayload } from './models.js';

/**
 * Create a canonical JSON representation of a VaultSignedPayload for signing.
 *
 * Ensures the same payload always produces the same string,
 * regardless of property order.
 */
export function canonicalizePayload(payload: VaultSignedPayload): string {
    return canonicalize(payload);
}

function canonicalize(obj: unknown): string {
    if (obj === null) return 'null';
    if (obj === undefined) return 'undefined';

    if (typeof obj === 'boolean' || typeof obj === 'number') {
        return JSON.stringify(obj);
    }

    if (typeof obj === 'string') {
        return JSON.stringify(obj);
    }

    if (Array.isArray(obj)) {
        return '[' + obj.map(canonicalize).join(',') + ']';
    }

    if (typeof obj === 'object') {
        const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
        const pairs = keys
            .filter(k => (obj as Record<string, unknown>)[k] !== undefined)
            .map(k =>
                JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k])
            );
        return '{' + pairs.join(',') + '}';
    }

    return String(obj);
}
