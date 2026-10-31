Closes #9

Adds `get_dining_menu`: pass a hall, a date and a meal, get every item with per-serving calories,
protein, carbs, fat, fiber and sodium, plus allergens and diet tags. Also returns
`structuredContent` with the same data so nothing has to parse the text.

```
> get_dining_menu { "location": "J2", "meal": "Dinner" }

Dinner
  Comfort Table
    Halal Grilled Chicken (3) · 146 cal P 22.4 C 1.1 F 4.7 Na 310mg · Halal Friendly · #111301*3
    Baked Potato (1) · 249 cal P 5.7 C 48 F 4.7 fib 5 Na 23mg · Vegan · #161011*1

> search_menu_items { "query": "cookie", "exclude": ["PNTS", "NTS"] }

Nothing from today through 11/01/2026 (at J2 Dining, Kins Dining, JCL Dining, without Peanuts,
Tree Nuts) matches "cookie". The name may match items that the exclusion then removed.
```

Four more tools off the same sources came with it: `dining_hours`, `list_dining_locations`,
`search_menu_items` and `menu_item_nutrition`. Happy to split those into their own PR. All public
UT data, no EID login, which matches "UT SSO Required: No" on the issue.

Two things to know before reviewing:

- The feed's `nutrients` array is not per serving. One array covers a recipe, and the same recipe
  is dished at different portions at different halls, so about one item in ten is off by anywhere
  from 0.25x to 4x. Nutrition is read per item from the label page UT publishes instead.
- The feed's allergen tags miss things the label declares. A vegan-tagged item came back with tree
  nuts on its label. So `exclude` reads labels. Anything it could not check is held back, not
  listed as safe.

352 tests, no network, under a second. `vp fmt` and `vp lint` clean. I also ran it against the
live worker with a model driving the tools, on real questions, checking the answers against UT
separately.

Course tools are not in here. Section listings need the EID-gated Course Schedule, which is the
open question on #10.
