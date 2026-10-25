import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/Users/tester'
const DIR = `${HOME}/.claude/session-chime`
const MINE = `${DIR}/sessions/local_me.json`
const START = 1_800_000_000_000

const PANE = {
  plugin: 'session-chime',
  component: 'Pane',
  requestId: 'chime-inbox',
  props: {
    title: 'Sessions waiting',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

type Agent = { id: string; status: 'running' | 'completed' }
type Task = { id: string; type: string; status: string; description: string }
type Session = { isError: boolean; text: string }

// Everything beneath the mod, in memory: files, sounds, agents, the desktop.
function world(
  on: On,
  {
    agents = [] as Agent[],
    env = { HOME, CLAUDE_CODE_HOST_SESSION_ID: 'local_me' } as Record<string, string>,
    sessions = {} as Record<string, Session>,
    // Tools a settings hook beneath answers itself, so no dialog shows.
    denied = new Set<string>(),
    // What the desktop calls this session; a new one has no name until its first prompt.
    named = { title: 'Billing refactor' },
  } = {},
) {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const played: string[] = []
  const opened: { argv: readonly string[]; cwd: string | undefined }[] = []
  const panes: string[] = []
  const commands: { name: string; immediate: boolean }[] = []
  let tick = 0

  mock.env(on, env)
  const clock = mock.clock(on, { now: START })

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PermissionRequest', (_, e) =>
    denied.has(e.tool_name) ? { decision: { behavior: 'deny' as const, message: 'policy' } } : {},
  )
  on('command.register', (_, e) => {
    commands.push({ name: e.name, immediate: e.immediate === true })
    return { value: { command: e.name } }
  })
  on('ui.open', (_, e) => {
    panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('audio.play', (_, e) => {
    played.push(String(e.clip.asset))
    return { value: undefined }
  })
  on('agent.list', () => ({ value: agents as never }))
  on('mcp.call', (_, e) => {
    const id = String(e.args.session_id)
    const found =
      id === 'self'
        ? { isError: false, text: JSON.stringify({ title: named.title }) }
        : (sessions[id] ?? { isError: false, text: JSON.stringify({ isArchived: false }) })
    return { value: { content: [{ type: 'text', text: found.text }], isError: found.isError } }
  })
  on('process.run', (_, e) => {
    opened.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    mtimes.set(e.path, ++tick)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const prefix = `${e.path}/`
    const paths = [...files.keys()].filter(
      path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    )
    if (paths.length === 0) return { deny: `ENOENT: ${e.path}` }
    return {
      value: paths.map(path => ({
        name: path.slice(prefix.length),
        kind: 'file' as const,
        size: 0,
        mtimeMs: mtimes.get(path) ?? 0,
        isLink: false,
      })),
    }
  })

  const put = (path: string, value: unknown) => {
    files.set(path, JSON.stringify(value))
    mtimes.set(path, ++tick)
  }
  const json = (path: string) => {
    const text = files.get(path)
    return text === undefined ? undefined : JSON.parse(text)
  }

  return { clock, files, played, opened, panes, commands, put, json }
}

// A promise the test settles when it chooses: a dialog the person has not answered yet.
function held() {
  let release = () => {}
  const promise = new Promise<void>(resolve => (release = resolve))
  return { promise, release }
}

const start = ($: Engine, isInteractive = false) =>
  $.session.start({ cwd: '/Users/tester/code/billing', surface: 'desktop', isInteractive })

const prompt = (
  $: Engine,
  kind: 'sdk' | 'task-notification' | 'scheduled-trigger' = 'sdk',
  extra: { text?: string; turnId?: string } = {},
) =>
  $.prompt.submit({
    text: extra.text ?? 'go',
    wait: false,
    origin: { kind } as never,
    ...(extra.turnId === undefined ? {} : { turnId: extra.turnId }),
  })

const stop = ($: Engine, tasks: Task[] = []) =>
  $.classic.Stop({ stop_hook_active: false, background_tasks: tasks as never })

// A main-loop turn that takes `ms` of wall-clock time.
async function turn(
  $: Engine,
  w: ReturnType<typeof world>,
  ms: number,
  extra: {
    reason?: 'answer' | 'aborted' | 'error' | 'refusal'
    agentId?: string
    tasks?: Task[]
    // The whole turn's length, where it began before the last `ms` (a long tool call inside it).
    durationMs?: number
  } = {},
) {
  await w.clock.advance(ms)
  const reason = extra.reason ?? 'answer'
  if (reason !== 'aborted' && extra.agentId === undefined) await stop($, extra.tasks)
  await $.turn.complete({
    answer: 'Done.',
    durationMs: extra.durationMs ?? ms,
    isAborted: reason === 'aborted',
    turnId: `t${ms}`,
    ...(reason === 'refusal' ? { reason, refusal: { category: null, explanation: null } } : { reason }),
    ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
  } as never)
  await w.clock.settle()
}

const command = ($: Engine, args: string) =>
  $.command.run({
    command: 'chime',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

test('a long turn chimes and posts a done entry with a link back', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  await turn($, w, 60_000)

  expect(w.played).toEqual(['sounds/done.wav'])
  expect(w.json(MINE)).toMatchObject({
    id: 'local_me',
    title: 'Billing refactor',
    kind: 'done',
    durationMs: 60_000,
    isCleared: false,
    link: 'claude://claude.ai/epitaxy/local_me',
  })
  expect(w.panes).toEqual(['chime-inbox'])
  expect(w.commands).toEqual([{ name: 'chime', immediate: true }])
})

test('quick, interrupted and subagent turns stay quiet', async ($, on) => {
  const w = world(on)
  await start($)
  await turn($, w, 5_000)
  await prompt($)
  await turn($, w, 60_000, { reason: 'aborted' })
  await turn($, w, 60_000, { agentId: 'a1' })

  expect(w.played).toEqual([])
  expect(w.json(MINE)).toBeUndefined()
})

test('short wake-ups stay quiet, and each long turn chimes on its own', async ($, on) => {
  const w = world(on)
  await start($)
  await turn($, w, 60_000)
  // A monitor's events, its timeout and its re-arm: quick turns, nothing finished.
  await prompt($, 'task-notification')
  await turn($, w, 3_000, { tasks: [{ id: 'm1', type: 'monitor', status: 'running', description: 'CI' }] })
  await w.clock.advance(300_000)
  await prompt($, 'task-notification')
  await turn($, w, 3_000, { tasks: [{ id: 'm2', type: 'monitor', status: 'running', description: 'CI' }] })
  expect(w.played).toEqual(['sounds/done.wav'])

  // A /loop: the idle ten minutes between runs is no work; a long run is.
  await w.clock.advance(600_000)
  await prompt($, 'scheduled-trigger')
  await turn($, w, 5_000)
  expect(w.played).toEqual(['sounds/done.wav'])
  await w.clock.advance(600_000)
  await prompt($, 'scheduled-trigger')
  await turn($, w, 240_000)
  expect(w.played).toEqual(['sounds/done.wav', 'sounds/done.wav'])
  expect(w.json(MINE)).toMatchObject({ kind: 'done', durationMs: 240_000 })
})

test('a prompt queued behind a running turn chimes when it finishes', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, 'sdk', { text: 'build it' })
  await $.turn.start({ text: 'build it', turnId: 'a' })
  await w.clock.advance(10_000)
  await prompt($, 'sdk', { text: 'then write the docs', turnId: 'a' })
  await turn($, w, 50_000)
  expect(w.played).toEqual(['sounds/done.wav'])

  // The queued prompt runs as its own turn: A's row clears while it works.
  await $.turn.start({ text: 'then write the docs', turnId: 'b' })
  await w.clock.settle()
  expect(w.json(MINE)).toMatchObject({ isCleared: true })
  await turn($, w, 600_000)
  expect(w.played).toEqual(['sounds/done.wav', 'sounds/done.wav'])
})

test('running agents hold the chime until the session wakes and finishes', async ($, on) => {
  const agents: Agent[] = [{ id: 'a1', status: 'running' }]
  const w = world(on, { agents })
  await start($)
  await turn($, w, 60_000)
  expect(w.played).toEqual([])

  agents[0] = { id: 'a1', status: 'completed' }
  await w.clock.advance(30_000)
  await prompt($, 'task-notification')
  await turn($, w, 3_000)

  expect(w.played).toEqual(['sounds/done.wav'])
  expect(w.json(MINE)).toMatchObject({ kind: 'done', durationMs: 93_000 })
})

test('a background workflow holds the chime, and a long background shell chimes as it ends', async ($, on) => {
  const w = world(on)
  await start($)
  await turn($, w, 60_000, { tasks: [{ id: 'w1', type: 'workflow', status: 'running', description: 'review' }] })
  expect(w.played).toEqual([])

  await prompt($, 'task-notification')
  await turn($, w, 2_000)
  expect(w.played).toEqual(['sounds/done.wav'])

  // A build left running in the background: the turn that started it is over, and so is the build.
  await prompt($)
  await turn($, w, 20_000, { tasks: [{ id: 's1', type: 'shell', status: 'running', description: 'make' }] })
  await w.clock.advance(300_000)
  await prompt($, 'task-notification')
  await turn($, w, 2_000)
  expect(w.played).toEqual(['sounds/done.wav', 'sounds/done.wav', 'sounds/done.wav'])
  expect(w.json(MINE)).toMatchObject({ durationMs: 302_000 })
})

test('errors and refusals ping for attention', async ($, on) => {
  const w = world(on)
  await start($)
  await turn($, w, 40_000, { reason: 'error' })
  await prompt($)
  await turn($, w, 40_000, { reason: 'refusal' })

  expect(w.played).toEqual(['sounds/attention.wav', 'sounds/attention.wav'])
  expect(w.json(MINE)).toMatchObject({ kind: 'error', detail: 'Stopped: the model declined' })
})

test('a permission dialog pings at once and clears once answered', async ($, on) => {
  const w = world(on)
  on('tool.call', async (_, e) => {
    // The engine puts the dialog to the person while the call runs; they take 40s.
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
    await w.clock.settle()
    expect(w.json(MINE)).toMatchObject({ kind: 'input', isCleared: false, detail: 'Wants to run a command' })
    await w.clock.advance(40_000)
    await $.classic.PostToolUse({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: {},
      tool_use_id: e.tool_use_id,
      duration_ms: 1_000,
    })
    return { result: {} }
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await w.clock.settle()

  expect(w.played).toEqual(['sounds/attention.wav'])
  expect(w.json(MINE)).toMatchObject({ kind: 'input', isCleared: true })

  // The person was there 40s in: the 5s of work after it is a quick turn.
  await turn($, w, 5_000)
  expect(w.played).toEqual(['sounds/attention.wav'])
})

test('an approved command that runs long and fails still chimes when the turn ends', async ($, on) => {
  const w = world(on)
  on('tool.call', async (_, e) => {
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm run build' } })
    await w.clock.advance(20_000)
    await w.clock.advance(480_000)
    await $.classic.PostToolUseFailure({
      tool_name: 'Bash',
      tool_input: {},
      tool_use_id: e.tool_use_id,
      error: 'Exit code 1',
      duration_ms: 480_000,
    })
    return { result: 'Exit code 1', isError: true } as never
  })
  await start($)
  await $.turn.start({ text: 'build it', turnId: 'a' })
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  await turn($, w, 10_000, { durationMs: 510_000 })

  expect(w.played).toEqual(['sounds/attention.wav', 'sounds/done.wav'])
  expect(w.json(MINE)).toMatchObject({ kind: 'done', durationMs: 490_000 })
})

test('another call ending leaves an open dialog in the inbox', async ($, on) => {
  const w = world(on)
  const dialog = held()
  on('tool.call', async (_, e) => {
    if (e.tool === 'Bash') {
      await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
      await dialog.promise
    }
    return { result: {} }
  })
  await start($)
  const asking = $.tool.call({ tool: 'Bash', command: 'deploy' })
  await w.clock.settle()
  await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  await w.clock.settle()
  expect(w.json(MINE)).toMatchObject({ kind: 'input', isCleared: false })

  dialog.release()
  await asking
  await w.clock.settle()
  expect(w.json(MINE)).toMatchObject({ kind: 'input', isCleared: true })
})

test('a dialog is matched to its own call when two calls of one tool run together', async ($, on) => {
  const w = world(on)
  const first = held()
  const dialog = held()
  on('tool.call', async (_, e) => {
    const url = (e as { url?: string }).url
    if (url === 'https://b.example') {
      await $.classic.PermissionRequest({ tool_name: 'WebFetch', tool_input: { url, prompt: 'p' } })
      await dialog.promise
    } else {
      await first.promise
    }
    return { result: {} }
  })
  await start($)
  const a = $.tool.call({ tool: 'WebFetch', url: 'https://a.example', prompt: 'p' })
  const b = $.tool.call({ tool: 'WebFetch', url: 'https://b.example', prompt: 'p' })
  await w.clock.settle()
  expect(w.json(MINE)).toMatchObject({ kind: 'input', isCleared: false })

  first.release()
  await a
  await w.clock.settle()
  expect(w.json(MINE)).toMatchObject({ kind: 'input', isCleared: false })

  dialog.release()
  await b
  await w.clock.settle()
  expect(w.json(MINE)).toMatchObject({ isCleared: true })
})

test('a question pings once, however long the hooks before its dialog take', async ($, on) => {
  const w = world(on)
  on('tool.call', async (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      await w.clock.advance(4_000)
      await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: {} })
      await w.clock.settle()
    }
    return { result: {} }
  })
  await start($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await w.clock.settle()

  expect(w.played).toEqual(['sounds/attention.wav'])
})

test('asks nobody sees, or a hook already settled, stay quiet', async ($, on) => {
  const w = world(on, { denied: new Set(['Write']) })
  on('tool.call', async (_, e) => {
    await $.classic.PermissionRequest({
      tool_name: String(e.tool),
      tool_input: {},
      ...(e.agentId === undefined ? {} : { agent_id: e.agentId }),
    })
    return { result: {} }
  })
  await start($)
  // A background agent's ask: tool.check finds no one to put it to.
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'bg1' })
  // A settings hook answered the request itself.
  await $.tool.call({ tool: 'Write', file_path: '/tmp/x', content: '' })
  // A dialog for a call that already ended.
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  await w.clock.settle()

  expect(w.played).toEqual([])
  expect(w.json(MINE)).toBeUndefined()
})

