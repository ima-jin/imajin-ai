/** Versioned, client-safe operator guidance; no credentials belong in setup state. */
export const GOOGLE_SETUP_VERSION = 1;

export const GOOGLE_SETUP_STATUSES = {
  not_started: 'Not started',
  submitted: 'Submitted',
  pending_google: 'Pending Google',
  approved: 'Approved',
  failed: 'Failed',
} as const;

export type GoogleSetupStatus = keyof typeof GOOGLE_SETUP_STATUSES;

export const GOOGLE_SETUP_STEPS = [
  {
    id: 'project',
    title: 'Create or choose a Google Cloud project',
    instructions: 'Sign in as the organisation’s Google administrator. Create or select the project that will own this OAuth client and the Business Profile access request. Keep the project ID and project number for Google’s forms.',
    links: [{ label: 'Choose a Google Cloud project', href: 'https://console.cloud.google.com/projectselector2/home/dashboard' }],
    recovery: 'Confirm your organisation gives your account permission to create and manage this project.',
  },
  {
    id: 'apis',
    title: 'Enable the Google APIs',
    instructions: 'In the selected project, enable the Google Search Console API. For Business Profile, enable My Business Account Management and My Business Business Information APIs; reviews use the Google My Business API. Business access approval can wait: it does not block Search Console.',
    links: [
      { label: 'Enable Search Console API', href: 'https://console.cloud.google.com/apis/library/searchconsole.googleapis.com' },
      { label: 'Enable Business Profile APIs', href: 'https://developers.google.com/my-business/content/basic-setup' },
    ],
    recovery: 'Check that the API library is showing the same project as your OAuth client. A successful Search Console test below confirms only Search Console access, not Business approval.',
  },
  {
    id: 'consent',
    title: 'Configure OAuth consent and verification',
    instructions: 'Configure Google Auth Platform branding, audience, authorised domains, support contact, and data access. Add webmasters.readonly for Search Console; add business.manage only when you need Business Profile. Add test users while testing. Follow Google’s sensitive-scope verification process when required for your audience; submit the requested domain ownership, privacy policy, and demonstration evidence.',
    links: [
      { label: 'Configure the consent screen', href: 'https://console.cloud.google.com/auth/overview' },
      { label: 'Sensitive-scope verification guidance', href: 'https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification' },
    ],
    recovery: 'If Google rejects verification, read the case response, correct the stated branding/domain/scope evidence, and resubmit. The connector cannot verify Google’s approval decision.',
  },
  {
    id: 'business-access',
    title: 'Submit the Business Profile API access request',
    instructions: 'Use Google’s access request form for this project. State your legal business name, business website, Google Cloud project ID and number, and the Google account managing your verified Business Profile. Explain: “Our identity-owned Imajin app reads our own Business Profile locations and customer reviews for reporting, using OAuth business.manage. We are not requesting review posting or account management.” Describe your actual use accurately. Save the Google case link here, then mark Submitted or Pending Google. Only mark Approved after Google confirms access for this project. The operator must also enable Business Profile on this installation.',
    links: [{ label: 'Request Business Profile API access', href: 'https://support.google.com/business/contact/api_default' }],
    recovery: 'While waiting, continue with Search Console. If rejected, follow the Google case response, correct eligibility or project details, and reply/resubmit using that case. Never mark approval merely because the form was submitted.',
  },
  {
    id: 'vault',
    title: 'Create an OAuth client and seal it in the identity vault',
    instructions: 'Create a Web application OAuth client in the same project. Add the exact redirect URI shown in the configure form below. Import the client ID and secret using that identity-scoped configure form: both inputs are masked, sealed into this identity’s vault for this connection slot, and cleared after successful submission. Importing a client resets any prior Business approval because the project may have changed: return to step 4 and reconfirm Google approval for this exact project after import. Never put credentials in environment variables, checklist fields, chat, or source files.',
    links: [
      { label: 'Create an OAuth client', href: 'https://console.cloud.google.com/auth/clients' },
      { label: 'Use the sealed configure form below', href: '#google-oauth-configure' },
    ],
    recovery: 'If the vault reports a pending delegation grant, approve the vault grant first. Reconfigure in the correct identity and connection slot if the client is missing.',
  },
  {
    id: 'connect',
    title: 'Select scopes and connect Google',
    instructions: 'After steps 1–3 and 5, select google:search-console:read in Scope grants below, then connect the Google account that owns your verified site. Consent only to the scopes you select. Run Check connection to test Search Console sites access. Business Profile is separate: its scope remains unavailable until step 4 is approved and the installation operator enables it.',
    links: [{ label: 'Connect with the selected scopes below', href: '#google-account-connect' }],
    recovery: 'If the test fails, verify the selected slot, granted scope, Google account’s site ownership, API enablement, and consent configuration, then reconnect. A successful sites call does not prove Google verification or Business Profile approval.',
  },
] as const;

export type GoogleSetupStepId = typeof GOOGLE_SETUP_STEPS[number]['id'];
export interface GoogleSetupStepState {
  status: GoogleSetupStatus;
  updatedAt: string | null;
  pendingSince: string | null;
  caseUrl?: string;
}
export interface GoogleSetupState {
  version: number;
  steps: Record<GoogleSetupStepId, GoogleSetupStepState>;
}

export interface GoogleSetupView extends GoogleSetupState {
  slot: string;
  businessProfileEnabled: boolean;
  businessProfileApproved: boolean;
  businessProfileAvailable: boolean;
  configSealed: boolean;
  tokenSealed: boolean;
  credentialPending: boolean;
}
