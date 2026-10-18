import { capacityBelief } from "@/lib/ranking";
import type { ConfirmationStatus, VenueRoomRow } from "@/lib/supabase/types";

/** A room believed at least this much needs corroboration before a planner can overwrite it. */
export const CORROBORATION_CONFIDENCE = 0.85;
/** ...when the reported figure differs from it by more than this fraction. */
export const CORROBORATION_DIFFERENCE = 0.5;

/**
 * Whether a planner-reported capacity is applied straight away or held for
 * review. Confirmations used to be trusted on sight; now a figure that
 * contradicts strong existing evidence by more than 50% (a typo of 600 for 60,
 * or the wrong room) waits instead of overwriting the shared catalog.
 */
export function confirmationStatus(
  room: Pick<VenueRoomRow, "max_capacity" | "capacity_confidence" | "capacity_trust" | "confidence_features"> | null,
  confirmedMaxCapacity: number | null
): ConfirmationStatus {
  if (!room || confirmedMaxCapacity == null || room.max_capacity <= 0) return "accepted";
  const difference = Math.abs(confirmedMaxCapacity - room.max_capacity) / room.max_capacity;
  return capacityBelief(room) >= CORROBORATION_CONFIDENCE && difference > CORROBORATION_DIFFERENCE
    ? "pending"
    : "accepted";
}