test('only a prompt the person sends clears what this session posted', async ($, on) => {
  const w = world(on)
  await start($)
  await turn($, w, 60_000)
  await prompt($, 'task-notification')
  await w.clock.settle()
  expect(w.json(MINE)).toMatchObject({ isCleared: false })

  await prompt($)
  await w.clock.settle()
  expect(w.json(MINE)).toMatchObject({ isCleared: true })
})

test('a session that ends takes its open dialog out of the inbox', async ($, on) => {
  const w = world(on)
  const dialog = held()
  on('tool.call', async () => {
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
    await dialog.promise
    return { result: {} }
  })
  await start($)
  const asking = $.tool.call({ tool: 'Bash', command: 'deploy' })
  await w.clock.settle()
  expect(w.json(MINE)).toMatchObject({ kind: 'input', isCleared: false })

  await $.session.end({ reason: 'other', sessionId: 's', resume: { id: 's' } } as never)
  expect(w.json(MINE)).toMatchObject({ isCleared: true })
  dialog.release()
  await asking
})

test('a row posted before the session has a name gets it once the name lands', async ($, on) => {
  const named = { title: '' }
  const w = world(on, { named })
  const dialog = held()
  on('tool.call', async () => {
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
    await dialog.promise
    return { result: {} }
  })
  await start($)
  await w.clock.settle()
  named.title = 'Billing refactor'
  const asking = $.tool.call({ tool: 'Bash', command: 'deploy' })
  await w.clock.settle()

  expect(w.json(MINE)).toMatchObject({ kind: 'input', title: 'Billing refactor' })
  dialog.release()
  await asking
})

