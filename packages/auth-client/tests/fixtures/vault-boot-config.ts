import { createVaultBoot } from '../../src/vault-boot';

interface ServerConfig {
  DATABASE_URL: string;
  optionalWebhook?: string;
}

export const boot = createVaultBoot<ServerConfig>({
  vault: {
    appDid: 'did:imajin:fake-test-app',
    kernelUrl: 'https://kernel.example.invalid',
    keys: [
      { key: 'DATABASE_URL', onMissing: 'fail' },
      { key: 'WEBHOOK_SECRET', onMissing: 'degrade' },
    ],
  },
  configure: ({ values }) => ({
    DATABASE_URL: values.DATABASE_URL,
    optionalWebhook: values.WEBHOOK_SECRET,
  }),
});
