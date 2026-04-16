-- =============================================================================
-- 0001_seed.sql — Baseline schema seed for imajin-ai
-- Generated from dev schema dump. Idempotent — safe to run on any database.
-- Does NOT include: drizzle tracking schema, relay_documents/public_credentials/revocations (→ 0002)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS chat;
CREATE SCHEMA IF NOT EXISTS coffee;
CREATE SCHEMA IF NOT EXISTS connections;
CREATE SCHEMA IF NOT EXISTS dykil;
CREATE SCHEMA IF NOT EXISTS events;
CREATE SCHEMA IF NOT EXISTS learn;
CREATE SCHEMA IF NOT EXISTS links;
CREATE SCHEMA IF NOT EXISTS market;
CREATE SCHEMA IF NOT EXISTS media;
CREATE SCHEMA IF NOT EXISTS notify;
CREATE SCHEMA IF NOT EXISTS pay;
CREATE SCHEMA IF NOT EXISTS profile;
CREATE SCHEMA IF NOT EXISTS registry;
CREATE SCHEMA IF NOT EXISTS relay;
CREATE SCHEMA IF NOT EXISTS www;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- ---------------------------------------------------------------------------
-- Tables: auth
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth.identities (
    id text NOT NULL,
    public_key text NOT NULL,
    handle text,
    name text,
    avatar_url text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    tier text DEFAULT 'soft'::text NOT NULL,
    key_roles jsonb,
    avatar_asset_id text,
    contact_email text,
    handle_claimed_at timestamp with time zone,
    upload_limit_mb integer,
    suspended_at timestamp with time zone,
    scope text NOT NULL,
    subtype text
);

CREATE TABLE IF NOT EXISTS auth.attestations (
    id text NOT NULL,
    issuer_did text NOT NULL,
    subject_did text NOT NULL,
    type text NOT NULL,
    context_id text,
    context_type text,
    payload jsonb,
    signature text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    cid text,
    author_jws text,
    witness_jws text,
    attestation_status text DEFAULT 'pending'::text
);

