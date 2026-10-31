Closes #9

Adds `get_dining_menu`: pass a dining hall, a date and a meal, get back every item with
per-serving calories, protein, carbs, fat, fiber and sodium, plus allergens and dietary tags.
That's enough for the LLM to put a meal together against a calorie or macro target without
another round trip. `diet` keeps only items with the given tags, `exclude` drops items with a
given allergen, and both error on a code they don't recognise rather than ignoring it (a
restriction that quietly does nothing is worse than no filter).

```
Dinner
  Comfort Table
    Halal Grilled Chicken (3) · 146 cal P 22.4 C 1.1 F 4.7 Na 310mg · Halal Friendly · #111301*3
    Baked Potato (1) · 249 cal P 5.7 C 48 F 4.7 fib 5 Na 23mg · Vegan · #161011*1
```

It also returns `structuredContent` with the same data, so totals don't need the text parsed.

I added four more tools off the same sources while I was in there: `dining_hours` (what's open
now, in Austin time, picking the shortest schedule covering the date so break and finals
schedules win over the semester one), `list_dining_locations`,
`search_menu_items` for finding a dish when you don't know the hall, and `menu_item_nutrition`
for one item's full label and ingredient list. Happy to pull those into a separate PR if you'd
rather keep this to the issue.

All public UT endpoints, no EID login, which matches the "UT SSO Required: No" on the issue.

### Nutrition doesn't come from the menu feed

Worth flagging because it's the non-obvious part. The feed has a `nutrients` array and using it
would have been free, but it isn't per serving. There's one array per recipe, and the same
recipe gets served at different portions at different halls. Crispy Chopped Bacon (081906)
reports 299 kcal with portionSize "3 oz" and is served at serv=3, but the label for `081906*3`
says 897. Chicken and Rice Soup goes the other way, overstating by 4x at Kins. I checked a
couple of full menus against the labels and roughly one item in ten was off, between 0.25x and
4x. `portionSize` doesn't tell you which is which.

So nutrition is read per item from `label.aspx`, which is the page a student can open and check.
That costs a request per recipe+serving, so it reads at most 40 labels per call. Filters run
before the budget is spent, so narrowing by meal or station gets you full coverage, and if the
cap is hit the response says how many items it covered instead of just leaving the rest blank.
Labels are cached for a day, so an unfiltered dinner is about 9s cold and 9ms warm.

Sizing that budget took two attempts. Cache reads and writes count against the same 50
subrequests as `fetch` on the free plan, which I had missed, so caching each label on its own
cost three subrequests apiece: an unfiltered menu measured 123 cold, and 41 even when every
label was already cached. The labels for one call now share a single cache entry, which puts a
cold call at 45 and a warm one at 2. There is a test asserting both stay under the limit, since
the number is easy to regress without noticing.

### Caching

Everything upstream goes through a small cache: in-memory per isolate, then the Cloudflare Cache
API, then UT. Concurrent misses for the same key wait on one request instead of each making
their own. Failed calls are remembered for 30s so an outage doesn't turn into one UT request per
visitor. The in-memory map is capped at 256 entries since the keys include recipe numbers.

Parsers throw a named error instead of returning half-parsed data, and a UT SSO login page is
detected rather than parsed as content.

### Changes outside src/

Four, all small:

- `vite.config.ts`: a `test` block, since nothing in the repo had tests yet, and
  `**/test/fixtures/**` added to `fmt.ignorePatterns`. The fixtures are saved UT responses;
  formatting them rewrites the JSON and then the parsers are reading different bytes than UT
  actually sends.
- `apps/mcp-server/tsconfig.json`: `noUncheckedIndexedAccess` on for this app, and `test/`
  included in type checking.
- `apps/mcp-server/package.json`: a `test` script. No new dependencies; tests use `vp test` and
  import from `vite-plus/test`.
- `src/index.ts`: `localhost` and `127.0.0.1` added to `allowedHostnames`. Setting that option
  turns off the library's localhost default, so `wrangler dev` currently gets rejected with only
  the production hostname listed.

### One thing worth a careful look

Allergen tags on the menu feed are incomplete. `450257` Breaded Plant-based Tender is tagged
vegan with wheat and soy, but its label's CONTAINS line also says tree nuts, so filtering on tags
alone would have served it to someone avoiding nuts. Since the label is already fetched for
nutrition, its allergen line is used for both display and the `exclude` filter, and the response
says when an item was dropped that way.

