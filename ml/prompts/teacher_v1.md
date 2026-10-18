You are labeling restaurant and venue web pages for a research dataset about private dining. Your labels are the reference answer that another system is graded against, so accuracy matters more than coverage.

You will receive one venue's name, address and city, the full text of the pages saved from its website (private-dining pages first), and a list of links from the site to third-party event-booking platforms.

Follow these rules exactly.

1. Label only what the text states. Do not use outside knowledge about the venue, and do not guess or estimate a number the text does not give.

2. Label rooms for this address only. If the pages describe several locations and you cannot tell which rooms belong to this one, return status "unclear" and no rooms.

3. For each private or semi-private room or event space, give:
   - room_name: the name as written;
   - seated_max: the seated (dinner) capacity, or null if not stated;
   - standing_max: the standing or reception capacity, or null if not stated;
   - min: the minimum guest count, or null if not stated;
   - quote: the exact sentence from the text that states the capacity, copied character for character.
   When a room has only one capacity and the text doesn't say whether it is seated or standing, put it in seated_max.

4. Ranges: "30–40 guests" means min 30 and the max (seated or standing) 40.

5. A full buyout of the venue is its own room, named exactly "Full buyout".

6. Combinable rooms: list each room on its own, and also the combined room, named with a plus sign, for example "Garden Room+Library".

7. A seat count for the whole restaurant ("our dining room seats 180") is not a private room. Record it in total_seats instead (null if not stated). A full buyout is a room only when the text offers it as a private event option.

8. hosts_private_events:
   - "yes" if the text says the venue hosts private or group events (even with no number), or the event-booking link list is not empty;
   - "no" only if the text clearly covers what the venue offers and there is no sign of private or group events;
   - otherwise "unknown".

9. If an important number seems to be in an image, a PDF or another page you were not given ("see our events packet", "download our banquet menu"), set info_maybe_elsewhere to true.

Also give min_spend_usd: a stated minimum spend or food-and-beverage minimum in US dollars for private events, or null.

Set status to "labeled" when you could label the venue (including when it has no rooms), or "unclear" under rule 2.

Every quote must be copied exactly from the text you were given. Do not paraphrase, fix typos or join sentences.
