Closes #9

Adds `get_dining_menu`: give it a hall, a date and a meal, and it returns every item with
per-serving calories, protein, carbs, fat, fiber and sodium, plus allergens and dietary tags.
That's enough for the model to build a meal against a calorie or macro target in one call.

```
Dinner
  Comfort Table
    Halal Grilled Chicken (3) · 146 cal P 22.4 C 1.1 F 4.7 Na 310mg · Halal Friendly · #111301*3
    Baked Potato (1) · 249 cal P 5.7 C 48 F 4.7 fib 5 Na 23mg · Vegan · #161011*1
```

The same data comes back as `structuredContent`, so nothing has to parse the text to add it up.

Four more tools came along with it, off the same sources: `dining_hours`, `list_dining_locations`,
`search_menu_items` for when you don't know which hall, and `menu_item_nutrition` for one item's
full label. Happy to split those out if you'd rather keep this to the issue. Everything is public
UT data, no EID login, matching "UT SSO Required: No" on the issue.

## The nutrition numbers don't come from the menu feed

This is the non-obvious part. The feed ships a `nutrients` array and using it would have been
free, but it isn't per serving — there's one array per recipe, and the same recipe is served at
different portions at different halls. Crispy Chopped Bacon reports 299 cal; its label at the
serving it's actually dished at says 897. Chicken and Rice Soup goes the other way, overstating
by 4x. I checked two full menus and about one item in ten was off, between 0.25x and 4x, with
nothing in the feed to tell you which.

So nutrition is read per item from `label.aspx` — the page a student can open and check. That's
one request per item, and the free plan allows 50 per call, so a call reads at most 36 labels and
says how many items it covered. Narrowing by meal or station gets you everything.

Getting that budget right took two goes. Cache reads and writes count against the same 50
subrequests as `fetch`, which I'd missed, so caching each label separately cost three apiece — an
unfiltered menu measured 123 cold and 41 even fully warm. One cache entry for the whole batch
puts a cold call at 45 and a warm one at 2. There's a test holding both under the limit.

## Allergens, which is the part worth a careful read

The feed's allergen tags are incomplete. Breaded Plant-based Tender is tagged vegan, wheat and
soy, but its label also says tree nuts — so filtering on tags alone would have handed it to
someone avoiding nuts. The label is already being fetched for nutrition, so its allergen line is
what the `exclude` filter uses.

That left a subtler version of the same problem: items past the label budget have only their tags,
and 35 of this week's 997 recipes carry no tags at all. Chocolate Pistachio Cloud Cake is one of
them, and excluding peanuts returned it with an empty allergen list. So `exclude` now withholds
anything it couldn't verify instead of presenting it as safe, and says how many it held back and
how to see them.

The same thinking runs through the output: an empty allergen list from a label that was never read
is `null`, not `[]`, because `[]` reads as a claim that the item is allergen-free. `allergenSource`
says whether the label was actually read.

Every tool's input schema is strict, for a related reason. A key a tool doesn't declare used to be
dropped silently on the way in, so sending `exclude` to a tool that didn't take it came back as a
normal unfiltered menu with nothing to say the filter had been ignored. A filter that quietly does
nothing is worse than no filter.

## Everything else

`diet` and `exclude` error on a code they don't recognise. `avoid` filters on ingredient
preferences — seed oils, palm oil, HFCS, gelatin, MSG, artificial colour — matched on named terms
rather than free text, because "oil" appears in 712 of 997 recipes and most of the "soda" hits are
baking soda. `contains` is its inverse on `search_menu_items`: the ingredient text was already in
hand and nothing would search it, so "which dishes have seed oils" could only be answered as a
list of what to hide.

Upstream calls go through a small cache — in-memory, then the Cloudflare Cache API, then UT.
Concurrent misses for the same key share one request, and failures are remembered for 30s so an
outage doesn't become one UT request per visitor. Parsers throw rather than return half-parsed
data, and a UT SSO page is detected instead of parsed as content.

Four small things outside `src/`: a `test` block in `vite.config.ts` (nothing in the repo had tests
yet) with the fixtures excluded from formatting, `noUncheckedIndexedAccess` for this app, a `test`
script, and `localhost` added to `allowedHostnames` — setting that option turns off the library's
localhost default, so `wrangler dev` is otherwise rejected. No new dependencies. `calculate` is
untouched.

## Tests

`vp test`, 352 tests, no network, under a second. `test/fixtures/` holds real UT responses so the
parsers run against the markup UT actually sends. Every tool response is checked against the
`outputSchema` its tool declares, and every call goes through the input schema, because both are
places where something wrong looks exactly like something right.

I also drove the tools with a model against the live server on real questions, checking its
answers against UT fetched separately. That caught things unit tests can't — asked for a
700-calorie dinner it called the same tool seven times and gave up, because most items came back
without nutrition and the message told it to narrow by a filter it had already set. That's where
the `station` parameter came from.

`vp fmt` and `vp lint` are clean. One Windows note for anyone else: `vp lint` can't run its
type-aware pass from a path containing a space. Copying the repo somewhere without one fixes it,
and doing that is how I found a lint error that would have failed the Format and Lint action.

Course tools aren't here — section listings need the EID-gated Course Schedule, which is the open
question on #10.
