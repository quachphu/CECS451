-- AI core v1: evidence-backed capacities with a stored confidence score.
--
-- Additive only. Every column is nullable or has a constant default, so on
-- PostgreSQL 11+ none of these ADD COLUMNs rewrites the table [D5] (the CHECK
-- constraints are validated by a scan, not a rewrite). max_capacity stays
-- NOT NULL — it's read in 28 places across the UI — and an estimate is
-- marked with is_estimate instead of by nulling the number. The trust_level
-- enum, RLS policies and existing indexes are untouched.

alter table venue_rooms
  -- Probability the stored capacity is right, computed at write time by
  -- src/lib/discovery/confidence.ts (the search path does no inference).
  add column if not exists capacity_confidence real
    check (capacity_confidence is null or (capacity_confidence >= 0 and capacity_confidence <= 1)),
  -- The capacity is a category guess, not a figure read anywhere. Ranking
  -- ignores the number of an estimate room and uses a base rate instead.
  add column if not exists is_estimate boolean not null default false,
  -- The sentence on the venue's own site that states the capacity, and where.
  add column if not exists evidence_quote text,
  add column if not exists evidence_url text,
  -- The features confidence was computed from, logged so the model can be
  -- refit offline (scripts/train_confidence.py).
  add column if not exists confidence_features jsonb;

-- Backfill: rooms created from category estimates.
update venue_rooms set is_estimate = true where room_name = 'Capacity unconfirmed';
-- The discovery pipeline also labels a category estimate this way when a
-- private-events page exists but publishes no number.
update venue_rooms set is_estimate = true where room_name = 'Private events available (capacity unpublished)';
-- The two curated seed rooms whose capacity was estimated during manual
-- research (Tropics Bar & Grill, Chart House); their trust tiers are unchanged.
update venue_rooms set is_estimate = true
  where room_name ilike '%(estimated%'
    and venue_id in (select id from venues where source = 'curated_seed');

-- A planner confirmation that contradicts strong existing evidence is kept
-- for review instead of overwriting the catalog (see confirmVenueDetailAction).
alter table venue_confirmations
  add column if not exists status text not null default 'accepted'
    check (status in ('accepted', 'pending'));
