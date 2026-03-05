import type { FairManifest } from "./types";

export function createManifest(opts: {
  id: string;
  type: string;
  owner: string;
  source?: string;
}): FairManifest {
  return {
    fair: "1.0",
    id: opts.id,
    type: opts.type,
    owner: opts.owner,
    created: new Date().toISOString(),
    source: opts.source,
    access: { type: "private" },
    attribution: [
      {
        did: opts.owner,
        role: "creator",
        share: 1.0,
      },
    ],
  };
}
