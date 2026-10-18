/**
 * Dry run, part 1: a synthetic world of venues with known true room sizes.
 *
 *   npx tsx scripts/data/dryrun/world.ts <out-dir>
 *
 * Writes <out-dir>/world.json (venues, their websites as HTML, Google records)
 * and <out-dir>/fsq.parquet (the Foursquare columns 01_sample_venues.ts reads).
 * Nothing here touches the network. The world is deterministic (seed 451).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Bucket } from "../../../src/lib/discovery/category-buckets";
import { seededRandom } from "../lib/io";
import { CITY_BOXES, type CityCode } from "../lib/sampling";

export type TruthRoom = { name: string; seated: number | null; standing: number | null; min: number | null };

export type SiteKind =
  | "pd_page"
  | "pd_homepage"
  | "pd_pdf_only"
  | "no_events"
  | "events_no_numbers"
  | "multi_location"
  | "js_only"
  | "bot_challenge"
  | "robots_blocked"
  | "http_error"
  | "parked"
  | "non_english";

export type WorldVenue = {
  fsq_place_id: string;
  name: string;
  city: CityCode;
  bucket: Bucket;
  fsq_label: string;
  lat: number;
  lng: number;
  address: string;
  host: string;
  website: string;
  site: SiteKind;
  hosts: "yes" | "no";
  rooms: TruthRoom[];
  total_seats: number | null;
  event_link: boolean;
  /** Paths → HTML (static) and paths → markdown (what a renderer returns). */
  pages: Record<string, string>;
  rendered: Record<string, string>;
  robots: string;
  google: null | {
    id: string;
    name: string;
    primaryType: string;
    types: string[];
    priceLevel: string | null;
    rating: number | null;
    userRatingCount: number | null;
    lat: number;
    lng: number;
    websiteUri: string | null;
  };
};

const FSQ_LABELS: Record<Bucket, string[]> = {
  fine_dining: ["Dining and Drinking > Restaurant > Fine Dining Restaurant"],
  casual_restaurant: [
    "Dining and Drinking > Restaurant > Italian Restaurant",
    "Dining and Drinking > Restaurant > American Restaurant",
    "Dining and Drinking > Restaurant > Mexican Restaurant",
  ],
  steakhouse_grill: ["Dining and Drinking > Restaurant > Steakhouse"],
  bar_lounge: ["Dining and Drinking > Bar > Cocktail Bar", "Dining and Drinking > Bar > Wine Bar"],
  hotel: ["Travel and Transportation > Lodging > Hotel"],
  event_space: ["Business and Professional Services > Event Space"],
  fast_casual_cafe: ["Dining and Drinking > Cafe, Coffee, and Tea House > Coffee Shop"],
};
const GOOGLE_TYPES: Record<Bucket, string[][]> = {
  fine_dining: [["fine_dining_restaurant", "restaurant"]],
  casual_restaurant: [["italian_restaurant", "restaurant"], ["american_restaurant", "restaurant"], ["restaurant"]],
  steakhouse_grill: [["steak_house", "restaurant"]],
  bar_lounge: [["cocktail_bar", "bar"], ["wine_bar", "bar"]],
  hotel: [["hotel", "lodging"]],
  event_space: [["event_venue"], ["banquet_hall"]],
  fast_casual_cafe: [["cafe"], ["coffee_shop", "cafe"]],
};
const BUCKET_WEIGHTS: Array<[Bucket, number]> = [
  ["casual_restaurant", 0.3],
  ["fine_dining", 0.12],
  ["steakhouse_grill", 0.1],
  ["bar_lounge", 0.16],
  ["hotel", 0.1],
  ["event_space", 0.08],
  ["fast_casual_cafe", 0.14],
];
const HOSTS_RATE: Record<Bucket, number> = {
  event_space: 0.95,
  hotel: 0.85,
  fine_dining: 0.8,
  steakhouse_grill: 0.75,
  bar_lounge: 0.5,
  casual_restaurant: 0.45,
  fast_casual_cafe: 0.12,
};
const ROOM_RANGE: Record<Bucket, [number, number]> = {
  event_space: [60, 300],
  hotel: [30, 250],
  fine_dining: [10, 60],
  steakhouse_grill: [14, 90],
  bar_lounge: [20, 140],
  casual_restaurant: [10, 50],
  fast_casual_cafe: [8, 24],
};
const NAME_WORDS = {
  fine_dining: ["Maison", "Aurelia", "Lumiere", "Ostra", "Verbena", "Sable"],
  casual_restaurant: ["Trattoria", "Kitchen", "Table", "Osteria", "Cantina", "Bistro", "Pizza"],
  steakhouse_grill: ["Steakhouse", "Grill", "Chophouse", "Tavern"],
  bar_lounge: ["Lounge", "Bar", "Club", "Tavern", "Social"],
  hotel: ["Hotel", "Inn", "Suites"],
  event_space: ["Hall", "Loft", "Studios", "Pavilion"],
  fast_casual_cafe: ["Cafe", "Coffee", "Express", "Bakery"],
};
const PREFIXES = ["Harbor", "Juniper", "Marlowe", "Cedar", "Copper", "Linden", "Ember", "Willow", "Saffron", "Ivy", "Atlas", "Beacon", "Corsair", "Delmar", "Fable", "Garnet", "Hollis", "Indigo", "Kestrel", "Lantern"];
const ROOM_NAMES = ["Garden Room", "Library", "Wine Cellar", "Chef's Table", "Mezzanine", "Terrace", "Gallery", "Salon", "Loft", "Vault", "Conservatory", "Parlor"];
const FILLER =
  "Our menu changes with the seasons and is built on produce from small farms nearby. The kitchen is open late on weekends, and the bar pours a rotating list of wines by the glass. Reservations are recommended for dinner, and walk-ins are welcome at the bar. We are a short walk from the main transit station and offer validated parking in the garage next door. Gift cards are available at the host stand and online. Follow us for news about seasonal menus, wine dinners and holiday hours. ";

