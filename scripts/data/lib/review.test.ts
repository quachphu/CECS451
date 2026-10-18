import { describe, expect, it } from "vitest";
import {
  compareReviews,
  parseReviewRows,
  resolve,
  roomPrecisionRecall,
  type VenueReview,
} from "./review";

const row = (over: Record<string, string>) => ({
  venue_id: "sf-0001",
  reviewer: "Han",
  venue_status: "labeled",
  unclear_reason: "",
  hosts_private_events: "yes",
  room_name: "",
  seated_max: "",
  standing_max: "",
  min: "",
  teacher_room_correct: "",
  room_exists: "yes",
  notes: "",
  minutes_spent: "2.5",
  done: "1",
  ...over,
});

describe("parseReviewRows", () => {
  it("groups room rows into one review and drops rows marked not a real room", () => {
    const [r] = parseReviewRows([
      row({
        room_name: "Garden Room",
        seated_max: "40",
        standing_max: "60",
        teacher_room_correct: "yes",
      }),
      row({
        room_name: "Dining room",
        seated_max: "180",
        teacher_room_correct: "no",
        room_exists: "no",
      }),
      row({
        room_name: "Library",
        seated_max: "20",
        teacher_room_correct: "added",
      }),
    ]);
    expect(
      r.rooms.map((x) => [x.roomName, x.seatedMax, x.standingMax]),
    ).toEqual([
      ["Garden Room", 40, 60],
      ["Library", 20, null],
    ]);
    expect(r.decisions).toHaveLength(3);
    expect(r.done).toBe(true);
  });

  it("keeps a venue with no rooms", () => {
    const [r] = parseReviewRows([row({ hosts_private_events: "no" })]);
    expect(r.rooms).toEqual([]);
    expect(r.hosts).toBe("no");
  });
});

const review = (
  reviewer: string,
  over: Partial<VenueReview> = {},
): VenueReview => ({
  venueId: "sf-0001",
  reviewer,
  status: "labeled",
  unclearReason: "",
  hosts: "yes",
  rooms: [
    { roomName: "Garden Room", seatedMax: 40, standingMax: null, min: null },
  ],
  decisions: [],
  minutes: 1,
  done: true,
  ...over,
});

describe("compareReviews / resolve", () => {
  it("finds no conflict when figures agree within 10%", () => {
    const b = review("Albert", {
      rooms: [
        {
          roomName: "The Garden Room",
          seatedMax: 42,
          standingMax: null,
          min: null,
        },
      ],
    });
    expect(compareReviews(review("Han"), b).conflicts).toEqual([]);
  });

  it("reports differing hosts, capacities and rooms", () => {
    const b = review("Albert", {
      hosts: "unknown",
      rooms: [
        {
          roomName: "Garden Room",
          seatedMax: 60,
          standingMax: null,
          min: null,
        },
        { roomName: "Patio", seatedMax: 30, standingMax: null, min: null },
      ],
    });
    const fields = compareReviews(review("Han"), b).conflicts.map(
      (c) => `${c.field}:${c.room_name}`,
    );
    expect(fields).toEqual([
      "hosts_private_events:",
      "seated_max:Garden Room",
      "room_exists:Patio",
    ]);
  });

  it("applies resolved values and reports what is still open", () => {
    const b = review("Albert", {
      rooms: [
        {
          roomName: "Garden Room",
          seatedMax: 60,
          standingMax: null,
          min: null,
        },
      ],
    });
    const open = resolve(review("Han"), b, new Map());
    expect(open.unresolved).toHaveLength(1);
    const done = resolve(
      review("Han"),
      b,
      new Map([["sf-0001|seated_max|Garden Room", "60"]]),
    );
    expect(done.unresolved).toEqual([]);
    expect(done.gold.rooms[0].seatedMax).toBe(60);
  });
});

describe("roomPrecisionRecall", () => {
  it("scores each stated figure, one-to-one, within ±10%", () => {
    const r = roomPrecisionRecall([
      {
        predicted: [
          {
            room_name: "Garden Room",
            seated_max: 40,
            standing_max: 70,
            min: null,
          }, // seated right, standing wrong
          {
            room_name: "Rooftop",
            seated_max: 200,
            standing_max: null,
            min: null,
          }, // invented
        ],
        gold: [
          {
            roomName: "Garden Room",
            seatedMax: 40,
            standingMax: 60,
            min: null,
          },
          { roomName: "Library", seatedMax: 12, standingMax: null, min: null }, // missed
        ],
        totalSeats: null,
      },
    ]);
    expect(r.predicted).toBe(3);
    expect(r.correct).toBe(1);
    expect(r.precision).toBeCloseTo(1 / 3);
    expect(r.recall).toBeCloseTo(1 / 3);
    expect(r.examples.invented_or_unmatched).toEqual(["Rooftop (seated 200)"]);
  });
});