The part that took a second pass: the label only gets read for the first 40 refs, so items past
the budget had nothing behind them but the tags — and 35 of this week's 997 recipes carry no tags
at all. Chocolate Pistacio Cloud Cake is untagged, sits at ref 92 of 94 on JCL dinner, and its
label reads "Milk, Eggs, Tree Nuts, Peanuts, Wheat, Soybeans, Sesame". Excluding PNTS returned it
with an empty allergen list. So `exclude` now withholds anything it couldn't verify rather than
presenting it as safe, and says how many and how to see them. Same guard covers a label outage,
where otherwise nothing would be checked at all.

`allergenSource` says whether the label was read, not whether it named anything — an empty list
from an unread label is unknown, not allergen-free. That list is `null` rather than `[]` when the
label went unread, because `[]` reads as a positive claim that the item is allergen-free.
`search_menu_items` never reads a label at all, so its allergens are `null` whenever the menu tags
name none.

### Making the model's copy and the student's copy say the same thing

Four tools now declare an `outputSchema` and return `structuredContent`, and the descriptions tell
the model to prefer it for totalling macros. That cuts both ways: anything worth putting in the
text is worth putting in the structured output, and for a while three things weren't.

- `nutritionCoverage` counted distinct recipe references while sitting beside an array of rows —
  "36 of 103" next to 193 items — and the total was taken before unverified items were withheld,
  so the field could be larger than the array it described. It counts rows now, with the recipe
  figures kept alongside under their own names.
- Withholding items got a `withheld` field. A client reading only the structured output saw 36
  items with nothing to say 60 more had been held back.
- A few of UT's labels contradict themselves: Crispy Chopped Bacon is published as 897 cal and
  89.7 g of fat for a 3 oz serving, which is more fat than the food weighs. We can't tell which
  figure UT meant, so the number is passed through and flagged rather than quietly corrected, and
  the flag is on the item in both copies.

There is also an `avoid` filter for ingredient preferences — seed oils, palm oil, HFCS, gelatin,
added MSG, artificial colour — matched on named terms against the label's ingredient list. It is
a preference filter and says so; `exclude` is the one for allergens. Named terms rather than a
general ingredient search is deliberate: "oil" appears in 712 of 997 recipes and "soda" in 128, 80
of them baking soda, so an open index would mostly return noise.

`search_menu_items` searches today's menu first — the feed runs Monday to Sunday, so by Wednesday
a capped result was answering from a day already eaten — and matches whole words, with substring
hits kept but marked `[loose]`.

I left the `calculate` tool alone.

### Tests

`vp test`, 332 tests, no network, under a second. `test/fixtures/` holds real UT responses so
the parsers run against the markup UT actually serves.

The tool tests parse every response against the `outputSchema` the tool declared. Declaring one
makes the client reject any non-error response that doesn't match it, and the SDK types
`structuredContent` as an open record whatever the schema says, so the compiler can't link the
two. Doing it in the shared helper makes every test in that file a schema test for free.

I also ran the tools end to end against a model (gpt-4o-mini driving the live server) on ten real
questions, checking its answers against UT fetched separately rather than through the server.
That caught things unit tests can't: asked for a 700-calorie dinner it originally called the same
tool seven times and gave up, because 60 of 99 items came back without nutrition and the message
told it to narrow by a filter it had already set. Hence the `station` parameter, which is the one
narrowing small enough for every item to come back covered.

Two of the unit tests are there for specific reasons. The cache tests go through a fake Cache API that can
only hold bytes, which forces values through JSON the way Cloudflare does. A `Map` passes
everything otherwise and then breaks on the first cache hit. And one test pretty-prints the feed
and checks tags still parse, because a formatter did that to the fixture while I was working and
every item silently lost its tags; the scan was assuming `"legends":[` with no spaces.

`vp fmt` and `vp lint` are clean, exit 0, 0 errors.

Worth passing on to anyone else on Windows: `vp lint` can't run its type-aware pass from a path
containing a space (`Error running tsgolint`). Copying the repo somewhere without one makes it
work, and doing that is how I found a `require-array-sort-compare` error that would have failed
the new Format and Lint action.

Course tools aren't in here. Section listings for a future semester need the EID-gated Course
Schedule, which is the open question on #10.
