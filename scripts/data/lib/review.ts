/**
 * Review ingest and teacher quality (Step 7): reviewer CSVs → per-venue
 * reviews → gold labels, conflicts between double reviewers, and the
 * teacher-quality numbers behind the gate.
 */
import { cohenKappa } from "../../../eval/metrics";
import {
  correctness,
  labelFigures,
  matchOneToOne,
  namesMatch,
  type ExtractedRoom,
  type LabelRoom,
} from "./matching";
import { canonicalRoomName } from "../../../src/lib/discovery/room-normalize";

export type Hosts = "yes" | "no" | "unknown";

export type VenueReview = {
  venueId: string;
  reviewer: string;
  status: "labeled" | "unclear";
  unclearReason: string;
  hosts: Hosts;
  rooms: LabelRoom[];
  /** Teacher rooms the reviewer judged correct / fixed, for the report. */
  decisions: Array<{ roomName: string; decision: string; exists: boolean }>;
  minutes: number;
  done: boolean;
};

const int = (s: string | undefined) => {
  const n = s == null || s.trim() === "" ? NaN : Math.round(Number(s));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Groups the tool's CSV rows (one per room) back into one review per venue. */
export function parseReviewRows(
  rows: Array<Record<string, string>>,
): VenueReview[] {
  const byKey = new Map<string, VenueReview>();
  for (const r of rows) {
    const key = `${r.venue_id}|${r.reviewer}`;
    let review = byKey.get(key);
    if (!review) {
      review = {
        venueId: r.venue_id,
        reviewer: r.reviewer,
        status: r.venue_status === "unclear" ? "unclear" : "labeled",
        unclearReason: r.unclear_reason ?? "",
        hosts: (["yes", "no", "unknown"].includes(r.hosts_private_events)
          ? r.hosts_private_events
          : "unknown") as Hosts,
        rooms: [],
        decisions: [],
        minutes: Number(r.minutes_spent) || 0,
        done: r.done === "1",
      };
      byKey.set(key, review);
    }
    if (!r.room_name?.trim()) continue;
    const exists = (r.room_exists ?? "yes") !== "no";
    review.decisions.push({
      roomName: r.room_name,
      decision: r.teacher_room_correct ?? "",
      exists,
    });
    const room = {
      roomName: canonicalRoomName(r.room_name),
      seatedMax: int(r.seated_max),
      standingMax: int(r.standing_max),
      min: int(r.min),
    };
    if (exists && (room.seatedMax || room.standingMax)) review.rooms.push(room);
  }
  return Array.from(byKey.values());
}

export type Conflict = {
  venue_id: string;
  field: string;
  room_name: string;
  reviewer_a: string;
  value_a: string;
  reviewer_b: string;
  value_b: string;
  resolved_value: string;
};

const fmt = (v: number | null) => (v == null ? "" : String(v));
const close = (a: number | null, b: number | null) =>
  (a == null && b == null) ||
  (a != null && b != null && Math.abs(a - b) * 10 <= Math.max(a, b));

/**
 * Compares two reviews of one venue. Values that agree (rooms: same name,
 * figures within 10%) are taken from reviewer A; disagreements are conflicts.
 */
export function compareReviews(
  a: VenueReview,
  b: VenueReview,
): { agreed: Omit<VenueReview, "reviewer">; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  const base = {
    venue_id: a.venueId,
    reviewer_a: a.reviewer,
    reviewer_b: b.reviewer,
    resolved_value: "",
  };
  if (a.status !== b.status)
    conflicts.push({
      ...base,
      field: "venue_status",
      room_name: "",
      value_a: a.status,
      value_b: b.status,
    });
  if (a.hosts !== b.hosts)
    conflicts.push({
      ...base,
      field: "hosts_private_events",
      room_name: "",
      value_a: a.hosts,
      value_b: b.hosts,
    });

  const rooms: LabelRoom[] = [];
  const usedB = new Set<LabelRoom>();
  for (const ra of a.rooms) {
    const rb = b.rooms.find(
      (r) => !usedB.has(r) && namesMatch(ra.roomName, r.roomName),
    );
    if (!rb) {
      conflicts.push({
        ...base,
        field: "room_exists",
        room_name: ra.roomName,
        value_a: "yes",
        value_b: "no",
      });
      continue;
    }
    usedB.add(rb);
    for (const [field, va, vb] of [
      ["seated_max", ra.seatedMax, rb.seatedMax],
      ["standing_max", ra.standingMax, rb.standingMax],
    ] as const) {
      if (!close(va, vb))
        conflicts.push({
          ...base,
          field,
          room_name: ra.roomName,
          value_a: fmt(va),
          value_b: fmt(vb),
        });
    }
    rooms.push(ra);
  }
  for (const rb of b.rooms) {
    if (!usedB.has(rb))
      conflicts.push({
        ...base,
        field: "room_exists",
        room_name: rb.roomName,
        value_a: "no",
        value_b: "yes",
      });
  }
  const { reviewer: _ignored, ...rest } = a;
  void _ignored;
  return { agreed: { ...rest, rooms }, conflicts };
}

const conflictKey = (c: Pick<Conflict, "venue_id" | "field" | "room_name">) =>
  `${c.venue_id}|${c.field}|${c.room_name}`;

/** Applies filled-in `resolved_value`s; returns the gold review and any still-unresolved conflicts. */
export function resolve(
  a: VenueReview,
  b: VenueReview,
  resolved: Map<string, string>,
): {
  gold: Omit<VenueReview, "reviewer">;
  unresolved: Conflict[];
  all: Conflict[];
} {
  const { agreed, conflicts } = compareReviews(a, b);
  const all = conflicts.map((c) => ({
    ...c,
    resolved_value: resolved.get(conflictKey(c)) ?? "",
  }));
  const unresolved = all.filter((c) => c.resolved_value.trim() === "");
  const gold = { ...agreed, rooms: [...agreed.rooms] };
  for (const c of all) {
    const v = c.resolved_value.trim();
    if (!v) continue;
    if (c.field === "venue_status")
      gold.status = v === "unclear" ? "unclear" : "labeled";
    if (c.field === "hosts_private_events")
      gold.hosts = (
        ["yes", "no", "unknown"].includes(v) ? v : "unknown"
      ) as Hosts;
    if (c.field === "room_exists" && v === "yes") {
      const source = [...a.rooms, ...b.rooms].find(
        (r) => r.roomName === c.room_name,
      );
      if (
        source &&
        !gold.rooms.some((r) => namesMatch(r.roomName, source.roomName))
      )
        gold.rooms.push({ ...source });
    }
    if (c.field === "seated_max" || c.field === "standing_max") {
      const room = gold.rooms.find((r) => r.roomName === c.room_name);
      if (room)
        room[c.field === "seated_max" ? "seatedMax" : "standingMax"] = int(v);
    }
  }
  return { gold, unresolved, all };
}

export { conflictKey };

export type TeacherRoom = {
  room_name: string;
  seated_max: number | null;
  standing_max: number | null;
  min: number | null;
};

/** A label's rooms as one (style, value) extraction per stated figure, for one-to-one scoring. */
export function figuresAsExtractions(rooms: TeacherRoom[]): ExtractedRoom[] {
  return rooms.flatMap((r, i) =>
    labelFigures({
      roomName: r.room_name,
      seatedMax: r.seated_max,
      standingMax: r.standing_max,
      min: r.min,
    }).map((f) => ({
      roomKey: `${i}@${f.style}`,
      roomName: canonicalRoomName(r.room_name),
      style: f.style,
      capacity: f.value,
    })),
  );
}

/** Room-level precision and recall of `predicted` rooms against gold rooms (figures within ±10%). */
export function roomPrecisionRecall(
  pairs: Array<{
    predicted: TeacherRoom[];
    gold: LabelRoom[];
    totalSeats: number | null;
  }>,
): {
  precision: number;
  recall: number;
  predicted: number;
  gold: number;
  correct: number;
  examples: Record<string, string[]>;
} {
  let predicted = 0;
  let correct = 0;
  let goldFigures = 0;
  let found = 0;
  const examples: Record<string, string[]> = {
    invented_or_unmatched: [],
    wrong_capacity: [],
    missed: [],
  };
  for (const p of pairs) {
    const ex = figuresAsExtractions(p.predicted);
    const matched = matchOneToOne(ex, p.gold, p.totalSeats);
    predicted += ex.length;
    for (const { room, match } of matched) {
      const { y } = correctness(room.capacity, match);
      correct += y;
      if (!match)
        examples.invented_or_unmatched.push(
          `${room.roomName} (${room.style} ${room.capacity})`,
        );
      else if (!y)
        examples.wrong_capacity.push(
          `${room.roomName}: ${room.capacity} vs gold ${match.value}`,
        );
    }
    const goldEx = figuresAsExtractions(
      p.gold.map((g) => ({
        room_name: g.roomName,
        seated_max: g.seatedMax,
        standing_max: g.standingMax,
        min: g.min,
      })),
    );
    goldFigures += goldEx.length;
    const back = matchOneToOne(
      goldEx,
      p.predicted.map((r) => ({
        roomName: r.room_name,
        seatedMax: r.seated_max,
        standingMax: r.standing_max,
        min: r.min,
      })),
      p.totalSeats,
    );
    for (const { room, match } of back) {
      if (correctness(room.capacity, match).y) found++;
      else
        examples.missed.push(
          `${room.roomName} (${room.style} ${room.capacity})`,
        );
    }
  }
  return {
    precision: predicted ? correct / predicted : 1,
    recall: goldFigures ? found / goldFigures : 1,
    predicted,
    gold: goldFigures,
    correct,
    examples,
  };
}

export function kappa(a: Hosts[], b: Hosts[]) {
  return cohenKappa(a, b);
}