test('a claude run from inside another session stays out of it', async ($, on) => {
  const w = world(on, { env: { HOME, CLAUDE_CODE_HOST_SESSION_ID: 'local_me', CLAUDECODE: '1' } })
  await start($)
  await turn($, w, 60_000)

  expect(w.played).toEqual([])
  expect(w.commands).toEqual([])
  expect(w.files.size).toBe(0)
})

test('a terminal session that inherited another session’s shell stays on, under its own id', async ($, on) => {
  const w = world(on, { env: { HOME, CLAUDE_CODE_HOST_SESSION_ID: 'local_parent', CLAUDECODE: '1' } })
  await start($, true)
  await turn($, w, 60_000)

  expect(w.played).toEqual(['sounds/done.wav'])
  const mine = [...w.files.keys()].find(path => path.includes('/sessions/'))
  expect(mine).toMatch(/\/sessions\/cli_abc\.json$/)
  expect(w.json(mine ?? '')).toMatchObject({ link: null })
})

test('/chime mute silences chimes but keeps the inbox', async ($, on) => {
  const w = world(on)
  await start($)
  await command($, 'mute')
  await turn($, w, 60_000)

  expect(w.json(`${DIR}/prefs.json`)).toEqual({ isMuted: true, volume: 100 })
  expect(w.played).toEqual([])
  expect(w.json(MINE)).toMatchObject({ kind: 'done' })

  await command($, 'unmute')
  await command($, 'volume 50')
  expect(w.json(`${DIR}/prefs.json`)).toEqual({ isMuted: false, volume: 50 })
})

