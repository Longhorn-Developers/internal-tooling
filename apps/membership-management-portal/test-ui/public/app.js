const VERTICALS = ['product', 'tech', 'design']
const EXEC_ROLES = [
    'President',
    'Product Director',
    'SWE Director',
    'Communications Director',
    'Membership Director',
    'UX Design Director',
]
const DESTRUCTIVE = /^(remove_|demote_|delete_)/
const LHD_TEAMS = [
    'UT Registration Plus',
    'UT Dining',
    'UT Lectures Plus',
    'Help Me Bevo',
    'Longhorn Studies',
    'Longhorn Lifts',
    'Longhorn Loop',
    'Mobilize UT',
    'UT Marketplace',
    'Pet Bevo',
    'Internal Tooling',
    'LHD Website',
]

const data = { target: '', users: [], teams: [], assignments: [] }
let pool = [] // changes the last sync or action reported
let lastSync = null // re-run after fixes: D1 and GitHub, not this page, are the truth
let outcome = null
let busy = false
const selected = new Set()
const history = []

const el = (tag, props, ...kids) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props ?? {})) {
        if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
        else if (key === 'class') node.className = value
        else if (value === true) node.setAttribute(key, '')
        else if (value !== false && value != null) node.setAttribute(key, value)
    }
    node.append(...kids.flat().filter((kid) => kid != null && kid !== false))
    return node
}

const keyOf = (c) =>
    JSON.stringify([c.service, c.kind, c.target, c.teamId ?? null, c.userId ?? null])
const userName = (id) => data.users.find((u) => u.id === id)?.name ?? id
const teamName = (id) => data.teams.find((t) => t.id === id)?.name ?? id
const option = (value, label) => el('option', { value }, label ?? value)

async function call(path, body) {
    const response = await fetch(
        path,
        body && {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        },
    )
    const json = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(json.error?.message ?? `HTTP ${response.status}`)
    return json
}

async function loadState() {
    Object.assign(data, await call('/api/state'))
}

function setPool(changes) {
    pool = changes
    selected.clear()
    for (const change of changes) {
        if (change.fixable && !DESTRUCTIVE.test(change.kind)) selected.add(keyOf(change))
    }
}

// Click handlers don't await actions; the page re-renders when each finishes.
const run = (method, ...args) => void execute(method, args)

async function execute(method, args) {
    busy = true
    render()
    try {
        const result = await call('/api/rpc', { method, args })
        history.unshift({ at: new Date().toLocaleTimeString(), method, args, result })
        outcome = { method, args, result }

        if (method.startsWith('sync')) {
            lastSync = { method, args }
            setPool(result.changes ?? [])
        } else if (method === 'autoFix' && lastSync) {
            const fresh = await call('/api/rpc', lastSync)
            setPool(fresh.changes ?? [])
        } else if (method !== 'autoFix') {
            setPool(result.changes ?? [])
        }
        await loadState()
    } catch (error) {
        outcome = { method, args, error: error.message }
    } finally {
        busy = false
        render()
    }
}

const confirmed = (message) => confirm(message)

async function createLhdTeams() {
    const missing = LHD_TEAMS.filter((name) => !data.teams.some((team) => team.name === name))
    if (!missing.length) return alert('All LHD teams already exist.')
    if (
        !confirmed(
            `Create ${missing.length} teams (and their GitHub teams)?\n${missing.join('\n')}`,
        )
    )
        return

    for (const name of missing) {
        await execute('createTeam', [name])
        if (outcome.error || Object.keys(outcome.result.failedServices).length) return
    }
}

function syncBar() {
    const team = el(
        'select',
        {},
        data.teams.map((t) => option(t.id, t.name)),
    )
    const user = el(
        'select',
        {},
        data.users.map((u) => option(u.id, `${u.name} (${u.status})`)),
    )
    return el(
        'section',
        {},
        el('h2', {}, 'Sync (read-only)'),
        el(
            'div',
            { class: 'row' },
            el('button', { class: 'primary', onclick: () => run('syncAll') }, 'Sync everything'),
            team,
            el('button', { onclick: () => team.value && run('syncTeam', team.value) }, 'Sync team'),
            user,
            el('button', { onclick: () => user.value && run('syncUser', user.value) }, 'Sync user'),
            el(
                'button',
                {
                    onclick: async () => {
                        await loadState()
                        render()
                    },
                },
                'Reload data',
            ),
        ),
    )
}

