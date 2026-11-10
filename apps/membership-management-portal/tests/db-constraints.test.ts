import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MembershipDatabase } from '../src/db/access'

function fixture() {
    const sqlite = new DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals: true })
    for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort()) {
        sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'))
    }
    const binding = {
        prepare: (sql: string) => ({
            bind: (...params: (string | number | null)[]) => ({
                raw: async () => {
                    const statement = sqlite.prepare(sql)
                    statement.setReturnArrays(true)
                    return statement.all(...params)
                },
            }),
        }),
    }
    const db = new MembershipDatabase(binding as unknown as D1Database)
    const insert = (id: string, email = `${id}@example.com`, github: string | null = id, discord = id, name = 'Same name') =>
        sqlite.prepare('INSERT INTO users (id, name, email, github_id, discord_id) VALUES (?, ?, ?, ?, ?)').run(id, name, email, github, discord)
    return { sqlite, db, insert }
}

test('SQL enforces unique identities and case-insensitive email, but not names', () => {
    const { sqlite, insert } = fixture()
    try {
        insert('one', 'Mixed@Example.com')
        assert.throws(() => insert('two', 'mixed@example.COM'), /UNIQUE/)
        assert.throws(() => insert('two', undefined, 'one'), /UNIQUE/)
        assert.throws(() => insert('two', undefined, undefined, 'one'), /UNIQUE/)
        assert.throws(() => insert('two', undefined, 'UPPER'), /CHECK/)
        insert('two', undefined, null)
        insert('three', undefined, null)
        assert.equal(sqlite.prepare('SELECT count(*) AS n FROM users WHERE name = ?').get('Same name')!.n, 3)
        assert.throws(() => sqlite.exec("UPDATE users SET email = 'mixed@EXAMPLE.com' WHERE id = 'two'"), /UNIQUE/)
    } finally { sqlite.close() }
})

test('database helpers normalize identities on both create and update', async () => {
    const { sqlite, db } = fixture()
    try {
        const user = await db.createUser({ name: 'Name', email: ' Mixed@Example.COM ', githubId: ' MixedCase ', discordId: ' 1234 ' })
        assert.equal(user.email, 'mixed@example.com')
        assert.equal(user.githubId, 'mixedcase')
        assert.equal(user.discordId, '1234')
        const edited = await db.updateUser(user.id, { email: ' NEW@EXAMPLE.COM ', githubId: ' Different ', discordId: ' 5678 ' })
        assert.equal(edited.email, 'new@example.com')
        assert.equal(edited.githubId, 'different')
        assert.equal(edited.discordId, '5678')
        assert.equal((await db.updateUser(user.id, { githubId: ' ' })).githubId, null)
        await assert.rejects(db.createUser({ name: 'Other', email: 'NEW@example.com', discordId: '9999' }))
    } finally { sqlite.close() }
})

test('team slugs are persisted, unique and independent of display names', async () => {
    const { sqlite, db } = fixture()
    try {
        const team = await db.createTeam({ name: 'UT Dining!' })
        assert.equal(team.githubSlug, 'ut-dining')
        await assert.rejects(db.createTeam({ name: 'UT---Dining' }))
        await assert.rejects(db.createTeam({ name: '!!!' }))
        sqlite.prepare('UPDATE teams SET name = ? WHERE id = ?').run('New display name', team.id)
        assert.equal((await db.getTeam(team.id)).githubSlug, 'ut-dining')
    } finally { sqlite.close() }
})
