'use client';

import { useState } from 'react';
import type { TicketType } from '@/src/db/schema';
import { EventStatusControls } from './event-status-controls';
import { CohostManager } from './cohost-manager';
import { InviteManager } from './invite-manager';
import { MessageComposer } from './message-composer';

type Tab = 'stats' | 'edit' | 'cohosts' | 'invites' | 'message';

interface AdminTabsProps {
  eventId: string;
  eventTitle: string;
  eventStatus: string;
  isOwner: boolean;
  ownerDid?: string;
  accessMode: string;
  cohostCount: number;
  inviteCount: number;
  confirmedAttendeeCount: number;
  totalSold: number;
  confirmedRevenue: number;
  heldRevenue: number;
  checkedIn: number;
  tiers: TicketType[];
  eventDate: string;
  basePath: string;
}

export function AdminTabs({
  eventId,
  eventTitle,
  eventStatus,
  isOwner,
  ownerDid,
  accessMode,
  cohostCount,
  inviteCount,
  confirmedAttendeeCount,
  totalSold,
  confirmedRevenue,
  heldRevenue,
  checkedIn,
  tiers,
  eventDate,
  basePath,
}: AdminTabsProps) {
  const [activeTab, setActiveTab] = useState<Tab>('stats');

  const tabs: { key: Tab; label: string }[] = [
    { key: 'stats', label: 'Stats' },
    { key: 'edit', label: 'Edit Event' },
    { key: 'cohosts', label: `Co-hosts (${cohostCount})` },
    { key: 'invites', label: `Invitations (${inviteCount})` },
    { key: 'message', label: 'Message Attendees' },
  ];

  return (
    <div>
      {/* Event Status bar */}
      <EventStatusControls eventId={eventId} currentStatus={eventStatus} />

      {/* Tab bar */}
      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-gray-700 mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-[1px] ${
              activeTab === tab.key
                ? 'border-orange-500 text-orange-500'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-[200px]">
        {activeTab === 'stats' && (
          <StatsTab
            totalSold={totalSold}
            confirmedRevenue={confirmedRevenue}
            heldRevenue={heldRevenue}
            checkedIn={checkedIn}
            eventDate={eventDate}
            tiers={tiers}
            basePath={basePath}
            eventId={eventId}
          />
        )}

        {activeTab === 'edit' && (
          <EditTab basePath={basePath} eventId={eventId} />
        )}

        {activeTab === 'cohosts' && (
          <CohostManager eventId={eventId} isOwner={isOwner} ownerDid={ownerDid} />
        )}

        {activeTab === 'invites' && (
          <InviteManager eventId={eventId} accessMode={accessMode} />
        )}

        {activeTab === 'message' && (
          <MessageComposer
            eventId={eventId}
            recipientCount={confirmedAttendeeCount}
            tiers={tiers}
          />
        )}
      </div>
    </div>
  );
}

function StatsTab({
  totalSold,
  confirmedRevenue,
  heldRevenue,
  checkedIn,
  eventDate,
  tiers,
  basePath,
  eventId,
}: {
  totalSold: number;
  confirmedRevenue: number;
  heldRevenue: number;
  checkedIn: number;
  eventDate: string;
  tiers: TicketType[];
  basePath: string;
  eventId: string;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Event Overview</h2>
        <a
          href={`${basePath}/${eventId}`}
          className="text-sm text-orange-500 hover:text-orange-600 font-medium"
        >
          View Live Event →
        </a>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
        <StatCard label="Tickets Sold" value={totalSold} />
        <StatCard label="Revenue" value={formatRevenue(confirmedRevenue, heldRevenue, 'CAD')} />
        <StatCard label="Checked In" value={`${checkedIn} / ${totalSold}`} />
        <StatCard
          label="Event Date"
          value={new Date(eventDate).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          })}
        />
      </div>

      {/* Ticket Tiers */}
      <div>
        <h2 className="text-xl font-semibold mb-2 md:mb-4">Ticket Tiers</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 md:gap-4">
          {tiers.map((tier) => (
            <div
              key={tier.id}
              className="bg-white dark:bg-gray-800 rounded-lg p-3 md:p-4 shadow"
            >
              <h3 className="font-semibold">{tier.name}</h3>
              <p className="text-2xl font-bold mt-2">
                {tier.sold} <span className="text-sm text-gray-500">/ {tier.quantity ?? '∞'}</span>
              </p>
              <p className="text-sm text-gray-500">
                {formatCurrency(tier.price, tier.currency)} each
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EditTab({ basePath, eventId }: { basePath: string; eventId: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow">
      <h2 className="text-xl font-semibold mb-4">Edit Event</h2>
      <p className="text-gray-600 dark:text-gray-400 mb-4">
        Make changes to your event details, ticket tiers, and settings.
      </p>
      <a
        href={`${basePath}/${eventId}/edit`}
        className="inline-flex items-center px-5 py-2.5 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition"
      >
        Open Edit Page →
      </a>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-3 md:p-4 shadow">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

function formatCurrency(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

function formatCurrencyRound(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatRevenue(confirmedCents: number, heldCents: number, currency: string): string {
  const confirmed = formatCurrencyRound(confirmedCents, currency);
  if (heldCents > 0) {
    return `${confirmed} (+${formatCurrencyRound(heldCents, currency)} pending)`;
  }
  return confirmed;
}
