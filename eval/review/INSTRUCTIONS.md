# Review instructions

You are checking the teacher's labels for a set of venues. Your corrected labels become the **gold set**: the reference that the teacher, the student and the trained models are graded against. Work from the **saved page text** shown in the tool. The live-site link is for orientation only, because the site may have changed since it was saved.

## Setup

1. Open `eval/review/index.html` in a browser by double-clicking it.
2. Choose your sheet, `eval/review/sheets/<your name>.json`.
3. Work through the venues. Your progress is kept in the browser, but export often.
4. When you're done, click **Export review CSV** and save the file as `eval/review/review_<your name>.csv`.

## Rules (the same ones the teacher followed)

1. **Label only what the text states.** Use no outside knowledge, and don't guess numbers.
2. **This address only.** If the text covers several locations and you can't tell which rooms belong to this one, set the venue status to **unclear** and say why.
3. **For each private or semi-private room or event space**, give:
   - its name;
   - its **seated** capacity;
   - its **standing / reception** capacity (leave it blank if not stated);
   - its **minimum** guest count.

   If a room has one figure and the text doesn't say seated or standing, enter it as **seated**.
4. **Ranges.** "30–40 guests" means minimum 30 and maximum 40.
5. **A full buyout** is its own room, named exactly `Full buyout`.
6. **Combinable rooms:** list each room, plus the combined room as `A+B`.
7. **A whole-restaurant seat count is not a room** ("our dining room seats 180"). Mark such a teacher row as *not a real room*.
8. **Hosts private events:**
   - **yes** if the text says the venue hosts private or group events, or there is an event-booking link;
   - **no** only if the text clearly covers the venue's offerings and shows no sign of events;
   - otherwise **unknown**.

## Marking each row

| Situation | What to do |
| --- | --- |
| The teacher's room and numbers are right | Check: **correct** |
| Right room, wrong number | Fix the number, then check: **fixed / wrong** |
| The teacher listed something that isn't a room | Check: **fixed / wrong**, and set **not a real room** |
| The teacher missed a room | **Add missing room** and fill it in |

## Worked examples

**Example 1: a clear private-dining page.**
> "The Garden Room seats 40 guests for dinner, or 60 for a standing reception. The Library hosts 12–20."

| Room | Seated | Standing | Min |
| --- | --- | --- | --- |
| Garden Room | 40 | 60 | — |
| Library | 20 | — | 12 |

Hosts private events: **yes**.

**Example 2: a buyout and a whole-restaurant count.**
> "Our dining room seats 180. For larger celebrations, book the entire restaurant for up to 220 guests."

There is one room, `Full buyout`, with seated 220. The 180 is the restaurant's normal seating, not a room: if the teacher listed it, mark that row *not a real room*. Hosts: **yes**.

**Example 3: events with no numbers.**
> "We love hosting parties! Contact events@example.com to plan yours."

There are no rooms, so leave the table empty. Hosts: **yes**. If the page says "download our events packet", there may be a PDF you weren't given; mention it in the notes.

Expect about 2–4 minutes per venue. If a venue is truly ambiguous, choose **unclear** and give the reason in a few words.
