export type Capability =
  | "send:text"
  | "send:voice"
  | "send:media"
  | "send:location"
  | "conversation:create"
  | "conversation:invite";

export interface CapabilityContext {
  tier: "soft" | "hard";
  role?: string;
  inGraph?: boolean;
}

export function getCapabilities(ctx: CapabilityContext): Set<Capability> {
  const caps = new Set<Capability>();

  // Everyone can send text
  caps.add("send:text");

  if (ctx.tier === "hard") {
    caps.add("send:voice");
    caps.add("send:media");
    caps.add("send:location");
    caps.add("conversation:create");

    if (ctx.inGraph) {
      caps.add("conversation:invite");
    }
  }

  return caps;
}

export function hasCapability(ctx: CapabilityContext, cap: Capability): boolean {
  return getCapabilities(ctx).has(cap);
}

export function requiredCapability(contentType: string): Capability {
  switch (contentType) {
    case "voice": return "send:voice";
    case "media": return "send:media";
    case "location": return "send:location";
    default: return "send:text";
  }
}

export const CAPABILITY_MESSAGES: Record<Capability, string> = {
  "send:text": "Text messaging requires authentication",
  "send:voice": "Voice messages require a verified identity",
  "send:media": "Media messages require a verified identity",
  "send:location": "Location sharing requires a verified identity",
  "conversation:create": "Creating conversations requires a verified identity",
  "conversation:invite": "Inviting members requires a trust graph connection",
};