test('archived and deleted sessions leave the inbox', async ($, on) => {
  const w = world(on, {
    sessions: {
      local_gone: { isError: true, text: 'Session local_gone not found.' },
      local_archived: { isError: false, text: JSON.stringify({ isArchived: true }) },
    },
  })
  for (const id of ['local_gone', 'local_archived', 'local_live']) {
    w.put(`${DIR}/sessions/${id}.json`, {
      id,
      title: id,
      cwd: '/',
      kind: 'done',
      at: START - 1_000,
      durationMs: 30_000,
      isCleared: false,
      link: `claude://claude.ai/epitaxy/${id}`,
    })
  }
  await start($)
  await w.clock.advance(60_000)

  expect(w.json(`${DIR}/dismissed/local_gone.json`)).toEqual({ at: START - 1_000 })
  expect(w.json(`${DIR}/dismissed/local_archived.json`)).toEqual({ at: START - 1_000 })
  expect(w.json(`${DIR}/dismissed/local_live.json`)).toBeUndefined()
})

test('the inbox lists other sessions, and a press switches to one', async ($, on) => {
  const w = world(on)
  w.put(`${DIR}/sessions/local_other.json`, {
    id: 'local_other',
    title: 'notes-app',
    cwd: '/Users/tester/code/notes-app',
    kind: 'done',
    at: START - 119_000,
    durationMs: 250_000,
    isCleared: false,
    link: 'claude://claude.ai/epitaxy/local_other',
    detail: null,
  })
  await start($)
  // An entry older than the session's start does not pop the pane open.
  expect(w.panes).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^FINISHED · 1$/ }))?.text).toBe('FINISHED · 1')
    expect((await ui.find({ type: 'Text', text: /^notes-app$/ }))?.text).toBe('notes-app')
    // The folder is left out when the title already says it.
    expect((await ui.find({ type: 'Text', text: /ago/ }))?.text).toBe('1m ago · ran 4m 10s')
    expect((await ui.find({ key: 'local_other' }))?.text).toBe('Open')
    await ui.unmount()
  }

  // Ages follow the clock exactly: one more second makes it two minutes.
  await w.clock.advance(2_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ago/ }))?.text).toBe('2m ago · ran 4m 10s')
  await ui.press({ key: 'local_other' })

  expect(w.opened).toEqual([{ argv: ['open', 'claude://claude.ai/epitaxy/local_other'], cwd: '/' }])
  expect(w.json(`${DIR}/dismissed/local_other.json`)).toEqual({ at: START - 119_000 })
  expect((await ui.find({ type: 'Text', text: /all caught up/ }))?.text).toBe("You're all caught up")
  await ui.unmount()
})