const ROWS_PER_CITY: Record<CityCode, number> = { nyc: 250, sf: 250, hnl: 180, la: 290 };

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)];
}
function weighted<T>(rand: () => number, xs: Array<[T, number]>): T {
  let r = rand() * xs.reduce((s, [, w]) => s + w, 0);
  for (const [x, w] of xs) if ((r -= w) <= 0) return x;
  return xs[xs.length - 1][0];
}
const rint = (rand: () => number, lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));
const round5 = (n: number) => Math.max(6, Math.round(n / 5) * 5);

function html(title: string, body: string, links: Array<[string, string]>): string {
  const nav = links.map(([href, text]) => `<a href="${href}">${text}</a>`).join(" | ");
  return `<!doctype html><html lang="en"><head><title>${title}</title></head><body><nav>${nav}</nav><main>${body}</main></body></html>`;
}

/** The sentence forms the mock models read back (see shim.ts and mock_anthropic.py). */
export function roomSentences(rooms: TruthRoom[], rand: () => number): string[] {
  return rooms.map((r) => {
    if (r.name === "Full buyout") return `For a full buyout, the entire restaurant welcomes up to ${r.seated ?? r.standing} guests.`;
    if (r.min != null && r.seated != null) return `The ${r.name} is ideal for groups of ${r.min} to ${r.seated} guests.`;
    if (r.seated != null && r.standing != null)
      return `The ${r.name} seats ${r.seated} guests for a seated dinner and up to ${r.standing} for a standing reception.`;
    if (r.standing != null) return `The ${r.name} holds ${r.standing} people standing.`;
    return rand() < 0.5 ? `Our ${r.name} accommodates up to ${r.seated} guests.` : `The ${r.name} seats ${r.seated} guests.`;
  });
}

function distractors(rand: () => number, total: number | null): string[] {
  const out = [];
  if (rand() < 0.6) out.push(`Tables for 2 to ${rint(rand, 4, 6)} people are available nightly.`);
  if (rand() < 0.5) out.push(`Parties of ${rint(rand, 6, 10)} or more incur an 20% service charge.`);
  if (rand() < 0.35) out.push(`Since ${rint(rand, 1985, 2015)} we have welcomed over ${rint(rand, 10, 90) * 100} guests.`);
  if (total != null) out.push(`Our main dining room seats ${total} guests.`);
  return out;
}

