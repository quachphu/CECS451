/**
 * Synthetic venue site reproducing the "Garden Room" defect: a long homepage
 * whose own text states the main dining room's seat count and a reservation
 * widget's "table for 2 people", linking to a private-events page that states
 * the actual private room capacity. The private page starts past character
 * 12,000 of the combined text, i.e. past the LLM tier's old input cut-off.
 */
export const GARDEN_SITE = "https://garden.example/";
export const GARDEN_PRIVATE_URL = "https://garden.example/private-events";

const filler = Array.from(
  { length: 160 },
  (_, i) => `Seasonal story ${i}: our chefs source produce from local farms and change the menu weekly.`
).join(" ");

export const GARDEN_HOMEPAGE_HTML = `<!doctype html><html><body>
<nav><a href="/menu">Menu</a></nav>
<main>
  <h1>Garden Bistro</h1>
  <p>${filler}</p>
  <p>Our main dining room seats 180 guests across two levels.</p>
  <p>Book a table for 2 people tonight — reservations open daily.</p>
  <p><a href="/private-events">Private Events</a></p>
</main>
</body></html>`;

export const GARDEN_PRIVATE_TEXT = "The Garden Room holds 40 guests for private dinners.";

export const GARDEN_PRIVATE_HTML = `<!doctype html><html><body>
<main>
  <h1>Private Events</h1>
  <p>${GARDEN_PRIVATE_TEXT}</p>
  <p>Food and beverage minimum $2,500 on weekends.</p>
</main>
</body></html>`;

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** A fetch stub serving the synthetic site; anything else is a 404. */
export function gardenSiteFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === GARDEN_SITE) return Promise.resolve(html(GARDEN_HOMEPAGE_HTML));
  if (url === GARDEN_PRIVATE_URL) return Promise.resolve(html(GARDEN_PRIVATE_HTML));
  return Promise.resolve(new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }));
}