test('a waiting session gets a card saying what it wants, above finished work', async ($, on) => {
  const w = world(on)
  const dialog = held()
  on('tool.call', async () => {
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'deploy' } })
    await dialog.promise
    return { result: {} }
  })
  w.put(`${DIR}/sessions/local_done.json`, {
    id: 'local_done',
    title: 'Fix flaky export test',
    cwd: '/Users/tester/code/api-server',
    kind: 'done',
    at: START - 600_000,
    durationMs: 168_000,
    isCleared: false,
    link: 'claude://claude.ai/epitaxy/local_done',
    detail: null,
  })
  await start($)
  await w.clock.advance(5_000)
  const asking = $.tool.call({ tool: 'Bash', command: 'deploy' })
  await w.clock.settle()
  await command($, 'mute')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^NEEDS YOU/ }))?.text).toBe('NEEDS YOU · 1')
    expect((await ui.find({ type: 'Text', text: /^Wants to/ }))?.text).toBe('Wants to run a command')
    expect((await ui.find({ type: 'Text', text: /^FINISHED/ }))?.text).toBe('FINISHED · 1')
    expect((await ui.find({ type: 'Text', text: /api-server/ }))?.text).toBe('api-server · 10m ago · ran 2m 48s')
    expect((await ui.find({ type: 'Text', text: /Chimes are off/ }))?.text).toContain('every session')
    expect((await ui.find({ key: 'mute' }))?.text).toBe('Unmute')
    // Icons on the desktop, glyphs in the terminal, which draws no Svg.
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.includes('"Svg"')).toBe(surface === 'desktop')
    await ui.unmount()
  }
  dialog.release()
  await asking
})
