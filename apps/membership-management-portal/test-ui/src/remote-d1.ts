type Mode = 'all' | 'raw' | 'run'
type Call = { sql: string; params: unknown[]; mode: Mode }
type Send = (request: SqlRequest) => Promise<any>

/** Body of a POST to the test UI's /api/sql: one call, or several run atomically as a D1 batch. */
export type SqlRequest = { batch: boolean; calls: Call[] }

const unsupported = (name: string): never => {
    throw new Error(`${name} isn't supported by the remote staging database`)
}

class RemoteStatement implements D1PreparedStatement {
    constructor(
        private readonly send: Send,
        readonly sql: string,
        readonly params: unknown[] = [],
    ) {}

    private one(mode: Mode) {
        return this.send({ batch: false, calls: [{ sql: this.sql, params: this.params, mode }] })
    }

    bind(...values: unknown[]) {
        return new RemoteStatement(this.send, this.sql, values)
    }
    all() {
        return this.one('all')
    }
    raw() {
        return this.one('raw')
    }
    run() {
        return this.one('run')
    }
    first(): never {
        return unsupported('first')
    }
}

class RemoteD1 implements D1Database {
    constructor(
        private readonly url: string,
        private readonly token: string,
    ) {}

    private readonly send: Send = async (request) => {
        const response = await fetch(this.url, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(request),
        })
        if (!response.ok) {
            throw new Error(
                `Staging database request failed (${response.status}): ${await response.text()}`,
            )
        }
        return response.json()
    }

    prepare(sql: string) {
        return new RemoteStatement(this.send, sql)
    }

    batch(statements: D1PreparedStatement[]) {
        return this.send({
            batch: true,
            calls: statements.map((statement) => {
                if (!(statement instanceof RemoteStatement)) throw new Error('Unexpected statement')
                return { sql: statement.sql, params: statement.params, mode: 'all' }
            }),
        })
    }

    exec(): never {
        return unsupported('exec')
    }
    withSession(): never {
        return unsupported('withSession')
    }
    dump(): never {
        return unsupported('dump')
    }
}

/**
 * A stand-in for a D1 binding that runs its SQL on the deployed test UI's /api/sql. It covers what
 * Drizzle's D1 driver calls (prepare, bind, all, raw, run and batch); the rest throws.
 */
export function remoteD1(url?: string, token?: string): D1Database {
    if (!url || !token)
        throw new Error('STAGING_DB_URL and STAGING_DB_TOKEN must be set in test-ui/.dev.vars')
    return new RemoteD1(url, token)
}
