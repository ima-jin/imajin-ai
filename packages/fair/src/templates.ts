import type { FairManifest } from './types';

export type FairTemplate = "media" | "ticket" | "course" | "module" | "document" | "custom";

export interface TemplateConfig {
  name: string;
  description: string;
  sections: {
    attribution: boolean;
    access: boolean;
    transfer: boolean;
    integrity: boolean;
    intent: boolean;
    terms: boolean;
    distributions: boolean;
  };
  defaults?: Partial<FairManifest>;
}

export const templates: Record<FairTemplate, TemplateConfig> = {
  media: {
    name: "Media",
    description: "Audio, video, or image content with transfer and integrity tracking.",
    sections: {
      attribution: true,
      access: true,
      transfer: true,
      integrity: true,
      intent: false,
      terms: true,
      distributions: false,
    },
    defaults: {
      transfer: { allowed: true, resaleRoyalty: 0.1 },
    },
  },
  ticket: {
    name: "Ticket",
    description: "Event or access ticket with transfer controls and stated purpose.",
    sections: {
      attribution: true,
      access: true,
      transfer: true,
      integrity: false,
      intent: true,
      terms: true,
      distributions: false,
    },
    defaults: {
      transfer: { allowed: true, faceValueCap: true },
    },
  },
  course: {
    name: "Course",
    description: "Educational course with distribution splits and stated learning intent.",
    sections: {
      attribution: true,
      access: true,
      transfer: false,
      integrity: false,
      intent: true,
      terms: true,
      distributions: true,
    },
    defaults: {
      access: { type: "private" },
    },
  },
  module: {
    name: "Module",
    description: "Standalone content module or lesson, minimal configuration.",
    sections: {
      attribution: true,
      access: true,
      transfer: false,
      integrity: false,
      intent: false,
      terms: true,
      distributions: false,
    },
  },
  document: {
    name: "Document",
    description: "Written document or file with integrity verification.",
    sections: {
      attribution: true,
      access: true,
      transfer: false,
      integrity: true,
      intent: false,
      terms: true,
      distributions: false,
    },
  },
  custom: {
    name: "Custom",
    description: "Fully custom manifest — all sections visible.",
    sections: {
      attribution: true,
      access: true,
      transfer: true,
      integrity: true,
      intent: true,
      terms: true,
      distributions: true,
    },
  },
};