function buildRooms(rand: () => number, bucket: Bucket): { rooms: TruthRoom[]; total: number | null } {
  const [lo, hi] = ROOM_RANGE[bucket];
  const n = bucket === "fast_casual_cafe" ? 1 : weighted(rand, [[1, 0.45], [2, 0.35], [3, 0.2]]);
  const names = [...ROOM_NAMES].sort(() => rand() - 0.5).slice(0, n);
  const rooms: TruthRoom[] = names.map((name) => {
    const seated = round5(lo + rand() * (hi - lo));
    const form = rand();
    if (form < 0.35) return { name, seated, standing: round5(seated * (1.3 + rand() * 0.5)), min: null };
    if (form < 0.45) return { name, seated: null, standing: round5(seated * 1.4), min: null };
    if (form < 0.55) return { name, seated, standing: null, min: Math.max(6, round5(seated * 0.4)) };
    return { name, seated, standing: null, min: null };
  });
  if (n >= 2 && rand() < 0.25 && rooms[0].seated && rooms[1].seated)
    rooms.push({ name: `${rooms[0].name}+${rooms[1].name}`, seated: rooms[0].seated + rooms[1].seated, standing: null, min: null });
  const total = bucket !== "event_space" && rand() < 0.5 ? round5(hi * (1.5 + rand() * 2)) : null;
  if (total && bucket !== "hotel" && rand() < 0.2) rooms.push({ name: "Full buyout", seated: total, standing: null, min: null });
  return { rooms, total };
}

function combinedSentence(rooms: TruthRoom[]): string[] {
  return rooms
    .filter((r) => r.name.includes("+"))
    .map((r) => {
      const [a, b] = r.name.split("+");
      return `The ${a} and ${b} combine to seat ${r.seated} guests.`;
    });
}

function makeSite(v: WorldVenue, rand: () => number): void {
  const name = v.name;
  const sentences = [...roomSentences(v.rooms.filter((r) => !r.name.includes("+")), rand), ...combinedSentence(v.rooms)];
  const noise = distractors(rand, v.total_seats);
  const shuffle = (xs: string[]) => [...xs].sort(() => rand() - 0.5);
  const eventLink = v.event_link ? [[`https://www.tripleseat.com/party-request/${v.host.split(".")[1]}`, "Request an event"] as [string, string]] : [];
  const pdLinks: Array<[string, string]> = [["/menu", "Menu"], ["/private-dining", "Private Dining"], ...eventLink];
  const intro = `<h1>${name}</h1><p>Welcome to ${name}. ${FILLER}</p>`;
  v.robots = "User-agent: *\nAllow: /\n";

  switch (v.site) {
    case "pd_page":
    case "js_only":
    case "bot_challenge": {
      const pd = `<h1>Private Dining at ${name}</h1><p>Host your next celebration, rehearsal dinner or business meeting with us. ${shuffle([...sentences, ...noise]).join(" ")} Our events team will help plan a menu for your group.</p><p>${FILLER}</p>`;
      v.pages["/"] = html(name, intro + `<p>${noise.slice(0, 1).join(" ")}</p>`, pdLinks);
      v.pages["/private-dining"] = html(`Private Dining | ${name}`, pd, [["/", "Home"]]);
      if (v.site === "js_only") {
        v.rendered["/"] = `# ${name}\n\nWelcome to ${name}. ${FILLER}\n\n[Private Dining](/private-dining) [Menu](/menu)${eventLink.map(([h, t]) => ` [${t}](${h})`).join("")}`;
        v.pages["/"] = html(name, `<div id="root"></div><script>/* app */</script>`, []);
        v.rendered["/private-dining"] = `# Private Dining at ${name}\n\nHost your next celebration with us. ${shuffle([...sentences, ...noise]).join(" ")}\n\n${FILLER}`;
        v.pages["/private-dining"] = html("Private Dining", `<div id="root"></div>`, []);
      }
      if (v.site === "bot_challenge") {
        v.rendered["/"] = `# ${name}\n\nWelcome to ${name}. ${FILLER}\n\n[Private Dining](/private-dining) [Menu](/menu)`;
        v.rendered["/private-dining"] = `# Private Dining at ${name}\n\n${shuffle([...sentences, ...noise]).join(" ")}\n\n${FILLER}`;
      }
      return;
    }
    case "pd_homepage":
      v.pages["/"] = html(name, intro + `<h2>Private Events</h2><p>We host private events and group dinners. ${shuffle([...sentences, ...noise]).join(" ")}</p>`, [["/menu", "Menu"], ...eventLink]);
      return;
    case "pd_pdf_only":
      v.pages["/"] = html(name, intro, pdLinks);
      v.pages["/private-dining"] = html(
        `Private Events | ${name}`,
        `<h1>Private Events</h1><p>We host private events and celebrations of every size. Download our events packet for room details and menus. <a href="/files/private-events-packet.pdf">Private events packet (PDF)</a></p><p>${FILLER}</p>`,
        [["/files/private-events-packet.pdf", "Private events packet"]]
      );
      v.rendered["/files/private-events-packet.pdf"] = `Private Events Packet\n\n${sentences.join("\n")}`;
      return;
    case "events_no_numbers":
      v.pages["/"] = html(name, intro, pdLinks);
      v.pages["/private-dining"] = html(
        `Private Events | ${name}`,
        `<h1>Private Events</h1><p>From intimate dinners to large celebrations, our team hosts private events of all kinds. Contact our events team to plan yours. ${noise.join(" ")}</p><p>${FILLER}</p>`,
        []
      );
      return;
    case "no_events":
      v.pages["/"] = html(name, intro + `<p>${noise.filter((s) => !s.startsWith("Our main")).join(" ")} We do not take group bookings; come by any time.</p>`, [["/menu", "Menu"]]);
      return;
    case "multi_location": {
      v.pages["/"] = html(name, intro + `<p>Locations: Downtown, Uptown and Westside.</p>`, pdLinks);
      v.pages["/private-dining"] = html(
        `Private Dining | ${name}`,
        `<h1>Private Dining at our locations</h1><p>Each of our three locations hosts private events. ${sentences.join(" ")} Room availability differs by location; ask the events team which rooms your location offers.</p><p>${FILLER}</p>`,
        []
      );
      return;
    }
    case "non_english":
      v.pages["/"] = html(
        name,
        `<h1>${name}</h1><p>Bienvenidos a ${name}. Nuestra cocina cambia con las estaciones y trabaja con productores locales. La terraza es perfecta para cenas largas con amigos y familia. Reservas recomendadas para la cena del fin de semana. Ofrecemos eventos privados para grupos y celebraciones; el salon principal tiene capacidad para ${v.rooms[0]?.seated ?? 40} personas sentadas. Nuestro equipo de eventos le ayudara a planear el menu. Estamos cerca de la estacion principal y ofrecemos estacionamiento validado. Siguenos para noticias de temporada y horarios de fiestas. Tarjetas de regalo disponibles en el restaurante y en linea.</p>`,
        [["/menu", "Menu"]]
      );
      return;
    case "robots_blocked":
      v.robots = "User-agent: *\nDisallow: /\n";
      v.pages["/"] = html(name, intro, pdLinks);
      return;
    case "http_error":
    case "parked":
      v.pages["/"] =
        v.site === "parked"
          ? html("Domain parked", `<h1>This domain is for sale</h1><p>Buy this domain today. ${FILLER}</p>`, [])
          : "";
      return;
  }
}

