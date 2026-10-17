/** Active third-party app with no navigation placements or person membership. */
export const fixtureStudio = {
  id: 'app_fixture_studio',
  slug: 'fixture-studio',
  name: 'Fixture Studio',
  entryUrl: 'https://studio.example.test',
  status: 'active',
  tier: 'third_party',
  placements: [],
};

export const operationalRegistryRows = [
  fixtureStudio,
  { ...fixtureStudio, id: 'app_relative', slug: 'relative-app', entryUrl: '/relative-app' },
  { ...fixtureStudio, id: 'app_revoked', slug: 'revoked-app', entryUrl: 'https://revoked.example.test', status: 'revoked' },
  { ...fixtureStudio, id: 'app_unsafe', slug: 'unsafe-app', entryUrl: 'javascript:alert(1)' },
  { ...fixtureStudio, id: 'app_protocol_relative', slug: 'protocol-relative', entryUrl: '//unsafe.example.test' },
  { ...fixtureStudio, id: 'app_missing', slug: 'missing-url', entryUrl: null },
];
