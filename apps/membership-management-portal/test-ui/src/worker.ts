import { MembershipService as PortalService } from '../../src/index'
import { handleGitHubWebhook } from '../../src/github/github-webhook'
import { remoteD1 } from './remote-d1'
import { handleSql } from './sql-api'
/**
 * The portal as the test UI runs it. The deployed worker has the staging D1 binding. The local
 * `staging` env has none, so the portal's `membership_db` becomes a shim that sends its SQL to the
 * deployed worker's /api/sql, and the portal code runs unchanged. Exported under the portal's own
 * name so ctx.exports (a loopback service binding, with real RPC) finds it.
 */
export class MembershipService extends PortalService {
    constructor(ctx: ExecutionContext, { membership_db, ...env }: Env) {
        super(ctx, {
            ...env,
            membership_db: membership_db ?? remoteD1(env.STAGING_DB_URL, env.STAGING_DB_TOKEN),
        })
    }
}

// s: required string, S: optional string, b: boolean, e: user edits, c: changes to fix
type Token = 's' | 'S' | 'b' | 'e' | 'c'
const methods: Record<string, Token[]> = {
    onboardUser: ['s', 's', 'S', 's'],
    updateUser: ['s', 'e'],
    addUserToTeam: ['s', 's', 's', 'b'],
    removeUserFromTeam: ['s', 's'],
    deactivateUser: ['s'],
    makeExec: ['s', 's'],
    removeExec: ['s'],
    createTeam: ['s'],
    deleteTeam: ['s'],
    syncTeam: ['s'],
    syncUser: ['s'],
    syncService: ['s'],
    syncAll: [],
    autoFix: ['c'],
}

class BadRequest extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (record: Record<string, unknown>, key: string) => {
    const value = record[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new BadRequest(`${key} must be a string`)
    return value
}

function parseChange(value: unknown) {
    if (!isRecord(value)) throw new BadRequest('Each change must be an object')
    const { service, kind, target, reason, fixable, blocking } = value
    if (
        typeof service !== 'string' ||
        typeof kind !== 'string' ||
        typeof target !== 'string' ||
        typeof reason !== 'string' ||
        typeof fixable !== 'boolean' ||
        typeof blocking !== 'boolean'
    ) {
        throw new BadRequest('Malformed change')
    }
    return {
        service,
        kind,
        target,
        reason,
        fixable,
        blocking,
        ...(optionalString(value, 'teamId') !== undefined && {
            teamId: optionalString(value, 'teamId'),
        }),
        ...(optionalString(value, 'userId') !== undefined && {
            userId: optionalString(value, 'userId'),
        }),
    }
}

function parseArg(token: Token, value: unknown): unknown {
    switch (token) {
        case 's':
            if (typeof value === 'string' && value) return value
            throw new BadRequest('Expected a non-empty string')
        case 'S':
            if (value == null || value === '') return undefined
            if (typeof value === 'string') return value
            throw new BadRequest('Expected a string')
        case 'b':
            if (typeof value === 'boolean') return value
            throw new BadRequest('Expected a boolean')
        case 'e': {
            if (!isRecord(value)) throw new BadRequest('Expected an object')
            const { githubId } = value
            if (githubId !== undefined && githubId !== null && typeof githubId !== 'string') {
                throw new BadRequest('githubId must be a string or null')
            }
            return {
                ...(optionalString(value, 'name') !== undefined && {
                    name: optionalString(value, 'name'),
                }),
                ...(optionalString(value, 'email') !== undefined && {
                    email: optionalString(value, 'email'),
                }),
                ...(optionalString(value, 'discordId') !== undefined && {
                    discordId: optionalString(value, 'discordId'),
                }),
                ...(githubId !== undefined && { githubId }),
            }
        }
        case 'c':
            if (Array.isArray(value) && value.length <= 200) return value.map(parseChange)
            throw new BadRequest('Expected up to 200 changes')
        default:
            throw new BadRequest('Unsupported argument type')
    }
}

// Errors survive RPC as Error objects, but not JSON.stringify.
function plain(value: unknown): unknown {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            code: Reflect.get(value, 'code'),
            status: Reflect.get(value, 'status'),
            retryable: Reflect.get(value, 'retryable'),
        }
    }
    if (Array.isArray(value)) return value.map(plain)
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
    }
    return value
}

// A service that is blocked rather than errored is `undefined`, which JSON would drop.
function serialize(result: unknown) {
    const out = plain(result)
    if (isRecord(result) && isRecord(result['failedServices']) && isRecord(out)) {
        out['failedServices'] = Object.fromEntries(
            Object.entries(result['failedServices']).map(([name, error]) => [
                name,
                plain(error) ?? null,
            ]),
        )
    }
    return out
}

async function rpc(request: Request, membership: Service<PortalService>) {
    const body: unknown = await request.json().catch(() => null)
    if (!isRecord(body) || typeof body['method'] !== 'string')
        throw new BadRequest('Expected { method, args }')

    const method = body['method']
    const tokens = Object.hasOwn(methods, method) ? methods[method] : undefined
    if (!tokens) throw new BadRequest(`Unsupported method: ${method}`)

    const args: unknown = body['args'] ?? []
    if (!Array.isArray(args) || args.length > tokens.length)
        throw new BadRequest('Wrong number of arguments')
    const parsed = tokens.map((token, i) => parseArg(token, args[i]))

    return serialize(await Reflect.apply(Reflect.get(membership, method), membership, parsed))
}

export default {
    async fetch(request, env, ctx) {
        const { pathname } = new URL(request.url)
        if (pathname === '/api/sql') return handleSql(request, env)
        // Everything else the worker is given besides /api is the GitHub webhook.
        if (!pathname.startsWith('/api/')) return handleGitHubWebhook(request, env, ctx)

        const membership = ctx.exports.MembershipService
        try {
            if (pathname === '/api/state' && request.method === 'GET')
                return Response.json(await membership.getState())
            if (pathname === '/api/rpc' && request.method === 'POST')
                return Response.json(await rpc(request, membership))
            return Response.json({ error: { message: 'Not found' } }, { status: 404 })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return Response.json(
                { error: { name: error instanceof Error ? error.name : 'Error', message } },
                { status: error instanceof BadRequest ? 400 : 500 },
            )
        }
    },
} satisfies ExportedHandler<Env>
