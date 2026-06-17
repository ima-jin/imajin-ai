-- 0039_seed_bus_chain_configs.sql
-- Seed default reactor chains for @imajin/bus (Issue #763)
-- Sources from packages/bus/src/config.ts DEFAULTS object

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('identity.created', NULL, '[{"type":"attestation","config":{"attestationType":"identity.created"},"enabled":true},{"type":"mjn","config":{"attestationType":"identity.created"},"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('identity.verified.preliminary', NULL, '[{"type":"attestation","config":{"attestationType":"identity.verified.preliminary"},"enabled":true},{"type":"mjn","config":{"attestationType":"identity.verified.preliminary"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('identity.verified.hard', NULL, '[{"type":"attestation","config":{"attestationType":"identity.verified.hard"},"enabled":true},{"type":"mjn","config":{"attestationType":"identity.verified.hard"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('identity.verified.steward', NULL, '[{"type":"attestation","config":{"attestationType":"identity.verified.steward"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('identity.verified.operator', NULL, '[{"type":"attestation","config":{"attestationType":"identity.verified.operator"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Connections
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('connection.accepted', NULL, '[{"type":"attestation","config":{"attestationType":"connection.accepted"},"enabled":true},{"type":"mjn","config":{"attestationType":"connection.accepted"},"enabled":true},{"type":"notify","config":{"template":"invite_accepted"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('connection.invited', NULL, '[{"type":"attestation","config":{"attestationType":"connection.invited"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('connection.create', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('connection.disconnect', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Social / Coffee
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('vouch', NULL, '[{"type":"attestation","config":{"attestationType":"vouch"},"enabled":true},{"type":"mjn","config":{"attestationType":"vouch"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('tip.granted', NULL, '[{"type":"attestation","config":{"attestationType":"tip.granted"},"enabled":true},{"type":"mjn","config":{"attestationType":"tip.granted"},"enabled":true},{"type":"notify","config":{"scope":"coffee:tip"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('tip.sent', NULL, '[{"type":"notify","config":{"scope":"coffee:tip-sent"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Events & Tickets
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('ticket.purchased', NULL, '[{"type":"attestation","config":{"attestationType":"ticket.purchased"},"enabled":true},{"type":"mjn","config":{"attestationType":"ticket.purchased"},"enabled":true},{"type":"notify","config":{"scope":"event:ticket"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('ticket.receipt', NULL, '[{"type":"notify","config":{"scope":"event:ticket-receipt"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('ticket.confirmed', NULL, '[{"type":"notify","config":{"scope":"event:ticket-confirmed"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('ticket.reserved', NULL, '[{"type":"notify","config":{"scope":"event:ticket-reserved"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('ticket.refunded', NULL, '[{"type":"notify","config":{"scope":"event:ticket-refunded"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('ticket.registration.completed', NULL, '[{"type":"notify","config":{"scope":"event:ticket-confirmed"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('ticket.registration.reminder', NULL, '[{"type":"notify","config":{"scope":"event:ticket-registration-reminder"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('ticket.purchase', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('event.created', NULL, '[{"type":"attestation","config":{"attestationType":"event.created"},"enabled":true},{"type":"mjn","config":{"attestationType":"event.created"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('event.attendance', NULL, '[{"type":"attestation","config":{"attestationType":"event.attendance"},"enabled":true},{"type":"mjn","config":{"attestationType":"event.attendance"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('event.registration', NULL, '[{"type":"notify","config":{"scope":"event:registration"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('event.rsvp', NULL, '[{"type":"notify","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('event.create', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('event.update', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('checkin.create', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Payments & Orders
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('order.completed', NULL, '[{"type":"settle","config":{},"await":true,"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- settlement.completed: webhook reactor omitted (references process.env)
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('settlement.completed', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('listing.purchased', NULL, '[{"type":"attestation","config":{"attestationType":"listing.purchased"},"enabled":true},{"type":"mjn","config":{"attestationType":"listing.purchased"},"enabled":true},{"type":"settle","config":{},"await":true,"enabled":true},{"type":"notify","config":{"scope":"market:purchase"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Attestations
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('attestation.created', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Groups & Pods
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('group.created', NULL, '[{"type":"attestation","config":{"attestationType":"group.created"},"enabled":true},{"type":"mjn","config":{"attestationType":"group.created"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('group.controller.added', NULL, '[{"type":"attestation","config":{"attestationType":"group.member.added"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('group.controller.removed', NULL, '[{"type":"attestation","config":{"attestationType":"group.member.removed"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('group.member.left', NULL, '[{"type":"attestation","config":{"attestationType":"group.member.left"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('group.member.removed', NULL, '[{"type":"attestation","config":{"attestationType":"group.member.removed"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('group.member.added', NULL, '[{"type":"attestation","config":{"attestationType":"group.member.added"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('pod.member.added', NULL, '[{"type":"attestation","config":{"attestationType":"pod.member.added"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('pod.role.changed', NULL, '[{"type":"attestation","config":{"attestationType":"pod.role.changed"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('pod.member.removed', NULL, '[{"type":"attestation","config":{"attestationType":"pod.member.removed"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('pod.created', NULL, '[{"type":"attestation","config":{"attestationType":"pod.created"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('session.created', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('session.destroyed', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Scope
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('scope.onboard', NULL, '[{"type":"attestation","config":{"attestationType":"scope.onboard"},"enabled":true},{"type":"mjn","config":{"attestationType":"scope.onboard"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('message.send', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('conversation.create', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('chat.mention', NULL, '[{"type":"notify","config":{"scope":"chat:mention"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Payments / Fees
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('payment.refund', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('payment.charge', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('fee.record', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('fee.rebate', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('fee.surcharge', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Customer / Profile / Handle
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('customer', NULL, '[{"type":"attestation","config":{"attestationType":"customer"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('transaction.settled', NULL, '[{"type":"attestation","config":{"attestationType":"transaction.settled"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('handle.claimed', NULL, '[{"type":"attestation","config":{"attestationType":"handle.claimed"},"enabled":true},{"type":"mjn","config":{"attestationType":"handle.claimed"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('profile.update', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Stubs
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('stub.created', NULL, '[{"type":"attestation","config":{"attestationType":"stub.created"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Platform / Misc
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('bump.confirm', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('bump.match', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('app.register', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Market
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('market.sale', NULL, '[{"type":"notify","config":{"scope":"market:sale"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('market.purchase', NULL, '[{"type":"notify","config":{"scope":"market:purchase"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('listing.purchase', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('listing.update', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('listing.create', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('listing.created', NULL, '[{"type":"attestation","config":{"attestationType":"listing.created"},"enabled":true},{"type":"notify","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Learn
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('learn.enrolled', NULL, '[{"type":"attestation","config":{"attestationType":"learn.enrolled"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('learn.completed', NULL, '[{"type":"attestation","config":{"attestationType":"learn.completed"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Assets / Fair
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('asset.fair.upgraded', NULL, '[{"type":"attestation","config":{"attestationType":"asset.fair.upgraded"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Auth / Documents
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('document.created', NULL, '[{"type":"notify","config":{"scope":"auth:document-signature-request"},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Vault
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('vault.secret.updated', NULL, '[{"type":"vault-hot-reload","config":{},"enabled":true,"await":true},{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('vault.secret.rotated', NULL, '[{"type":"vault-hot-reload","config":{},"enabled":true,"await":true},{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Broker
-- ---------------------------------------------------------------------------
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('broker.release', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES ('broker.rejection', NULL, '[{"type":"emit","config":{},"enabled":true}]'::jsonb, true)
ON CONFLICT (event_type, scope) DO NOTHING;