function changeRow(change) {
    const key = keyOf(change)
    const check = el('input', {
        type: 'checkbox',
        disabled: !change.fixable,
        checked: selected.has(key),
        onchange: (e) => (e.target.checked ? selected.add(key) : selected.delete(key)),
    })
    return el(
        'tr',
        {},
        el('td', {}, check),
        el(
            'td',
            {},
            el('code', {}, change.kind),
            change.blocking && el('span', { class: 'badge warn' }, 'blocking'),
        ),
        el('td', {}, el('code', {}, change.target)),
        el(
            'td',
            {},
            [change.userId && userName(change.userId), change.teamId && teamName(change.teamId)]
                .filter(Boolean)
                .join(' · '),
        ),
        el(
            'td',
            { class: change.fixable ? '' : 'muted' },
            change.reason,
            !change.fixable && ' (needs a person)',
        ),
    )
}

function changesPanel() {
    if (!pool.length) {
        return el(
            'section',
            {},
            el('h2', {}, 'Pending changes'),
            el('p', { class: 'muted' }, 'Nothing reported. Run a sync.'),
        )
    }
    const chosen = () => pool.filter((c) => selected.has(keyOf(c)))
    const apply = () => {
        const changes = chosen()
        const risky = changes.filter((c) => DESTRUCTIVE.test(c.kind))
        const note = risky.length
            ? `\n\nThese remove access or teams:\n${risky.map((c) => `- ${c.kind} ${c.target}`).join('\n')}`
            : ''
        if (
            changes.length &&
            confirmed(`Apply ${changes.length} change(s) to ${data.target}?${note}`)
        )
            run('autoFix', changes)
    }
    return el(
        'section',
        {},
        el('h2', {}, `Pending changes (${pool.length})`),
        el(
            'div',
            { class: 'row' },
            el(
                'button',
                { class: 'primary', onclick: apply },
                `Apply ${selected.size} selected (autoFix)`,
            ),
            el(
                'button',
                {
                    onclick: () => {
                        selected.clear()
                        pool.filter((c) => c.fixable && !DESTRUCTIVE.test(c.kind)).forEach((c) =>
                            selected.add(keyOf(c)),
                        )
                        render()
                    },
                },
                'Select safe',
            ),
            el(
                'button',
                {
                    onclick: () => {
                        selected.clear()
                        pool.filter((c) => c.fixable).forEach((c) => selected.add(keyOf(c)))
                        render()
                    },
                },
                'Select all fixable',
            ),
            el(
                'button',
                {
                    onclick: () => {
                        selected.clear()
                        render()
                    },
                },
                'Select none',
            ),
            el(
                'span',
                { class: 'muted' },
                'Removals are not selected by default. autoFix applies up to 10 at a time.',
            ),
        ),
        el(
            'table',
            {},
            el(
                'tr',
                {},
                ['', 'Kind', 'Target', 'Who / team', 'Reason'].map((h) => el('th', {}, h)),
            ),
            pool.map(changeRow),
        ),
    )
}

function outcomePanel() {
    if (!outcome)
        return el(
            'section',
            {},
            el('h2', {}, 'Last result'),
            el('p', { class: 'muted' }, 'Nothing run yet.'),
        )
    const { method, args, result, error } = outcome
    const title = el(
        'h2',
        {},
        `${method}(${args.map((a) => (typeof a === 'string' ? a : Array.isArray(a) ? `${a.length} changes` : JSON.stringify(a))).join(', ')})`,
    )
    if (error) return el('section', {}, title, el('p', { class: 'bad' }, error))

    const failedServices = Object.entries(result.failedServices ?? {})
    const failedChanges = result.failedChanges ?? []
    const rejected = result.rejected ?? []
    const deferred = method === 'autoFix' ? (result.changes ?? []) : []
    const nothing =
        !failedServices.length && !failedChanges.length && !rejected.length && !deferred.length

    return el(
        'section',
        {},
        title,
        result.userId && el('p', {}, 'Created user ', el('code', {}, result.userId)),
        nothing &&
            el('p', { class: 'ok' }, 'Completed. Everything reported is in Pending changes.'),
        failedServices.length > 0 &&
            el(
                'div',
                {},
                el('h2', { class: 'bad' }, 'Services that did not complete'),
                el(
                    'ul',
                    {},
                    failedServices.map(([name, err]) =>
                        el(
                            'li',
                            {},
                            el('code', {}, name),
                            ': ',
                            err
                                ? `${err.code ?? err.name}: ${err.message}`
                                : 'blocked by a missing entity (see Pending changes)',
                        ),
                    ),
                ),
            ),
        failedChanges.length > 0 &&
            el(
                'div',
                {},
                el('h2', { class: 'bad' }, 'Failed changes'),
                el(
                    'ul',
                    {},
                    failedChanges.map((f) =>
                        el(
                            'li',
                            {},
                            el('code', {}, `${f.change.kind} ${f.change.target}`),
                            ': ',
                            `${f.error.name}: ${f.error.message}`,
                        ),
                    ),
                ),
            ),
        rejected.length > 0 &&
            el(
                'div',
                {},
                el('h2', { class: 'warn' }, 'Rejected (never attempted)'),
                el(
                    'ul',
                    {},
                    rejected.map((c) =>
                        el('li', {}, el('code', {}, `${c.kind} ${c.target}`), `: ${c.reason}`),
                    ),
                ),
            ),
        deferred.length > 0 &&
            el(
                'div',
                {},
                el('h2', { class: 'warn' }, `Deferred (${deferred.length})`),
                el(
                    'p',
                    { class: 'muted' },
                    'Not attempted yet because of the 10-change cap or the request budget.',
                ),
                el('button', { onclick: () => run('autoFix', deferred) }, 'Resubmit deferred'),
            ),
    )
}