export function buildWorld(): WorldVenue[] {
  const rand = seededRandom(451);
  const venues: WorldVenue[] = [];
  let n = 0;
  for (const [city, count] of Object.entries(ROWS_PER_CITY) as Array<[CityCode, number]>) {
    for (let i = 0; i < count; i++) {
      n++;
      const bucket = weighted(rand, BUCKET_WEIGHTS);
      const box = pick(rand, CITY_BOXES[city]);
      const lat = box.s + rand() * (box.n - box.s);
      const lng = box.w + rand() * (box.e - box.w);
      const word = pick(rand, NAME_WORDS[bucket]);
      const name = `${pick(rand, PREFIXES)} ${word} ${n}`;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const host = `www.${slug}.test`;
      const priceBias = { fine_dining: 3.4, steakhouse_grill: 3, hotel: 3, event_space: 2.6, bar_lounge: 2.2, casual_restaurant: 2, fast_casual_cafe: 1.2 }[bucket];
      const price = Math.max(1, Math.min(4, Math.round(priceBias + (rand() - 0.5) * 1.6)));
      const hostsP = Math.min(0.98, HOSTS_RATE[bucket] + (price - 2) * 0.06);
      const hosts = rand() < hostsP ? "yes" : "no";
      const { rooms, total } = hosts === "yes" ? buildRooms(rand, bucket) : { rooms: [], total: rand() < 0.4 ? rint(rand, 40, 120) : null };
      const site: SiteKind =
        hosts === "no"
          ? weighted(rand, [["no_events", 0.86], ["robots_blocked", 0.04], ["http_error", 0.04], ["parked", 0.03], ["js_only", 0.0], ["non_english", 0.03]])
          : weighted(rand, [
              ["pd_page", 0.5],
              ["pd_homepage", 0.14],
              ["js_only", 0.09],
              ["bot_challenge", 0.02],
              ["pd_pdf_only", 0.05],
              ["events_no_numbers", 0.07],
              ["multi_location", 0.05],
              ["robots_blocked", 0.03],
              ["http_error", 0.02],
              ["parked", 0.02],
              ["non_english", 0.01],
            ]);
      const v: WorldVenue = {
        fsq_place_id: `dry${String(n).padStart(5, "0")}`,
        name,
        city,
        bucket,
        fsq_label: pick(rand, FSQ_LABELS[bucket]),
        lat,
        lng,
        address: `${rint(rand, 1, 999)} ${pick(rand, ["Main", "Market", "Ocean", "Park", "Hill", "King"])} St`,
        host,
        website: `https://${host}/`,
        site,
        hosts,
        rooms: site === "non_english" ? rooms.slice(0, 1) : rooms,
        total_seats: total,
        event_link: hosts === "yes" && site !== "non_english" && rand() < 0.15,
        pages: {},
        rendered: {},
        robots: "",
        google: null,
      };
      if (v.site === "pd_page" && v.event_link === false && rand() < 0.03) v.website = `https://${host}/?utm_source=fsq`;
      makeSite(v, rand);
      const g = rand();
      if (g > 0.08) {
        const types = pick(rand, GOOGLE_TYPES[bucket]);
        const far = g < 0.12; // a different place came back first: rejected by the match rule
        v.google = {
          id: `ChIJdry${n}`,
          name: far ? `${pick(rand, PREFIXES)} Dental ${n}` : name,
          primaryType: types[0],
          types,
          priceLevel: rand() < 0.75 ? ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"][price] : null,
          rating: rand() < 0.95 ? Math.round((3.4 + rand() * 1.5) * 10) / 10 : null,
          userRatingCount: rand() < 0.95 ? Math.round(Math.exp(3 + rand() * 4 + (hosts === "yes" ? 0.5 : 0))) : null,
          lat: lat + (rand() - 0.5) * (far ? 0.02 : 0.0004),
          lng: lng + (rand() - 0.5) * (far ? 0.02 : 0.0004),
          websiteUri: rand() < 0.85 ? v.website : null,
        };
      }
      venues.push(v);
    }
  }
  // Two venues listing a social page, one invalid URL and one chain sharing a domain (01 drops them).
  venues[3].website = "https://instagram.com/dryvenue";
  venues[9].website = "not a url";
  venues[15].website = `https://${venues[16].host}/second-location`;
  return venues;
}