CREATE TABLE IF NOT EXISTS auth.challenges (
    id text NOT NULL,
    identity_id text,
    challenge text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth.credentials (
    id text NOT NULL,
    did text NOT NULL,
    type text NOT NULL,
    value text NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth.devices (
    id text NOT NULL,
    did text NOT NULL,
    fingerprint text NOT NULL,
    name text,
    ip text,
    user_agent text,
    trusted boolean DEFAULT false NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now(),
    last_seen_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth.identity_chains (
    did text NOT NULL,
    dfos_did text NOT NULL,
    log jsonb NOT NULL,
    head_cid text NOT NULL,
    key_count integer DEFAULT 1 NOT NULL,
    is_deleted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth.identity_members (
    identity_did text NOT NULL,
    member_did text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    added_by text,
    added_at timestamp with time zone DEFAULT now(),
    removed_at timestamp with time zone,
    allowed_services text[]
);

CREATE TABLE IF NOT EXISTS auth.mfa_methods (
    id text NOT NULL,
    did text NOT NULL,
    type text NOT NULL,
    secret text NOT NULL,
    name text NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS auth.onboard_tokens (
    id text NOT NULL,
    email text NOT NULL,
    name text,
    token text NOT NULL,
    redirect_url text,
    context text,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    scope_did text
);

CREATE TABLE IF NOT EXISTS auth.stored_keys (
    id text NOT NULL,
    did text NOT NULL,
    encrypted_key text NOT NULL,
    salt text NOT NULL,
    key_derivation text DEFAULT 'pbkdf2'::text NOT NULL,
    device_fingerprint text,
    created_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS auth.tokens (
    id text NOT NULL,
    identity_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone,
    key_id text,
    key_role text
);

-- ---------------------------------------------------------------------------
-- Tables: chat (conversations_v2 first — others FK to it)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat.conversations_v2 (
    did text NOT NULL,
    parent_did text,
    name text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_message_at timestamp with time zone,
    type text DEFAULT 'dm'::text NOT NULL,
    description text,
    avatar text,
    context jsonb DEFAULT '{}'::jsonb,
    visibility text DEFAULT 'private'::text,
    trust_radius text,
    pod_id text
);

CREATE SEQUENCE IF NOT EXISTS chat.conversation_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE IF NOT EXISTS chat.conversation_members (
    id integer NOT NULL DEFAULT nextval('chat.conversation_members_id_seq'::regclass),
    conversation_did text NOT NULL,
    member_did text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone
);

ALTER SEQUENCE chat.conversation_members_id_seq OWNED BY chat.conversation_members.id;

CREATE TABLE IF NOT EXISTS chat.conversation_reads_v2 (
    conversation_did text NOT NULL,
    did text NOT NULL,
    last_read_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS chat.invites (
    id text NOT NULL,
    conversation_id text NOT NULL,
    created_by text NOT NULL,
    for_did text,
    max_uses text,
    used_count text DEFAULT '0'::text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    revoked_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS chat.message_reactions_v2 (
    message_id text NOT NULL,
    did text NOT NULL,
    emoji text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat.messages_v2 (
    id text NOT NULL,
    conversation_did text NOT NULL,
    from_did text NOT NULL,
    reply_to_did text,
    reply_to_message_id text,
    content jsonb NOT NULL,
    content_type text DEFAULT 'text'::text NOT NULL,
    media_type text,
    media_path text,
    media_meta jsonb,
    link_previews jsonb,
    created_at timestamp with time zone DEFAULT now(),
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    signature text,
    media_asset_id text
);

CREATE TABLE IF NOT EXISTS chat.public_keys (
    did text NOT NULL,
    identity_key text NOT NULL,
    signed_pre_key text NOT NULL,
    signature text NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat.pre_keys (
    id text NOT NULL,
    did text NOT NULL,
    key text NOT NULL,
    used boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tables: coffee
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS coffee.pages (
    id text NOT NULL,
    did text NOT NULL,
    handle text NOT NULL,
    title text NOT NULL,
    bio text,
    avatar text,
    theme jsonb DEFAULT '{}'::jsonb,
    payment_methods jsonb NOT NULL,
    presets integer[] DEFAULT '{100,500,1000}'::integer[],
    allow_custom_amount boolean DEFAULT true,
    allow_messages boolean DEFAULT true,
    is_public boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    fund_directions jsonb DEFAULT '[]'::jsonb,
    thank_you_content text,
    avatar_asset_id text,
    fair_manifest jsonb
);

CREATE TABLE IF NOT EXISTS coffee.tips (
    id text NOT NULL,
    page_id text NOT NULL,
    from_did text,
    from_name text,
    amount integer NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    message text,
    payment_method text NOT NULL,
    payment_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    fund_direction text
);

-- ---------------------------------------------------------------------------
-- Tables: connections (pods first — others FK to it)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS connections.pods (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    avatar text,
    owner_did text NOT NULL,
    type text DEFAULT 'personal'::text NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    conversation_did text
);

CREATE TABLE IF NOT EXISTS connections.connections (
    did_a text NOT NULL,
    did_b text NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    disconnected_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS connections.invites (
    id text NOT NULL,
    code text NOT NULL,
    from_did text NOT NULL,
    from_handle text,
    to_email text,
    note text,
    used_count integer DEFAULT 0 NOT NULL,
    max_uses integer DEFAULT 1 NOT NULL,
    consumed_by text,
    created_at timestamp with time zone DEFAULT now(),
    to_did text,
    delivery text DEFAULT 'link'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    accepted_at timestamp with time zone,
    expires_at timestamp with time zone,
    role text,
    to_phone text,
    consumed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS connections.nicknames (
    did text NOT NULL,
    target text NOT NULL,
    nickname text NOT NULL
);

CREATE TABLE IF NOT EXISTS connections.pod_keys (
    pod_id text NOT NULL,
    version integer NOT NULL,
    rotated_at timestamp without time zone DEFAULT now() NOT NULL,
    rotated_by text
);

CREATE TABLE IF NOT EXISTS connections.pod_links (
    parent_pod_id text NOT NULL,
    child_pod_id text NOT NULL,
    linked_by text,
    linked_at timestamp without time zone DEFAULT now() NOT NULL,
    unlinked_at timestamp without time zone
);

CREATE TABLE IF NOT EXISTS connections.pod_member_keys (
    pod_id text NOT NULL,
    version integer NOT NULL,
    did text NOT NULL,
    encrypted_pod_key text NOT NULL
);

CREATE TABLE IF NOT EXISTS connections.pod_members (
    pod_id text NOT NULL,
    did text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    added_by text,
    joined_at timestamp without time zone DEFAULT now() NOT NULL,
    removed_at timestamp without time zone
);

-- ---------------------------------------------------------------------------
-- Tables: dykil
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dykil.surveys (
    id text NOT NULL,
    did text NOT NULL,
    title text NOT NULL,
    description text,
    fields jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    handle text,
    type text DEFAULT 'survey'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS dykil.survey_responses (
    id text NOT NULL,
    survey_id text NOT NULL,
    respondent_did text,
    answers jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tables: events (events first, then ticket_types, orders, tickets, rest)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events.events (
    id text NOT NULL,
    did text NOT NULL,
    public_key text NOT NULL,
    creator_did text NOT NULL,
    title text NOT NULL,
    description text,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    is_virtual boolean DEFAULT false,
    virtual_url text,
    venue text,
    address text,
    city text,
    country text,
    status text DEFAULT 'draft'::text NOT NULL,
    image_url text,
    tags jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    pod_id text,
    private_key text,
    lobby_conversation_id text,
    access_mode text DEFAULT 'public'::text NOT NULL,
    name_display_policy text DEFAULT 'attendee_choice'::text NOT NULL,
    timezone text,
    course_slug text,
    registration_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    emt_email text,
    image_asset_id text,
    location_type text DEFAULT 'physical'::text
);

CREATE TABLE IF NOT EXISTS events.event_invites (
    id text NOT NULL,
    event_id text NOT NULL,
    token text NOT NULL,
    label text,
    max_uses integer,
    used_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events.ticket_types (
    id text NOT NULL,
    event_id text NOT NULL,
    name text NOT NULL,
    description text,
    price integer NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    quantity integer,
    sold integer DEFAULT 0,
    perks jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    sort_order integer DEFAULT 0 NOT NULL,
    requires_registration boolean DEFAULT false NOT NULL,
    registration_form_id text,
    max_per_order integer
);

CREATE TABLE IF NOT EXISTS events.orders (
    id text NOT NULL,
    event_id text NOT NULL,
    buyer_did text,
    ticket_type_id text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    amount_total integer NOT NULL,
    currency text DEFAULT 'CAD'::text NOT NULL,
    payment_method text,
    stripe_session_id text,
    payment_id text,
    fair_settlement jsonb,
    purchased_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events.tickets (
    id text NOT NULL,
    event_id text NOT NULL,
    ticket_type_id text NOT NULL,
    owner_did text,
    original_owner_did text,
    purchased_at timestamp with time zone,
    price_paid integer,
    currency text,
    payment_id text,
    status text DEFAULT 'available'::text NOT NULL,
    held_by text,
    held_until timestamp with time zone,
    used_at timestamp with time zone,
    signature text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    payment_method text,
    hold_expires_at timestamp with time zone,
    payment_confirmed_at timestamp with time zone,
    registration_status text DEFAULT 'not_required'::text NOT NULL,
    last_email_sent_at timestamp with time zone,
    order_id text
);

CREATE TABLE IF NOT EXISTS events.ticket_queue (
    id text NOT NULL,
    ticket_type_id text NOT NULL,
    did text NOT NULL,
    "position" integer NOT NULL,
    joined_at timestamp with time zone DEFAULT now(),
    notified_at timestamp with time zone,
    expires_at timestamp with time zone,
    status text DEFAULT 'waiting'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS events.ticket_registrations (
    id text NOT NULL,
    ticket_id text NOT NULL,
    event_id text NOT NULL,
    name text,
    email text,
    form_id text NOT NULL,
    response_id text,
    registered_by_did text,
    registered_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events.ticket_transfers (
    id text NOT NULL,
    ticket_id text NOT NULL,
    from_did text NOT NULL,
    to_did text NOT NULL,
    transferred_at timestamp with time zone DEFAULT now(),
    signature text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Tables: learn
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS learn.courses (
    id text NOT NULL,
    creator_did text NOT NULL,
    title text NOT NULL,
    description text,
    slug text,
    price integer DEFAULT 0,
    currency text DEFAULT 'CAD'::text,
    visibility text DEFAULT 'public'::text,
    image_url text,
    tags jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'draft'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    event_slug text,
    course_type text DEFAULT 'course'::text,
    image_asset_id text
);

CREATE TABLE IF NOT EXISTS learn.modules (
    id text NOT NULL,
    course_id text NOT NULL,
    title text NOT NULL,
    description text,
    sort_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learn.lessons (
    id text NOT NULL,
    module_id text NOT NULL,
    title text NOT NULL,
    content_type text DEFAULT 'markdown'::text NOT NULL,
    content text,
    duration_minutes integer,
    sort_order integer NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learn.enrollments (
    id text NOT NULL,
    course_id text NOT NULL,
    student_did text NOT NULL,
    payment_id text,
    enrolled_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS learn.lesson_progress (
    enrollment_id text NOT NULL,
    lesson_id text NOT NULL,
    status text DEFAULT 'not_started'::text,
    completed_at timestamp with time zone
);

-- ---------------------------------------------------------------------------
-- Tables: links
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS links.pages (
    id text NOT NULL,
    did text NOT NULL,
    handle text NOT NULL,
    title text NOT NULL,
    bio text,
    avatar text,
    theme jsonb DEFAULT '{}'::jsonb NOT NULL,
    social_links jsonb DEFAULT '{}'::jsonb,
    is_public boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    avatar_asset_id text
);

CREATE TABLE IF NOT EXISTS links.links (
    id text NOT NULL,
    page_id text NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    icon text,
    thumbnail text,
    "position" integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true,
    clicks integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    visibility text DEFAULT 'public'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS links.clicks (
    id text NOT NULL,
    link_id text NOT NULL,
    clicked_at timestamp with time zone DEFAULT now(),
    referrer text,
    country text
);

-- ---------------------------------------------------------------------------
-- Tables: market
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS market.listings (
    id text NOT NULL,
    seller_did text NOT NULL,
    title text NOT NULL,
    description text,
    price integer NOT NULL,
    currency text DEFAULT 'CAD'::text,
    category text,
    images jsonb DEFAULT '[]'::jsonb,
    quantity integer DEFAULT 1,
    status text DEFAULT 'active'::text,
    seller_tier text DEFAULT 'public_offplatform'::text NOT NULL,
    contact_info jsonb,
    trust_threshold jsonb,
    range_km integer DEFAULT 50,
    metadata jsonb DEFAULT '{}'::jsonb,
    fair_manifest jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    image_asset_ids jsonb DEFAULT '[]'::jsonb,
    type text DEFAULT 'sale'::text NOT NULL,
    show_contact_info boolean DEFAULT false,
    expires_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS market.disputes (
    id text NOT NULL,
    listing_id text NOT NULL,
    transaction_id text NOT NULL,
    buyer_did text NOT NULL,
    seller_did text NOT NULL,
    type text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolution text,
    buyer_evidence jsonb DEFAULT '[]'::jsonb,
    seller_evidence jsonb DEFAULT '[]'::jsonb,
    evidence_deadline timestamp with time zone,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market.seller_settings (
    did text NOT NULL,
    show_market_items boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tables: media
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media.folders (
    id text NOT NULL,
    owner_did text NOT NULL,
    name text NOT NULL,
    parent_id text,
    icon text,
    is_system boolean DEFAULT false,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media.assets (
    id text NOT NULL,
    owner_did text NOT NULL,
    filename text NOT NULL,
    mime_type text NOT NULL,
    size integer NOT NULL,
    storage_path text NOT NULL,
    hash text NOT NULL,
    fair_manifest jsonb DEFAULT '{}'::jsonb,
    fair_path text,
    folder_id text,
    tags jsonb DEFAULT '[]'::jsonb,
    classification text,
    classification_confidence integer,
    metadata jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media.asset_folders (
    asset_id text NOT NULL,
    folder_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS media.asset_references (
    id text NOT NULL,
    asset_id text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    service text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tables: notify
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notify.notifications (
    id text NOT NULL,
    recipient_did text NOT NULL,
    sender_did text,
    scope text NOT NULL,
    urgency text DEFAULT 'normal'::text NOT NULL,
    title text NOT NULL,
    body text,
    data jsonb DEFAULT '{}'::jsonb,
    channels_sent text[] DEFAULT '{}'::text[],
    read boolean DEFAULT false,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notify.preferences (
    id text NOT NULL,
    did text NOT NULL,
    scope text NOT NULL,
    email boolean DEFAULT true,
    inapp boolean DEFAULT true
);

-- ---------------------------------------------------------------------------
-- Tables: pay
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pay.balances (
    did text NOT NULL,
    cash_amount numeric(20,8) DEFAULT '0'::numeric NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    credit_amount numeric(20,8) DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS pay.balance_rollups (
    did text NOT NULL,
    date timestamp with time zone NOT NULL,
    service text NOT NULL,
    earned numeric(20,8) DEFAULT '0'::numeric,
    spent numeric(20,8) DEFAULT '0'::numeric,
    tx_count integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pay.connected_accounts (
    id text NOT NULL,
    did text NOT NULL,
    stripe_account_id text NOT NULL,
    charges_enabled boolean DEFAULT false NOT NULL,
    payouts_enabled boolean DEFAULT false NOT NULL,
    details_submitted boolean DEFAULT false NOT NULL,
    onboarding_complete boolean DEFAULT false NOT NULL,
    currently_due jsonb DEFAULT '[]'::jsonb,
    eventually_due jsonb DEFAULT '[]'::jsonb,
    default_currency text DEFAULT 'CAD'::text,
    platform_fee_bps integer,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pay.fee_ledger (
    id text NOT NULL,
    transaction_id text NOT NULL,
    recipient_did text NOT NULL,
    role text NOT NULL,
    amount_cents integer NOT NULL,
    currency text NOT NULL,
    status text DEFAULT 'accrued'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pay.transactions (
    id text NOT NULL,
    service text NOT NULL,
    type text NOT NULL,
    from_did text,
    to_did text NOT NULL,
    amount numeric(20,8) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    stripe_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    fair_manifest jsonb,
    batch_id text,
    created_at timestamp with time zone DEFAULT now(),
    source text DEFAULT 'fiat'::text NOT NULL,
    credential_issued boolean DEFAULT false
);

-- ---------------------------------------------------------------------------
-- Tables: profile
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profile.profiles (
    did text NOT NULL,
    handle text,
    display_name text NOT NULL,
    avatar text,
    bio text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    contact_email text,
    phone text,
    next_invite_available_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    visibility text DEFAULT 'public'::text NOT NULL,
    avatar_asset_id text,
    feature_toggles jsonb DEFAULT '{}'::jsonb NOT NULL,
    claimed_by text,
    claim_status text,
    banner text,
    banner_asset_id text
);

CREATE TABLE IF NOT EXISTS profile.connection_requests (
    id text NOT NULL,
    from_did text NOT NULL,
    to_did text NOT NULL,
    message text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    responded_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS profile.connections (
    id text NOT NULL,
    from_did text NOT NULL,
    to_did text NOT NULL,
    trust_level real DEFAULT 0 NOT NULL,
    source text NOT NULL,
    source_id text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile.did_migrations (
    id text NOT NULL,
    old_did text NOT NULL,
    new_did text NOT NULL,
    migrated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile.follows (
    id text NOT NULL,
    follower_did text NOT NULL,
    followed_did text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile.forest_config (
    group_did text NOT NULL,
    enabled_services text[] DEFAULT '{}'::text[] NOT NULL,
    landing_service text,
    theme jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    scope_fee_bps integer DEFAULT 25
);

CREATE TABLE IF NOT EXISTS profile.profile_images (
    id text NOT NULL,
    did text NOT NULL,
    url text NOT NULL,
    caption text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    created_by text NOT NULL
);

CREATE TABLE IF NOT EXISTS profile.query_logs (
    id text NOT NULL,
    requester_did text NOT NULL,
    target_did text NOT NULL,
    model text NOT NULL,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    cost_usd text DEFAULT '0'::text NOT NULL,
    settled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tables: registry (nodes first — others FK to it)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS registry.nodes (
    id text NOT NULL,
    public_key text NOT NULL,
    hostname text NOT NULL,
    subdomain text NOT NULL,
    services jsonb DEFAULT '[]'::jsonb,
    capabilities jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    build_hash text NOT NULL,
    version text NOT NULL,
    source_commit text,
    last_heartbeat timestamp with time zone,
    registered_at timestamp with time zone DEFAULT now(),
    verified_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    attestation jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    chain_did text
);

CREATE TABLE IF NOT EXISTS registry.app_logs (
    id text NOT NULL,
    service text NOT NULL,
    level text NOT NULL,
    message text NOT NULL,
    correlation_id text,
    did text,
    method text,
    path text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS registry.approved_builds (
    id text NOT NULL,
    version text NOT NULL,
    build_hash text NOT NULL,
    architecture text,
    release_date timestamp with time zone DEFAULT now(),
    deprecated boolean DEFAULT false,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry.bump_sessions (
    id text NOT NULL,
    did text NOT NULL,
    node_id text NOT NULL,
    location jsonb,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    deactivated_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS registry.bump_events (
    id text NOT NULL,
    session_id text NOT NULL,
    waveform jsonb NOT NULL,
    rotation_rate jsonb NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    location jsonb,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry.bump_matches (
    id text NOT NULL,
    node_id text NOT NULL,
    session_a text NOT NULL,
    session_b text NOT NULL,
    correlation_score real NOT NULL,
    confirmed_a boolean,
    confirmed_b boolean,
    connection_id text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry.did_interests (
    id text NOT NULL,
    did text NOT NULL,
    scope text NOT NULL,
    marketing boolean DEFAULT true,
    email boolean DEFAULT true,
    inapp boolean DEFAULT true,
    chat boolean DEFAULT true,
    created_by_attestation text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry.did_preferences (
    did text NOT NULL,
    global_marketing boolean DEFAULT true,
    auto_subscribe boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry.flags (
    id text NOT NULL,
    reporter_did text NOT NULL,
    target_did text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    resolved_at timestamp with time zone,
    resolved_by text,
    resolution text
);

CREATE TABLE IF NOT EXISTS registry.heartbeats (
    id text NOT NULL,
    node_id text NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now(),
    build_hash text NOT NULL,
    version text NOT NULL,
    health jsonb,
    signature text NOT NULL
);

CREATE TABLE IF NOT EXISTS registry.interests (
    id text NOT NULL,
    scope text NOT NULL,
    label text NOT NULL,
    description text,
    triggers jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry.moderation_log (
    id text NOT NULL,
    operator_did text NOT NULL,
    action text NOT NULL,
    target_did text NOT NULL,
    target_type text,
    target_id text,
    reason text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry.newsletter_sends (
    id text NOT NULL,
    sender_did text NOT NULL,
    subject text NOT NULL,
    audience_type text NOT NULL,
    audience_id text,
    recipient_count integer DEFAULT 0 NOT NULL,
    sent_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry.node_config (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry.request_log (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    service text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    status integer NOT NULL,
    duration_ms integer,
    did text,
    ip text,
    correlation_id text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS registry.system_events (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    service text NOT NULL,
    action text NOT NULL,
    did text,
    correlation_id text,
    parent_event_id text,
    payload jsonb,
    status text DEFAULT 'success'::text,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS registry.trust (
    id text NOT NULL,
    from_node text NOT NULL,
    to_node text NOT NULL,
    established_at timestamp with time zone NOT NULL,
    verification_method text NOT NULL,
    strength text NOT NULL,
    last_verified timestamp with time zone,
    from_signature text NOT NULL,
    to_signature text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tables: relay (excludes relay_documents, relay_public_credentials, relay_revocations → 0002)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS relay.relay_beacons (
    did text NOT NULL,
    jws_token text NOT NULL,
    beacon_cid text NOT NULL,
    state jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay.relay_blobs (
    creator_did text NOT NULL,
    document_cid text NOT NULL,
    data bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay.relay_config (
    id text DEFAULT 'singleton'::text NOT NULL,
    did text NOT NULL,
    profile_artifact_jws text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    node_fee_bps integer DEFAULT 50,
    buyer_credit_bps integer DEFAULT 25,
    node_operator_did text,
    imajin_did text
);

CREATE TABLE IF NOT EXISTS relay.relay_content_chains (
    content_id text NOT NULL,
    genesis_cid text NOT NULL,
    log jsonb DEFAULT '[]'::jsonb NOT NULL,
    state jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    last_created_at timestamp with time zone
);

CREATE SEQUENCE IF NOT EXISTS relay.relay_countersignatures_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE IF NOT EXISTS relay.relay_countersignatures (
    id integer NOT NULL DEFAULT nextval('relay.relay_countersignatures_id_seq'::regclass),
    operation_cid text NOT NULL,
    jws_token text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

ALTER SEQUENCE relay.relay_countersignatures_id_seq OWNED BY relay.relay_countersignatures.id;

CREATE TABLE IF NOT EXISTS relay.relay_identity_chains (
    did text NOT NULL,
    log jsonb DEFAULT '[]'::jsonb NOT NULL,
    state jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    head_cid text,
    last_created_at timestamp with time zone
);

CREATE SEQUENCE IF NOT EXISTS relay.relay_operation_log_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE IF NOT EXISTS relay.relay_operation_log (
    seq bigint NOT NULL DEFAULT nextval('relay.relay_operation_log_seq_seq'::regclass),
    cid text NOT NULL,
    jws_token text NOT NULL,
    kind text NOT NULL,
    chain_id text NOT NULL
);

ALTER SEQUENCE relay.relay_operation_log_seq_seq OWNED BY relay.relay_operation_log.seq;

CREATE TABLE IF NOT EXISTS relay.relay_operations (
    cid text NOT NULL,
    jws_token text NOT NULL,
    chain_type text NOT NULL,
    chain_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay.relay_peer_cursors (
    peer_url text NOT NULL,
    cursor text NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay.relay_pending_operations (
    cid text NOT NULL,
    jws_token text NOT NULL,
    received_at timestamp with time zone DEFAULT now(),
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    status text DEFAULT 'pending'::text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Tables: www
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS www.bug_reports (
    id text NOT NULL,
    reporter_did text NOT NULL,
    reporter_name text,
    reporter_email text,
    type text DEFAULT 'bug'::text NOT NULL,
    description text NOT NULL,
    screenshot_url text,
    page_url text,
    user_agent text,
    viewport text,
    status text DEFAULT 'new'::text NOT NULL,
    github_issue_number integer,
    github_issue_url text,
    admin_notes text,
    duplicate_of text,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS www.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    source text DEFAULT 'register'::text NOT NULL,
    is_verified boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS www.mailing_lists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    owner_did text
);

CREATE TABLE IF NOT EXISTS www.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    mailing_list_id uuid NOT NULL,
    status text DEFAULT 'subscribed'::text NOT NULL,
    subscribed_at timestamp with time zone DEFAULT now(),
    unsubscribed_at timestamp with time zone
);

-- ---------------------------------------------------------------------------
-- Primary Keys and Unique Constraints
-- (idempotent via EXCEPTION WHEN duplicate_object)
-- ---------------------------------------------------------------------------

DO $$ BEGIN ALTER TABLE ONLY auth.attestations ADD CONSTRAINT attestations_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.challenges ADD CONSTRAINT auth_challenges_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.identities ADD CONSTRAINT auth_identities_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.tokens ADD CONSTRAINT auth_tokens_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.credentials ADD CONSTRAINT credentials_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.devices ADD CONSTRAINT devices_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.identities ADD CONSTRAINT identities_handle_unique UNIQUE (handle); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.identities ADD CONSTRAINT identities_public_key_unique UNIQUE (public_key); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.identity_chains ADD CONSTRAINT identity_chains_dfos_did_unique UNIQUE (dfos_did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.identity_chains ADD CONSTRAINT identity_chains_pkey PRIMARY KEY (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.mfa_methods ADD CONSTRAINT mfa_methods_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.onboard_tokens ADD CONSTRAINT onboard_tokens_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.onboard_tokens ADD CONSTRAINT onboard_tokens_token_unique UNIQUE (token); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.stored_keys ADD CONSTRAINT stored_keys_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY chat.invites ADD CONSTRAINT chat_invites_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY chat.pre_keys ADD CONSTRAINT chat_pre_keys_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY chat.public_keys ADD CONSTRAINT chat_public_keys_pkey PRIMARY KEY (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY chat.conversation_members ADD CONSTRAINT conversation_members_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY chat.conversation_reads_v2 ADD CONSTRAINT conversation_reads_v2_conversation_did_did_pk PRIMARY KEY (conversation_did, did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY chat.conversations_v2 ADD CONSTRAINT conversations_v2_pkey PRIMARY KEY (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY chat.message_reactions_v2 ADD CONSTRAINT message_reactions_v2_message_id_did_emoji_pk PRIMARY KEY (message_id, did, emoji); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY chat.messages_v2 ADD CONSTRAINT messages_v2_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY coffee.pages ADD CONSTRAINT coffee_pages_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY coffee.pages ADD CONSTRAINT pages_did_unique UNIQUE (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY coffee.pages ADD CONSTRAINT pages_handle_unique UNIQUE (handle); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY coffee.tips ADD CONSTRAINT tips_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY connections.connections ADD CONSTRAINT connections_did_a_did_b_pk PRIMARY KEY (did_a, did_b); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY connections.invites ADD CONSTRAINT invites_code_unique UNIQUE (code); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY connections.nicknames ADD CONSTRAINT nicknames_did_target_pk PRIMARY KEY (did, target); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY connections.pod_keys ADD CONSTRAINT pod_keys_pod_id_version_pk PRIMARY KEY (pod_id, version); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY connections.pod_links ADD CONSTRAINT pod_links_parent_pod_id_child_pod_id_pk PRIMARY KEY (parent_pod_id, child_pod_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY connections.pod_member_keys ADD CONSTRAINT pod_member_keys_pod_id_version_did_pk PRIMARY KEY (pod_id, version, did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY connections.pod_members ADD CONSTRAINT pod_members_pod_id_did_pk PRIMARY KEY (pod_id, did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY connections.invites ADD CONSTRAINT trust_invites_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY connections.pods ADD CONSTRAINT trust_pods_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY dykil.survey_responses ADD CONSTRAINT survey_responses_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY dykil.surveys ADD CONSTRAINT surveys_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY events.event_invites ADD CONSTRAINT event_invites_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.event_invites ADD CONSTRAINT event_invites_token_unique UNIQUE (token); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.events ADD CONSTRAINT events_did_unique UNIQUE (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.events ADD CONSTRAINT events_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.ticket_queue ADD CONSTRAINT ticket_queue_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.ticket_registrations ADD CONSTRAINT ticket_registrations_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.ticket_transfers ADD CONSTRAINT ticket_transfers_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.ticket_types ADD CONSTRAINT ticket_types_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.tickets ADD CONSTRAINT tickets_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY learn.courses ADD CONSTRAINT courses_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY learn.courses ADD CONSTRAINT courses_slug_unique UNIQUE (slug); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY learn.enrollments ADD CONSTRAINT enrollments_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY learn.lesson_progress ADD CONSTRAINT lesson_progress_enrollment_id_lesson_id_pk PRIMARY KEY (enrollment_id, lesson_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY learn.lessons ADD CONSTRAINT lessons_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY learn.modules ADD CONSTRAINT modules_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY links.clicks ADD CONSTRAINT link_clicks_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY links.pages ADD CONSTRAINT link_pages_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY links.links ADD CONSTRAINT links_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY links.pages ADD CONSTRAINT pages_did_unique UNIQUE (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY links.pages ADD CONSTRAINT pages_handle_unique UNIQUE (handle); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY market.disputes ADD CONSTRAINT disputes_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY market.listings ADD CONSTRAINT listings_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY market.seller_settings ADD CONSTRAINT seller_settings_pkey PRIMARY KEY (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY media.asset_folders ADD CONSTRAINT asset_folders_asset_id_folder_id_pk PRIMARY KEY (asset_id, folder_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY media.asset_references ADD CONSTRAINT asset_references_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY media.assets ADD CONSTRAINT assets_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY media.folders ADD CONSTRAINT folders_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY notify.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY notify.preferences ADD CONSTRAINT preferences_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY pay.balance_rollups ADD CONSTRAINT balance_rollups_did_date_service_pk PRIMARY KEY (did, date, service); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY pay.balances ADD CONSTRAINT balances_pkey PRIMARY KEY (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY pay.connected_accounts ADD CONSTRAINT connected_accounts_did_unique UNIQUE (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY pay.connected_accounts ADD CONSTRAINT connected_accounts_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY pay.connected_accounts ADD CONSTRAINT connected_accounts_stripe_account_id_unique UNIQUE (stripe_account_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY pay.fee_ledger ADD CONSTRAINT fee_ledger_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY pay.transactions ADD CONSTRAINT transactions_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY profile.connection_requests ADD CONSTRAINT connection_requests_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY profile.connections ADD CONSTRAINT connections_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY profile.did_migrations ADD CONSTRAINT did_migrations_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY profile.follows ADD CONSTRAINT follows_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY profile.forest_config ADD CONSTRAINT forest_config_pkey PRIMARY KEY (group_did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY profile.profile_images ADD CONSTRAINT profile_images_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY profile.profiles ADD CONSTRAINT profiles_handle_unique UNIQUE (handle); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY profile.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY profile.query_logs ADD CONSTRAINT query_logs_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY registry.app_logs ADD CONSTRAINT app_logs_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.approved_builds ADD CONSTRAINT approved_builds_build_hash_unique UNIQUE (build_hash); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.bump_events ADD CONSTRAINT bump_events_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.bump_matches ADD CONSTRAINT bump_matches_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.bump_sessions ADD CONSTRAINT bump_sessions_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.did_interests ADD CONSTRAINT did_interests_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.did_preferences ADD CONSTRAINT did_preferences_pkey PRIMARY KEY (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.flags ADD CONSTRAINT flags_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.interests ADD CONSTRAINT interests_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.interests ADD CONSTRAINT interests_scope_unique UNIQUE (scope); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.moderation_log ADD CONSTRAINT moderation_log_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.newsletter_sends ADD CONSTRAINT newsletter_sends_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.node_config ADD CONSTRAINT node_config_pkey PRIMARY KEY (key); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.nodes ADD CONSTRAINT nodes_chain_did_unique UNIQUE (chain_did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.nodes ADD CONSTRAINT nodes_hostname_unique UNIQUE (hostname); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.nodes ADD CONSTRAINT nodes_public_key_unique UNIQUE (public_key); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.nodes ADD CONSTRAINT nodes_subdomain_unique UNIQUE (subdomain); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.approved_builds ADD CONSTRAINT registry_approved_builds_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.heartbeats ADD CONSTRAINT registry_heartbeats_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.nodes ADD CONSTRAINT registry_nodes_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.trust ADD CONSTRAINT registry_trust_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.request_log ADD CONSTRAINT request_log_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.system_events ADD CONSTRAINT system_events_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.did_interests ADD CONSTRAINT uniq_did_interests_did_scope UNIQUE (did, scope); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY relay.relay_beacons ADD CONSTRAINT relay_beacons_pkey PRIMARY KEY (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY relay.relay_blobs ADD CONSTRAINT relay_blobs_creator_did_document_cid_pk PRIMARY KEY (creator_did, document_cid); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY relay.relay_config ADD CONSTRAINT relay_config_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY relay.relay_content_chains ADD CONSTRAINT relay_content_chains_pkey PRIMARY KEY (content_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY relay.relay_countersignatures ADD CONSTRAINT relay_countersignatures_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY relay.relay_identity_chains ADD CONSTRAINT relay_identity_chains_pkey PRIMARY KEY (did); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY relay.relay_operation_log ADD CONSTRAINT relay_operation_log_pkey PRIMARY KEY (seq); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY relay.relay_operations ADD CONSTRAINT relay_operations_pkey PRIMARY KEY (cid); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY relay.relay_peer_cursors ADD CONSTRAINT relay_peer_cursors_pkey PRIMARY KEY (peer_url); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY relay.relay_pending_operations ADD CONSTRAINT relay_pending_operations_pkey PRIMARY KEY (cid); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY www.bug_reports ADD CONSTRAINT bug_reports_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY www.contacts ADD CONSTRAINT uniq_www_contacts_email UNIQUE (email); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY www.mailing_lists ADD CONSTRAINT uniq_www_mailing_lists_slug UNIQUE (slug); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY www.subscriptions ADD CONSTRAINT uniq_www_subscription UNIQUE (contact_id, mailing_list_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY www.contacts ADD CONSTRAINT www_contacts_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY www.mailing_lists ADD CONSTRAINT www_mailing_lists_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY www.subscriptions ADD CONSTRAINT www_subscriptions_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_auth_attestations_issuer ON auth.attestations USING btree (issuer_did);
CREATE INDEX IF NOT EXISTS idx_auth_attestations_status ON auth.attestations USING btree (attestation_status);
CREATE INDEX IF NOT EXISTS idx_auth_attestations_subject ON auth.attestations USING btree (subject_did);
CREATE INDEX IF NOT EXISTS idx_auth_attestations_type ON auth.attestations USING btree (type);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth.challenges USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_identities_handle ON auth.identities USING btree (handle);
CREATE INDEX IF NOT EXISTS idx_auth_onboard_tokens_email ON auth.onboard_tokens USING btree (email);
CREATE INDEX IF NOT EXISTS idx_auth_onboard_tokens_token ON auth.onboard_tokens USING btree (token);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_identity ON auth.tokens USING btree (identity_id);
CREATE INDEX IF NOT EXISTS idx_credentials_did ON auth.credentials USING btree (did);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_type_value ON auth.credentials USING btree (type, value);
CREATE INDEX IF NOT EXISTS idx_devices_did ON auth.devices USING btree (did);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_did_fingerprint ON auth.devices USING btree (did, fingerprint);
CREATE INDEX IF NOT EXISTS idx_group_controllers_controller ON auth.identity_members USING btree (member_did);
CREATE INDEX IF NOT EXISTS idx_group_controllers_pk ON auth.identity_members USING btree (identity_did, member_did);
CREATE INDEX IF NOT EXISTS idx_identities_scope ON auth.identities USING btree (scope);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_chains_dfos_did ON auth.identity_chains USING btree (dfos_did);
CREATE INDEX IF NOT EXISTS idx_mfa_methods_did ON auth.mfa_methods USING btree (did);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stored_keys_did ON auth.stored_keys USING btree (did);

CREATE INDEX IF NOT EXISTS idx_chat_conv_v2_created_by ON chat.conversations_v2 USING btree (created_by);
CREATE INDEX IF NOT EXISTS idx_chat_conv_v2_last_message ON chat.conversations_v2 USING btree (last_message_at);
CREATE INDEX IF NOT EXISTS idx_chat_conv_v2_parent_did ON chat.conversations_v2 USING btree (parent_did);
CREATE INDEX IF NOT EXISTS idx_chat_invites_conversation ON chat.invites USING btree (conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_invites_for_did ON chat.invites USING btree (for_did);
CREATE INDEX IF NOT EXISTS idx_chat_msg_v2_conversation ON chat.messages_v2 USING btree (conversation_did);
CREATE INDEX IF NOT EXISTS idx_chat_msg_v2_created ON chat.messages_v2 USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_chat_msg_v2_from ON chat.messages_v2 USING btree (from_did);
CREATE INDEX IF NOT EXISTS idx_chat_pre_keys_did ON chat.pre_keys USING btree (did);
CREATE INDEX IF NOT EXISTS idx_chat_react_v2_message ON chat.message_reactions_v2 USING btree (message_id);
CREATE INDEX IF NOT EXISTS idx_chat_reads_v2_did ON chat.conversation_reads_v2 USING btree (did);
CREATE INDEX IF NOT EXISTS idx_conv_members_conv ON chat.conversation_members USING btree (conversation_did);
CREATE INDEX IF NOT EXISTS idx_conv_members_member ON chat.conversation_members USING btree (member_did);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_members_unique ON chat.conversation_members USING btree (conversation_did, member_did);

CREATE INDEX IF NOT EXISTS idx_coffee_pages_did ON coffee.pages USING btree (did);
CREATE INDEX IF NOT EXISTS idx_coffee_pages_handle ON coffee.pages USING btree (handle);
CREATE INDEX IF NOT EXISTS idx_tips_created ON coffee.tips USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_tips_page ON coffee.tips USING btree (page_id);
CREATE INDEX IF NOT EXISTS idx_tips_status ON coffee.tips USING btree (status);

CREATE INDEX IF NOT EXISTS connections_did_a_idx ON connections.connections USING btree (did_a);
CREATE INDEX IF NOT EXISTS connections_did_b_idx ON connections.connections USING btree (did_b);
CREATE INDEX IF NOT EXISTS idx_invites_code ON connections.invites USING btree (code);
CREATE INDEX IF NOT EXISTS idx_invites_from_did ON connections.invites USING btree (from_did);
CREATE INDEX IF NOT EXISTS idx_invites_status ON connections.invites USING btree (status);
CREATE INDEX IF NOT EXISTS idx_invites_to_email ON connections.invites USING btree (to_email);
CREATE INDEX IF NOT EXISTS trust_pod_members_did_idx ON connections.pod_members USING btree (did);
CREATE INDEX IF NOT EXISTS trust_pods_conversation_did_idx ON connections.pods USING btree (conversation_did);
CREATE INDEX IF NOT EXISTS trust_pods_owner_idx ON connections.pods USING btree (owner_did);

CREATE INDEX IF NOT EXISTS idx_responses_created ON dykil.survey_responses USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_responses_respondent ON dykil.survey_responses USING btree (respondent_did);
CREATE INDEX IF NOT EXISTS idx_responses_survey ON dykil.survey_responses USING btree (survey_id);
CREATE INDEX IF NOT EXISTS idx_surveys_did ON dykil.surveys USING btree (did);
CREATE INDEX IF NOT EXISTS idx_surveys_handle ON dykil.surveys USING btree (handle);
CREATE INDEX IF NOT EXISTS idx_surveys_status ON dykil.surveys USING btree (status);

CREATE INDEX IF NOT EXISTS idx_events_course_slug ON events.events USING btree (course_slug);
CREATE INDEX IF NOT EXISTS idx_events_creator ON events.events USING btree (creator_did);
CREATE INDEX IF NOT EXISTS idx_events_pod_id ON events.events USING btree (pod_id);
CREATE INDEX IF NOT EXISTS idx_events_starts ON events.events USING btree (starts_at);
CREATE INDEX IF NOT EXISTS idx_events_status ON events.events USING btree (status);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON events.orders USING btree (buyer_did);
CREATE INDEX IF NOT EXISTS idx_orders_event ON events.orders USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_session ON events.orders USING btree (stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_ticket_queue_did ON events.ticket_queue USING btree (did);
CREATE INDEX IF NOT EXISTS idx_ticket_queue_position ON events.ticket_queue USING btree ("position");
CREATE INDEX IF NOT EXISTS idx_ticket_queue_status ON events.ticket_queue USING btree (status);
CREATE INDEX IF NOT EXISTS idx_ticket_queue_type ON events.ticket_queue USING btree (ticket_type_id);
CREATE INDEX IF NOT EXISTS idx_ticket_registrations_email ON events.ticket_registrations USING btree (email);
CREATE INDEX IF NOT EXISTS idx_ticket_registrations_event ON events.ticket_registrations USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_ticket_registrations_ticket ON events.ticket_registrations USING btree (ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_transfers_from ON events.ticket_transfers USING btree (from_did);
CREATE INDEX IF NOT EXISTS idx_ticket_transfers_ticket ON events.ticket_transfers USING btree (ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_transfers_to ON events.ticket_transfers USING btree (to_did);
CREATE INDEX IF NOT EXISTS idx_ticket_types_event ON events.ticket_types USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON events.tickets USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_held_by ON events.tickets USING btree (held_by);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON events.tickets USING btree (order_id);
CREATE INDEX IF NOT EXISTS idx_tickets_owner ON events.tickets USING btree (owner_did);
CREATE INDEX IF NOT EXISTS idx_tickets_registration_status ON events.tickets USING btree (registration_status);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON events.tickets USING btree (status);

CREATE INDEX IF NOT EXISTS idx_learn_courses_creator_did ON learn.courses USING btree (creator_did);
CREATE INDEX IF NOT EXISTS idx_learn_courses_slug ON learn.courses USING btree (slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_learn_enrollments_course_student ON learn.enrollments USING btree (course_id, student_did);
CREATE INDEX IF NOT EXISTS idx_learn_enrollments_student_did ON learn.enrollments USING btree (student_did);
CREATE INDEX IF NOT EXISTS idx_learn_lessons_module_id ON learn.lessons USING btree (module_id);
CREATE INDEX IF NOT EXISTS idx_learn_modules_course_id ON learn.modules USING btree (course_id);

CREATE INDEX IF NOT EXISTS idx_link_clicks_date ON links.clicks USING btree (clicked_at);
CREATE INDEX IF NOT EXISTS idx_link_clicks_link ON links.clicks USING btree (link_id);
CREATE INDEX IF NOT EXISTS idx_link_pages_did ON links.pages USING btree (did);
CREATE INDEX IF NOT EXISTS idx_link_pages_handle ON links.pages USING btree (handle);
CREATE INDEX IF NOT EXISTS idx_links_page ON links.links USING btree (page_id);
CREATE INDEX IF NOT EXISTS idx_links_position ON links.links USING btree (page_id, "position");

CREATE INDEX IF NOT EXISTS idx_market_listings_category_status ON market.listings USING btree (category, status);
CREATE INDEX IF NOT EXISTS idx_market_listings_seller_did ON market.listings USING btree (seller_did);
CREATE INDEX IF NOT EXISTS idx_market_listings_status_created ON market.listings USING btree (status, created_at);

CREATE INDEX IF NOT EXISTS idx_asset_folders_asset ON media.asset_folders USING btree (asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_folders_folder ON media.asset_folders USING btree (folder_id);
CREATE INDEX IF NOT EXISTS idx_assets_created ON media.assets USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_assets_folder ON media.assets USING btree (folder_id);
CREATE INDEX IF NOT EXISTS idx_assets_mime ON media.assets USING btree (mime_type);
CREATE INDEX IF NOT EXISTS idx_assets_owner ON media.assets USING btree (owner_did);
CREATE INDEX IF NOT EXISTS idx_assets_status ON media.assets USING btree (status);
CREATE INDEX IF NOT EXISTS idx_folders_owner ON media.folders USING btree (owner_did);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON media.folders USING btree (parent_id);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notify.notifications USING btree (recipient_did, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notify.notifications USING btree (recipient_did);
CREATE INDEX IF NOT EXISTS idx_preferences_did_scope ON notify.preferences USING btree (did, scope);

CREATE INDEX IF NOT EXISTS idx_balance_rollups_date ON pay.balance_rollups USING btree (date);
CREATE INDEX IF NOT EXISTS idx_balance_rollups_did ON pay.balance_rollups USING btree (did);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_did ON pay.connected_accounts USING btree (did);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_stripe ON pay.connected_accounts USING btree (stripe_account_id);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_recipient ON pay.fee_ledger USING btree (recipient_did, status);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_tx ON pay.fee_ledger USING btree (transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON pay.transactions USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_from_did ON pay.transactions USING btree (from_did);
CREATE INDEX IF NOT EXISTS idx_transactions_service ON pay.transactions USING btree (service);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON pay.transactions USING btree (status);
CREATE INDEX IF NOT EXISTS idx_transactions_stripe_id ON pay.transactions USING btree (stripe_id);
CREATE INDEX IF NOT EXISTS idx_transactions_to_did ON pay.transactions USING btree (to_did);

CREATE INDEX IF NOT EXISTS idx_conn_requests_from ON profile.connection_requests USING btree (from_did);
CREATE INDEX IF NOT EXISTS idx_conn_requests_status ON profile.connection_requests USING btree (status);
CREATE INDEX IF NOT EXISTS idx_conn_requests_to ON profile.connection_requests USING btree (to_did);
CREATE INDEX IF NOT EXISTS idx_connections_from ON profile.connections USING btree (from_did);
CREATE INDEX IF NOT EXISTS idx_connections_source ON profile.connections USING btree (source, source_id);
CREATE INDEX IF NOT EXISTS idx_connections_to ON profile.connections USING btree (to_did);
CREATE INDEX IF NOT EXISTS idx_did_migrations_new ON profile.did_migrations USING btree (new_did);
CREATE INDEX IF NOT EXISTS idx_did_migrations_old ON profile.did_migrations USING btree (old_did);
CREATE INDEX IF NOT EXISTS idx_follows_followed ON profile.follows USING btree (followed_did);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON profile.follows USING btree (follower_did);
CREATE UNIQUE INDEX IF NOT EXISTS idx_follows_unique ON profile.follows USING btree (follower_did, followed_did);
CREATE INDEX IF NOT EXISTS idx_profile_images_did ON profile.profile_images USING btree (did);
CREATE INDEX IF NOT EXISTS idx_profiles_claim_status ON profile.profiles USING btree (claim_status) WHERE (claim_status IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_profiles_handle ON profile.profiles USING btree (handle);
CREATE INDEX IF NOT EXISTS idx_query_logs_requester ON profile.query_logs USING btree (requester_did);
CREATE INDEX IF NOT EXISTS idx_query_logs_target ON profile.query_logs USING btree (target_did);

CREATE INDEX IF NOT EXISTS idx_app_logs_correlation ON registry.app_logs USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_app_logs_created ON registry.app_logs USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_app_logs_service_level ON registry.app_logs USING btree (service, level);
CREATE INDEX IF NOT EXISTS idx_bump_events_session_created ON registry.bump_events USING btree (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bump_matches_expires_no_connection ON registry.bump_matches USING btree (expires_at) WHERE (connection_id IS NULL);
CREATE INDEX IF NOT EXISTS idx_bump_sessions_node_expires ON registry.bump_sessions USING btree (node_id, expires_at) WHERE (deactivated_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_did_interests_did ON registry.did_interests USING btree (did);
CREATE INDEX IF NOT EXISTS idx_did_interests_scope ON registry.did_interests USING btree (scope);
CREATE INDEX IF NOT EXISTS idx_registry_builds_hash ON registry.approved_builds USING btree (build_hash);
CREATE INDEX IF NOT EXISTS idx_registry_builds_version ON registry.approved_builds USING btree (version);
CREATE INDEX IF NOT EXISTS idx_registry_heartbeats_node ON registry.heartbeats USING btree (node_id);
CREATE INDEX IF NOT EXISTS idx_registry_heartbeats_timestamp ON registry.heartbeats USING btree ("timestamp");
CREATE INDEX IF NOT EXISTS idx_registry_nodes_expires ON registry.nodes USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_registry_nodes_hostname ON registry.nodes USING btree (hostname);
CREATE INDEX IF NOT EXISTS idx_registry_nodes_status ON registry.nodes USING btree (status);
CREATE INDEX IF NOT EXISTS idx_registry_trust_from ON registry.trust USING btree (from_node);
CREATE INDEX IF NOT EXISTS idx_registry_trust_to ON registry.trust USING btree (to_node);
CREATE INDEX IF NOT EXISTS idx_request_log_correlation ON registry.request_log USING btree (correlation_id);
CREATE INDEX IF NOT EXISTS idx_request_log_service_created ON registry.request_log USING btree (service, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_log_status ON registry.request_log USING btree (status) WHERE (status >= 400);
CREATE INDEX IF NOT EXISTS idx_system_events_correlation ON registry.system_events USING btree (correlation_id);
CREATE INDEX IF NOT EXISTS idx_system_events_created ON registry.system_events USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_events_did ON registry.system_events USING btree (did);
CREATE INDEX IF NOT EXISTS idx_system_events_service_action ON registry.system_events USING btree (service, action);

CREATE INDEX IF NOT EXISTS idx_relay_countersignatures_operation_cid ON relay.relay_countersignatures USING btree (operation_cid);
CREATE INDEX IF NOT EXISTS idx_relay_operation_log_cid ON relay.relay_operation_log USING btree (cid);

CREATE INDEX IF NOT EXISTS idx_bug_reports_reporter ON www.bug_reports USING btree (reporter_did);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON www.bug_reports USING btree (status);
CREATE INDEX IF NOT EXISTS idx_www_contacts_email ON www.contacts USING btree (email);
CREATE INDEX IF NOT EXISTS idx_www_mailing_lists_slug ON www.mailing_lists USING btree (slug);
CREATE INDEX IF NOT EXISTS idx_www_subscriptions_contact ON www.subscriptions USING btree (contact_id);
CREATE INDEX IF NOT EXISTS idx_www_subscriptions_list ON www.subscriptions USING btree (mailing_list_id);

-- ---------------------------------------------------------------------------
-- Foreign Key Constraints
-- ---------------------------------------------------------------------------

DO $$ BEGIN ALTER TABLE ONLY auth.challenges ADD CONSTRAINT challenges_identity_id_identities_id_fk FOREIGN KEY (identity_id) REFERENCES auth.identities(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.devices ADD CONSTRAINT devices_did_identities_id_fk FOREIGN KEY (did) REFERENCES auth.identities(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.identity_chains ADD CONSTRAINT identity_chains_did_identities_id_fk FOREIGN KEY (did) REFERENCES auth.identities(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.mfa_methods ADD CONSTRAINT mfa_methods_did_identities_id_fk FOREIGN KEY (did) REFERENCES auth.identities(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.stored_keys ADD CONSTRAINT stored_keys_did_identities_id_fk FOREIGN KEY (did) REFERENCES auth.identities(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY auth.tokens ADD CONSTRAINT tokens_identity_id_identities_id_fk FOREIGN KEY (identity_id) REFERENCES auth.identities(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY chat.conversation_members ADD CONSTRAINT conversation_members_conversation_did_conversations_v2_did_fk FOREIGN KEY (conversation_did) REFERENCES chat.conversations_v2(did) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY chat.conversation_reads_v2 ADD CONSTRAINT conversation_reads_v2_conversation_did_conversations_v2_did_fk FOREIGN KEY (conversation_did) REFERENCES chat.conversations_v2(did) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY chat.message_reactions_v2 ADD CONSTRAINT message_reactions_v2_message_id_messages_v2_id_fk FOREIGN KEY (message_id) REFERENCES chat.messages_v2(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY chat.messages_v2 ADD CONSTRAINT messages_v2_conversation_did_conversations_v2_did_fk FOREIGN KEY (conversation_did) REFERENCES chat.conversations_v2(did) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY chat.pre_keys ADD CONSTRAINT pre_keys_did_public_keys_did_fk FOREIGN KEY (did) REFERENCES chat.public_keys(did) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY coffee.tips ADD CONSTRAINT tips_page_id_pages_id_fk FOREIGN KEY (page_id) REFERENCES coffee.pages(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY connections.pod_keys ADD CONSTRAINT pod_keys_pod_id_pods_id_fk FOREIGN KEY (pod_id) REFERENCES connections.pods(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY connections.pod_links ADD CONSTRAINT pod_links_child_pod_id_pods_id_fk FOREIGN KEY (child_pod_id) REFERENCES connections.pods(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY connections.pod_links ADD CONSTRAINT pod_links_parent_pod_id_pods_id_fk FOREIGN KEY (parent_pod_id) REFERENCES connections.pods(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY connections.pod_members ADD CONSTRAINT pod_members_pod_id_pods_id_fk FOREIGN KEY (pod_id) REFERENCES connections.pods(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY dykil.survey_responses ADD CONSTRAINT survey_responses_survey_id_surveys_id_fk FOREIGN KEY (survey_id) REFERENCES dykil.surveys(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY events.event_invites ADD CONSTRAINT event_invites_event_id_events_id_fk FOREIGN KEY (event_id) REFERENCES events.events(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.orders ADD CONSTRAINT orders_event_id_events_id_fk FOREIGN KEY (event_id) REFERENCES events.events(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.orders ADD CONSTRAINT orders_ticket_type_id_ticket_types_id_fk FOREIGN KEY (ticket_type_id) REFERENCES events.ticket_types(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.ticket_queue ADD CONSTRAINT ticket_queue_ticket_type_id_ticket_types_id_fk FOREIGN KEY (ticket_type_id) REFERENCES events.ticket_types(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.ticket_registrations ADD CONSTRAINT ticket_registrations_event_id_events_id_fk FOREIGN KEY (event_id) REFERENCES events.events(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.ticket_registrations ADD CONSTRAINT ticket_registrations_ticket_id_tickets_id_fk FOREIGN KEY (ticket_id) REFERENCES events.tickets(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.ticket_transfers ADD CONSTRAINT ticket_transfers_ticket_id_tickets_id_fk FOREIGN KEY (ticket_id) REFERENCES events.tickets(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.ticket_types ADD CONSTRAINT ticket_types_event_id_events_id_fk FOREIGN KEY (event_id) REFERENCES events.events(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.tickets ADD CONSTRAINT tickets_event_id_events_id_fk FOREIGN KEY (event_id) REFERENCES events.events(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.tickets ADD CONSTRAINT tickets_order_id_orders_id_fk FOREIGN KEY (order_id) REFERENCES events.orders(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY events.tickets ADD CONSTRAINT tickets_ticket_type_id_ticket_types_id_fk FOREIGN KEY (ticket_type_id) REFERENCES events.ticket_types(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY learn.enrollments ADD CONSTRAINT enrollments_course_id_courses_id_fk FOREIGN KEY (course_id) REFERENCES learn.courses(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY learn.lesson_progress ADD CONSTRAINT lesson_progress_enrollment_id_enrollments_id_fk FOREIGN KEY (enrollment_id) REFERENCES learn.enrollments(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY learn.lesson_progress ADD CONSTRAINT lesson_progress_lesson_id_lessons_id_fk FOREIGN KEY (lesson_id) REFERENCES learn.lessons(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY learn.lessons ADD CONSTRAINT lessons_module_id_modules_id_fk FOREIGN KEY (module_id) REFERENCES learn.modules(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY learn.modules ADD CONSTRAINT modules_course_id_courses_id_fk FOREIGN KEY (course_id) REFERENCES learn.courses(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY links.clicks ADD CONSTRAINT clicks_link_id_links_id_fk FOREIGN KEY (link_id) REFERENCES links.links(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY links.links ADD CONSTRAINT links_page_id_pages_id_fk FOREIGN KEY (page_id) REFERENCES links.pages(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY market.disputes ADD CONSTRAINT disputes_listing_id_listings_id_fk FOREIGN KEY (listing_id) REFERENCES market.listings(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY media.asset_folders ADD CONSTRAINT asset_folders_asset_id_assets_id_fk FOREIGN KEY (asset_id) REFERENCES media.assets(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY media.asset_folders ADD CONSTRAINT asset_folders_folder_id_folders_id_fk FOREIGN KEY (folder_id) REFERENCES media.folders(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY registry.bump_events ADD CONSTRAINT bump_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES registry.bump_sessions(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.bump_matches ADD CONSTRAINT bump_matches_session_a_fkey FOREIGN KEY (session_a) REFERENCES registry.bump_sessions(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.bump_matches ADD CONSTRAINT bump_matches_session_b_fkey FOREIGN KEY (session_b) REFERENCES registry.bump_sessions(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.heartbeats ADD CONSTRAINT heartbeats_node_id_nodes_id_fk FOREIGN KEY (node_id) REFERENCES registry.nodes(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.trust ADD CONSTRAINT trust_from_node_nodes_id_fk FOREIGN KEY (from_node) REFERENCES registry.nodes(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY registry.trust ADD CONSTRAINT trust_to_node_nodes_id_fk FOREIGN KEY (to_node) REFERENCES registry.nodes(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE ONLY www.subscriptions ADD CONSTRAINT subscriptions_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES www.contacts(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ONLY www.subscriptions ADD CONSTRAINT subscriptions_mailing_list_id_mailing_lists_id_fk FOREIGN KEY (mailing_list_id) REFERENCES www.mailing_lists(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