function editDialog(user) {
    const field = (name, label, value) =>
        el('label', {}, label, el('input', { name, value: value ?? '' }))
    const dialog = el(
        'dialog',
        { onclose: () => dialog.remove() },
        el(
            'form',
            {
                method: 'dialog',
                onsubmit: (e) => {
                    const form = new FormData(e.target)
                    const edits = {}
                    for (const name of ['name', 'email', 'discordId']) {
                        if (form.get(name) !== (user[name] ?? '')) edits[name] = form.get(name)
                    }
                    if (form.get('githubId') !== (user.githubId ?? ''))
                        edits.githubId = form.get('githubId') || null
                    if (Object.keys(edits).length) run('updateUser', user.id, edits)
                },
            },
            el('h2', {}, `Edit ${user.name}`),
            field('name', 'Name', user.name),
            field('email', 'Email', user.email),
            field('githubId', 'GitHub login (empty removes it)', user.githubId),
            field('discordId', 'Discord ID', user.discordId),
            el(
                'div',
                { class: 'row' },
                el('button', { class: 'primary' }, 'Save'),
                el('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
            ),
        ),
    )
    document.body.append(dialog)
    dialog.showModal()
}

function userRow(user) {
    const teams = data.assignments
        .filter((a) => a.userId === user.id)
        .map((a) => `${teamName(a.teamId)} (${a.vertical}${a.isLead ? ', lead' : ''})`)
    const role = el(
        'select',
        {},
        EXEC_ROLES.map((r) => option(r)),
    )
    const active = user.status === 'active'
    return el(
        'tr',
        {},
        el('td', {}, user.name, el('div', { class: 'muted' }, user.email)),
        el(
            'td',
            {},
            user.githubId ?? el('span', { class: 'warn' }, 'none'),
            el('div', { class: 'muted' }, `discord ${user.discordId}`),
        ),
        el(
            'td',
            { class: active ? 'ok' : 'muted' },
            user.status,
            user.execRole && el('div', {}, user.execRole),
        ),
        el('td', {}, teams.join(', ') || '—'),
        el(
            'td',
            { class: 'row' },
            el('button', { onclick: () => run('syncUser', user.id) }, 'Sync'),
            active && el('button', { onclick: () => editDialog(user) }, 'Edit'),
            active && role,
            active &&
                el('button', { onclick: () => run('makeExec', user.id, role.value) }, 'Make exec'),
            active &&
                user.execRole &&
                el('button', { onclick: () => run('removeExec', user.id) }, 'Remove exec'),
            active &&
                el(
                    'button',
                    {
                        class: 'danger',
                        onclick: () =>
                            confirmed(
                                `Deactivate ${user.name}? Removes their teams and GitHub access.`,
                            ) && run('deactivateUser', user.id),
                    },
                    'Deactivate',
                ),
        ),
    )
}

function usersPanel() {
    const form = el(
        'form',
        {
            class: 'row',
            onsubmit: (e) => {
                e.preventDefault()
                const f = new FormData(e.target)
                run(
                    'onboardUser',
                    f.get('name'),
                    f.get('email'),
                    f.get('github') || null,
                    f.get('discord'),
                )
            },
        },
        el('input', { name: 'name', placeholder: 'Name', required: true }),
        el('input', { name: 'email', type: 'email', placeholder: 'Email', required: true }),
        el('input', { name: 'github', placeholder: 'GitHub login (optional)' }),
        el('input', { name: 'discord', placeholder: 'Discord ID', required: true }),
        el('button', { class: 'primary' }, 'Onboard user'),
    )
    return el(
        'section',
        {},
        el('h2', {}, `Users (${data.users.length})`),
        form,
        el(
            'table',
            {},
            el(
                'tr',
                {},
                ['User', 'Accounts', 'Status', 'Teams', 'Actions'].map((h) => el('th', {}, h)),
            ),
            data.users.map(userRow),
        ),
    )
}

function teamCard(team) {
    const members = data.assignments.filter((a) => a.teamId === team.id)
    const user = el(
        'select',
        {},
        data.users.filter((u) => u.status === 'active').map((u) => option(u.id, u.name)),
    )
    const vertical = el(
        'select',
        {},
        VERTICALS.map((v) => option(v)),
    )
    const lead = el('input', { type: 'checkbox' })
    return el(
        'div',
        { class: 'card' },
        el('h2', {}, team.name, ' ', el('code', { class: 'muted' }, team.githubSlug)),
        el(
            'table',
            {},
            members.map((m) =>
                el(
                    'tr',
                    {},
                    el('td', {}, userName(m.userId)),
                    el('td', {}, m.vertical, m.isLead && el('span', { class: 'badge ok' }, 'lead')),
                    el(
                        'td',
                        {},
                        el(
                            'button',
                            { onclick: () => run('removeUserFromTeam', m.userId, team.id) },
                            'Remove',
                        ),
                    ),
                ),
            ),
        ),
        !members.length && el('p', { class: 'muted' }, 'No members.'),
        el(
            'div',
            { class: 'row' },
            user,
            vertical,
            el('label', {}, 'lead ', lead),
            el(
                'button',
                {
                    onclick: () =>
                        user.value &&
                        run('addUserToTeam', user.value, team.id, vertical.value, lead.checked),
                },
                'Add / update',
            ),
        ),
        el(
            'div',
            { class: 'row' },
            el('button', { onclick: () => run('syncTeam', team.id) }, 'Sync team'),
            el(
                'button',
                {
                    class: 'danger',
                    onclick: () =>
                        confirmed(
                            `Delete ${team.name}? Removes its assignments and GitHub teams.`,
                        ) && run('deleteTeam', team.id),
                },
                'Delete team',
            ),
        ),
    )
}

function teamsPanel() {
    return el(
        'section',
        {},
        el('h2', {}, `Teams (${data.teams.length})`),
        el(
            'form',
            {
                class: 'row',
                onsubmit: (e) => {
                    e.preventDefault()
                    run('createTeam', new FormData(e.target).get('name'))
                },
            },
            el('input', { name: 'name', placeholder: 'New team name', required: true }),
            el('button', { class: 'primary' }, 'Create team'),
            el(
                'button',
                { type: 'button', onclick: () => void createLhdTeams() },
                'Create all LHD teams',
            ),
            el(
                'span',
                { class: 'muted' },
                'Names ending in "-leads" or matching the exec/leads groups are rejected.',
            ),
        ),
        el('div', { class: 'grid' }, data.teams.map(teamCard)),
    )
}

function historyPanel() {
    return el(
        'section',
        {},
        el(
            'details',
            {},
            el('summary', {}, `Raw results (${history.length})`),
            history
                .slice(0, 15)
                .map((h) =>
                    el(
                        'div',
                        {},
                        el('p', { class: 'muted' }, `${h.at} ${h.method}`),
                        el('pre', {}, JSON.stringify(h.result, null, 2)),
                    ),
                ),
        ),
    )
}

function render() {
    document.querySelector('#target').textContent = data.target || 'unknown target'
    document.querySelector('#busy').hidden = !busy
    const app = document.querySelector('#app')
    app.replaceChildren(
        syncBar(),
        changesPanel(),
        outcomePanel(),
        usersPanel(),
        teamsPanel(),
        historyPanel(),
    )
    app.toggleAttribute('inert', busy)
}

void loadState()
    .catch((error) => (outcome = { method: 'load', args: [], error: error.message }))
    .finally(render)
