import { MembershipDatabase } from '../db/access'
import { GitHubService } from './github-service'
import Env = Cloudflare.Env;

const PATH = '/mmp-github'

type OrganizationEvent = {
    action: string
    organization: { login: string }
    membership?: { user: { login: string } }
}

/** Checks GitHub's HMAC-SHA256 signature (`sha256=<hex>`) of the raw body, in constant time. */
async function validSignature(
    secret: string,
    body: ArrayBuffer,
    header: string | null,
): Promise<boolean> {
    const hex = header?.match(/^sha256=([0-9a-f]{64})$/)?.[1]
    if (!secret || !hex) return false

    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
    )
    const signature = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16))
    return crypto.subtle.verify('HMAC', key, signature, body)
}

/**
 * The Worker's only HTTP surface: GitHub's `organization` webhook. On `member_added` (an org
 * invitation was accepted) it applies what the user should now have. Anything unsigned or
 * unexpected gets a bare 404/401.
 */
export async function handleGitHubWebhook(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== PATH) {
        return new Response('Not found', { status: 404 })
    }

    const body = await request.arrayBuffer()
    const signature = request.headers.get('x-hub-signature-256')
    if (!(await validSignature(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
        return new Response('Invalid signature', { status: 401 })
    }

    const event = request.headers.get('x-github-event')
    if (event === 'ping') return new Response('pong')
    if (event !== 'organization') return new Response('Ignored', { status: 202 })

    const payload: OrganizationEvent = JSON.parse(new TextDecoder().decode(body))
    const login = payload.membership?.user.login
    const ours = payload.organization.login.toLowerCase() === env.GITHUB_ORG.toLowerCase()
    if (payload.action !== 'member_added' || !login || !ours) {
        return new Response('Ignored', { status: 202 })
    }

    // GitHub gives up after 10 seconds; the sync runs after responding
    const service = new GitHubService(env, new MembershipDatabase(env.membership_db!))
    ctx.waitUntil(
        service
            .onJoinedOrg(login)
            .then(({ changes, failed }) => {
                if (failed || changes.length) {
                    console.warn(`github webhook: ${login} not fully applied`, { changes, failed })
                }
            })
            .catch((error) => console.error(`github webhook: ${login} failed`, error)),
    )
    return new Response('Accepted', { status: 202 })
}
