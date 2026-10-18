/**
 * Matching an extracted room to a label room, and the correctness label
 * (Steps 7, 8 and 13). Within one venue, in this order:
 *
 *   1. same style and matching names (normalized key equal, or token Jaccard ≥ 0.5);
 *   2. otherwise the label room of that style with the nearest capacity, within ±25%;
 *   3. otherwise unmatched.
 *
 * Like is compared with like: seated to seated_max, standing to standing_max;
 * an unspecified style compares to seated_max, else standing_max, else (for a
 * buyout) the venue's total seats.
 */
import {
  FULL_BUYOUT,
  canonicalRoomName,
  normalizeRoomKey,
  roomNameJaccard,
} from "../../../src/lib/discovery/room-normalize";

export type Style = "seated" | "standing" | "unspecified";

export type LabelRoom = {
  roomName: string;
  seatedMax: number | null;
  standingMax: number | null;
  min: number | null;
};

export type ExtractedRoom = {
  roomKey: string;
  roomName: string;
  style: Style;
  capacity: number;
};

export const NAME_JACCARD = 0.5;
export const NEAREST_WINDOW = 0.25;
export const CORRECT_WITHIN = 0.1;

export type Figure = "seated" | "standing" | "total";

/** Which figure of a label an extraction of `style` is compared against. */
export function labelField(
  label: LabelRoom,
  style: Style,
  totalSeats: number | null,
): Figure | null {
  if (style === "seated") return label.seatedMax != null ? "seated" : null;
  if (style === "standing")
    return label.standingMax != null ? "standing" : null;
  if (label.seatedMax != null) return "seated";
  if (label.standingMax != null) return "standing";
  return canonicalRoomName(label.roomName) === FULL_BUYOUT && totalSeats != null
    ? "total"
    : null;
}

/** The label figure an extraction of `style` is compared against, or null when the label has none. */
export function labelValue(
  label: LabelRoom,
  style: Style,
  totalSeats: number | null,
): number | null {
  const field = labelField(label, style, totalSeats);
  return field === "seated"
    ? label.seatedMax
    : field === "standing"
      ? label.standingMax
      : field === "total"
        ? totalSeats
        : null;
}

export function namesMatch(a: string, b: string): boolean {
  const ka = normalizeRoomKey(a);
  return (
    (ka !== "" && ka === normalizeRoomKey(b)) ||
    roomNameJaccard(a, b) >= NAME_JACCARD
  );
}

export type Match = {
  label: LabelRoom;
  value: number;
  field: Figure;
  by: "name" | "nearest";
} | null;

/**
 * Step 1 then step 2 for one extracted room; ties go to the closer capacity,
 * then label order. `isUsed` excludes figures already taken (one-to-one).
 */
export function matchRoom(
  room: ExtractedRoom,
  labels: LabelRoom[],
  totalSeats: number | null,
  isUsed: (label: LabelRoom, field: Figure) => boolean = () => false,
): Match {
  const withValue = labels
    .map((label, index) => {
      const field = labelField(label, room.style, totalSeats);
      return {
        label,
        index,
        field,
        value: labelValue(label, room.style, totalSeats),
      };
    })
    .filter(
      (
        c,
      ): c is {
        label: LabelRoom;
        index: number;
        field: Figure;
        value: number;
      } =>
        c.field != null &&
        c.value != null &&
        c.value > 0 &&
        !isUsed(c.label, c.field),
    );
  const byCloseness = (
    a: { value: number; index: number },
    b: { value: number; index: number },
  ) =>
    Math.abs(a.value - room.capacity) - Math.abs(b.value - room.capacity) ||
    a.index - b.index;

  const named = withValue
    .filter((c) => namesMatch(room.roomName, c.label.roomName))
    .sort(
      (a, b) =>
        roomNameJaccard(room.roomName, b.label.roomName) -
          roomNameJaccard(room.roomName, a.label.roomName) || byCloseness(a, b),
    );
  if (named.length)
    return {
      label: named[0].label,
      value: named[0].value,
      field: named[0].field,
      by: "name",
    };

  const near = withValue
    .filter(
      (c) => Math.abs(room.capacity - c.value) <= NEAREST_WINDOW * c.value,
    )
    .sort(byCloseness);
  if (near.length)
    return {
      label: near[0].label,
      value: near[0].value,
      field: near[0].field,
      by: "nearest",
    };
  return null;
}

/** y = 1 when matched and within 10% of the label (10% exactly counts as correct). */
export function correctness(
  capacity: number,
  match: Match,
): { y: 0 | 1; absRelError: number | null } {
  if (!match) return { y: 0, absRelError: null };
  const diff = Math.abs(capacity - match.value);
  return {
    y: diff * 10 <= match.value ? 1 : 0,
    absRelError: diff / match.value,
  };
}

/**
 * One-to-one matching for precision/recall: each label *figure* (a room's
 * seated, standing or buyout total) is used once. Extracted rooms are matched
 * in order of match quality (name matches first).
 */
export function matchOneToOne(
  extracted: ExtractedRoom[],
  labels: LabelRoom[],
  totalSeats: number | null,
): Array<{ room: ExtractedRoom; match: Match }> {
  const rank = (m: Match) => (m == null ? 2 : m.by === "name" ? 0 : 1);
  const order = [...extracted].sort(
    (a, b) =>
      rank(matchRoom(a, labels, totalSeats)) -
      rank(matchRoom(b, labels, totalSeats)),
  );
  const used = new Set<string>();
  const key = (label: LabelRoom, field: Figure) =>
    `${labels.indexOf(label)}:${field}`;
  const result = new Map<ExtractedRoom, Match>();
  for (const room of order) {
    const match = matchRoom(room, labels, totalSeats, (label, field) =>
      used.has(key(label, field)),
    );
    if (match) used.add(key(match.label, match.field));
    result.set(room, match);
  }
  return extracted.map((room) => ({ room, match: result.get(room) ?? null }));
}

/** Every stated figure of a label room as its own (style, value) row. */
export function labelFigures(
  label: LabelRoom,
): Array<{ style: "seated" | "standing"; value: number }> {
  const out: Array<{ style: "seated" | "standing"; value: number }> = [];
  if (label.seatedMax) out.push({ style: "seated", value: label.seatedMax });
  if (label.standingMax)
    out.push({ style: "standing", value: label.standingMax });
  return out;
}
