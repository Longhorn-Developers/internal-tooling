import type { SqlRequest } from './remote-d1'

interface SqlEnv {
    membership_db?: D1Database
    STAGING_DB_TOKEN?: string
}

type Call = SqlRequest['calls'][number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const digest = async (text: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** Comparing fixed-length digests keeps the check from leaking where the tokens differ. */
async function authorized(request: Request, token: string | undefined) {
    if (!token) return false
    const [given, wanted] = await Promise.all([
        digest(request.headers.get('authorization') ?? ''),
        digest(`Bearer ${token}`),
    ])
    return given.reduce((diff, byte, i) => diff | (byte ^ wanted[i]), 0) === 0
}

const isCall = (value: unknown): value is Call =>
    isRecord(value) &&
    typeof value['sql'] === 'string' &&
    Array.isArray(value['params']) &&
    (value['mode'] === 'all' || value['mode'] === 'raw' || value['mode'] === 'run')

function parse(body: unknown): SqlRequest {
    if (!isRecord(body) || typeof body['batch'] !== 'boolean' || !Array.isArray(body['calls'])) {
        throw new Error('Expected { batch, calls }')
    }
    const calls: unknown[] = body['calls']
    if (!calls.every(isCall)) throw new Error('Expected calls of { sql, params, mode }')
    if (!calls.length || (!body['batch'] && calls.length > 1)) {
        throw new Error('Wrong number of calls')
    }
    return { batch: body['batch'], calls }
}

/**
 * Raw SQL against the staging database, for local workers that have no D1 binding of their own.
 * It exists only where there is a D1 binding (the deployed worker, not the local staging env) and
 * STAGING_DB_TOKEN is set; every other case answers 404.
 */
export async function handleSql(request: Request, env: SqlEnv): Promise<Response> {
    const db = env.membership_db
    if (!db || request.method !== 'POST' || !(await authorized(request, env.STAGING_DB_TOKEN))) {
        return new Response('Not found', { status: 404 })
    }

    try {
        const { batch, calls } = parse(await request.json().catch(() => null))
        const statements = calls.map(({ sql, params }) => db.prepare(sql).bind(...params))
        if (batch) return Response.json(await db.batch(statements))

        const [statement] = statements
        switch (calls[0].mode) {
            case 'raw':
                return Response.json(await statement.raw())
            case 'run':
                return Response.json(await statement.run())
            default:
                return Response.json(await statement.all())
        }
    } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 400 })
    }
}