async function writeParquet(venues: WorldVenue[], out: string): Promise<void> {
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  await conn.run(
    "CREATE TABLE p (fsq_place_id VARCHAR, name VARCHAR, latitude DOUBLE, longitude DOUBLE, address VARCHAR, locality VARCHAR, region VARCHAR, postcode VARCHAR, country VARCHAR, date_closed DATE, website VARCHAR, fsq_category_labels VARCHAR[])"
  );
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const rows = venues.map(
    (v, i) =>
      `(${q(v.fsq_place_id)}, ${q(v.name)}, ${v.lat}, ${v.lng}, ${q(v.address)}, ${q(v.city)}, 'XX', '00000', 'US', ${i % 97 === 5 ? "DATE '2024-01-01'" : "NULL"}, ${q(v.website)}, [${q(v.fsq_label)}])`
  );
  await conn.run(`INSERT INTO p VALUES ${rows.join(",")}`);
  await conn.run(`COPY p TO ${q(out)} (FORMAT parquet)`);
}

async function main() {
  const dir = resolve(process.argv[2] ?? "dryrun-world");
  mkdirSync(dir, { recursive: true });
  const venues = buildWorld();
  writeFileSync(join(dir, "world.json"), JSON.stringify(venues));
  await writeParquet(venues, join(dir, "fsq.parquet"));
  const by = (k: keyof WorldVenue) =>
    venues.reduce<Record<string, number>>((m, v) => ((m[String(v[k])] = (m[String(v[k])] ?? 0) + 1), m), {});
  console.log(JSON.stringify({ venues: venues.length, city: by("city"), bucket: by("bucket"), site: by("site"), hosts: by("hosts") }));
}

if (process.argv[1]?.endsWith("world.ts")) main();
