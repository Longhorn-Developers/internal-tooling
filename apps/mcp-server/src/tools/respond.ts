// How a tool hands an answer back, in one place.
//
// These two were copied into each tool directory because the first one to need
// them (tools/dining/index.ts) did not export them. Three copies is where that
// stops being reasonable, so they live here now. dining/ still has its own
// pair; switching it is a two-line change for whoever is next in that file, and
// is deliberately not bundled into an unrelated branch.

/** Text plus the same answer as data, for clients that would rather not parse prose. */
export const textWith = <T>(body: string, structuredContent: T) => ({
    content: [{ type: "text" as const, text: body }],
    structuredContent,
});

/**
 * Tool handlers answer with a readable message instead of throwing at the client.
 *
 * `error.message` is forwarded verbatim, which is why upstream parse failures
 * have to be turned into sentences before they get here: see `getJson` in
 * shared.ts.
 */
export const guard =
    <A>(
        run: (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
    ) =>
    async (args: A) => {
        try {
            return await run(args);
        } catch (error) {
            return {
                content: [{ type: "text" as const, text: (error as Error).message }],
                isError: true,
            };
        }
    };
