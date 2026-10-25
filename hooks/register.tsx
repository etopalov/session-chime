import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, EntryKind, Inbox, Prefs } from '../types'

type Engine = EngineInterface
type Sound = 'done' | 'attention'
// A tool call in flight: what tool.check said of it, whether it put a dialog to the person,
// and when that was answered.
type Call = {
  agentId: string | undefined
  tool: string
  isAsk: boolean
  mayAsk: boolean
  checked: string | undefined
  askedAt: number
  answeredAt: number
}

const PANE = 'chime-inbox'
const PANE_TITLE = 'Sessions waiting'
const POLL_MS = 2000
const LIVENESS_MS = 60_000
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const DEDUPE_MS = 3000
const TITLE_WAIT_MS = 1500
const LINK = 'claude://claude.ai/epitaxy/'
const SOUND: Record<Sound, string> = { done: 'sounds/done.wav', attention: 'sounds/attention.wav' }
// Tools that always stop and wait for the person when the main loop calls them.
const PERSON_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// Prompts the person sent: typed in the app or a terminal, or from a phone.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
// Background work that may never end on its own: never wait for it before chiming.
const OPEN_ENDED = new Set(['shell', 'monitor'])
// Each status as the desktop draws it (a stroke icon in a mid tone that reads on light and
// dark alike) and as the terminal does (a glyph in a theme color).
const ICON = {
  done: { label: 'Finished', mark: '✓', theme: 'success', stroke: '#3E9E6F', paths: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.6L16 9.6"/>' },
  input: { label: 'Needs your input', mark: '●', theme: 'permission', stroke: '#5B78EE', paths: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>' },
  error: { label: 'Stopped', mark: '✕', theme: 'error', stroke: '#D9574C', paths: '<path d="M12 3.5l9 16H3z"/><path d="M12 10v4"/><path d="M12 17.2v.1"/>' },
  muted: { label: 'Muted', mark: '♪', theme: 'inactive', stroke: '#8A887F', paths: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M22 9l-6 6"/><path d="M16 9l6 6"/>' },
  clear: { label: 'Nothing waiting', mark: '✓', theme: 'inactive', stroke: '#8A887F', paths: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.6L16 9.6"/>' },
} as const
const USAGE = [
  '/chime                open the Sessions waiting inbox',
  '/chime test           play both sounds',
  '/chime mute | unmute  silence or restore chimes in every session',
  '/chime volume <0-200> set the volume, in percent',
  '/chime clear          empty the inbox',
].join('\n')

const inbox = atom({ plugin: 'session-chime', key: 'inbox' } as const, { entries: [], now: 0 })
const prefs = atom({ plugin: 'session-chime', key: 'prefs' } as const, {
  isMuted: false,
  volume: 100,
})
const title = atom({ plugin: 'session-chime', key: 'title' } as const, '')

// This copy's own bookkeeping; a reload starts it over from session.start.
// Sessions share what they post through files under ~/.claude/session-chime.
const local = {
  minMs: 15_000,
  shouldAutoOpen: true,
  // A `claude` run from inside another session's shell: the mod stays out of it.
  isOff: false,
  dir: '',
  id: '',
  link: null as string | null,
  cwd: '',
  lastSeenAt: 0,
  lastPingAt: 0,
  // Where a stretch of work began, while it waits on background agents or workflows.
  heldSince: undefined as number | undefined,
  // The person's latest answer to a dialog in this turn: the work before it is theirs to see.
  answeredAt: 0,
  awaitsBackground: false,
  // Whether the person started this turn (and the next), so a shell's finish needs no chime.
  isTurnByPerson: false,
  isNextTurnByPerson: false,
  // Prompts the person typed over a running turn, to know their turn when it starts.
  typedOver: new Set<string>(),
  // Background shells in flight, by id, since when; and the longest that ended this turn.
  shells: new Map<string, number>(),
  shellRanMs: 0,
  calls: new Map<string, Call>(),
  writes: Promise.resolve(),
  cache: new Map<string, { mtimeMs: number; value: unknown }>(),
}

export const register: Register = (on, options) => {
  local.minMs = Number(options.minSeconds ?? 15) * 1000
  local.shouldAutoOpen = options.autoOpenInbox !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The engine's shell tool sets these for the processes it starts; a session's own engine has neither.
    const isLeaked =
      (await $.env.get('CLAUDECODE')) !== undefined || (await $.env.get('CLAUDE_CODE_SESSION_ID')) !== undefined
    // A `claude -p` or SDK run from a session's shell stays out. A person's own terminal session in a
    // tmux or editor that inherited those stays on, under its own id rather than the parent's.
    local.isOff = isLeaked && !e.isInteractive
    if (local.isOff) return started
    const home = (await $.env.get('HOME')) ?? ''
    const hostId = isLeaked ? undefined : await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
    local.dir = `${home}/.claude/session-chime`
    local.id = hostId ?? `cli_${await $.session.id()}`
    local.link = hostId === undefined ? null : LINK + hostId
    local.cwd = e.cwd
    local.lastSeenAt = await $.clock.now()
    await $.command.register({
      name: 'chime',
      description: 'Session chime: open the inbox, test, mute, unmute, volume, clear',
      argumentHint: '[test|mute|unmute|volume <0-200>|clear]',
      immediate: true,
    })
    await poll($)
    $.clock.every(POLL_MS, () => void poll($))
    $.clock.every(LIVENESS_MS, () => void prune($))
    void refreshTitle($)
    return started
  })

  on('session.end', async ($, e, next) => {
    // A dialog dies with its process; a terminal session or a /clear leaves nothing to come back to.
    const kind = local.link === null || e.reason === 'clear' ? undefined : 'input'
    if (!local.isOff) await enqueue(() => clearOwn($, kind, false))
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const named = e.session_title
    if (!local.isOff && named !== undefined && named !== '') await update($, title, () => named)
    return next(e)
  })

  // The person is back: this session no longer waits on them. System-started turns leave the row be.
  on('prompt.submit', async ($, e, next) => {
    if (local.isOff || !PERSON_ORIGINS.has(e.origin.kind) || e.isMeta === true) return next(e)
    void enqueue(() => clearOwn($))
    void refreshTitle($)
    if (e.turnId === undefined) {
      local.isNextTurnByPerson = true
      return next(e)
    }
    // Typed over a running turn: folded into it, or queued to run as a turn of its own.
    const submitted = await next(e)
    if (submitted.drop === undefined) local.typedOver.add(submitted.text)
    return submitted
  })

  on('turn.start', async ($, e, next) => {
    if (local.isOff || e.agentId !== undefined) return next(e)
    local.awaitsBackground = false
    local.answeredAt = 0
    local.isTurnByPerson = local.isNextTurnByPerson
    local.isNextTurnByPerson = false
    // A prompt the person queued during the last turn runs now as its own: they are back.
    const isQueued = [...local.typedOver].some(text => text !== '' && e.text.includes(text))
    local.typedOver.clear()
    if (isQueued) {
      local.isTurnByPerson = true
      void enqueue(() => clearOwn($))
    }
    return next(e)
  })

  // Raised before the turn ends: what background work is still in flight.
  on('classic.Stop', async ($, e, next) => {
    if (!local.isOff && e.agent_id === undefined) {
      const tasks = e.background_tasks ?? []
      const now = await $.clock.now()
      local.awaitsBackground = tasks.some(task => !OPEN_ENDED.has(task.type))
      // Shells alone: a monitor that times out or is re-armed has finished nothing.
      const shells = new Map(
        tasks.filter(task => task.type === 'shell').map(task => [task.id, local.shells.get(task.id) ?? now] as const),
      )
      for (const [id, since] of local.shells) {
        if (!shells.has(id)) local.shellRanMs = Math.max(local.shellRanMs, now - since)
      }
      local.shells = shells
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (local.isOff || e.agentId !== undefined) return result
    const now = await $.clock.now()
    const agents = await $.agent.list()
    const isBusy =
      local.awaitsBackground || agents.some(agent => agent.status === 'running' || agent.status === 'pending')
    local.awaitsBackground = false
    // A shell that finished while the person was away counts as the work it did.
    const shellRanMs = local.isTurnByPerson ? 0 : local.shellRanMs
    local.shellRanMs = 0
    if (e.reason === 'aborted') {
      // The person stopped it, so they are here; background work still running counts from now.
      local.heldSince = isBusy ? now : undefined
      return result
    }
    const startedAt = Math.max(local.heldSince ?? now - e.durationMs, local.answeredAt)
    if (isBusy) {
      // Not done yet: the session wakes when that work finishes, and that turn chimes.
      local.heldSince = startedAt
      return result
    }
    local.heldSince = undefined
    const ranMs = Math.max(now - startedAt, shellRanMs)
    if (ranMs < local.minMs) return result
    const kind: EntryKind = e.reason === 'answer' ? 'done' : 'error'
    const detail = e.reason === 'refusal' ? 'Stopped: the model declined' : kind === 'error' ? 'Stopped on an error' : null
    await chime($, kind === 'done' ? 'done' : 'attention')
    await refreshTitle($)
    await enqueue(() => post($, kind, ranMs, detail))
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (local.isOff) return next(e)
    const call: Call = {
      agentId: e.agentId,
      tool: String(e.tool),
      isAsk: false,
      mayAsk: false,
      checked: undefined,
      askedAt: 0,
      answeredAt: 0,
    }
    local.calls.set(e.tool_use_id, call)
    if (PERSON_TOOLS.has(call.tool) && call.agentId === undefined) {
      call.askedAt = await $.clock.now()
      void needsYou($, waitingOn(call.tool))
    }
    try {
      return await next(e)
    } finally {
      local.calls.delete(e.tool_use_id)
      if (call.askedAt > 0) {
        // Refused, or a question answered: the call's end is the answer.
        const answeredAt = call.answeredAt || (await $.clock.now())
        local.answeredAt = Math.max(local.answeredAt, answeredAt)
        if (![...local.calls.values()].some(other => other.askedAt > 0)) {
          void enqueue(() => clearOwn($, 'input'))
        }
      }
    }
  })

  // What the permission check made of each call, so a dialog can be matched to its own call.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const call = e.tool_use_id === undefined ? undefined : local.calls.get(e.tool_use_id)
    if (call !== undefined) {
      call.isAsk = verdict.decision === 'ask'
      // A background agent's ask has nobody to answer it.
      call.mayAsk = call.isAsk && e.approver !== undefined
      call.checked = JSON.stringify(e.input)
    }
    return verdict
  }).catch(($, e, next) => next(e))

  // Raised before a permission dialog shows; the hooks beneath may still settle it.
  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    if (local.isOff || answer.decision !== undefined || answer.block !== undefined) return answer
    const call = askedBy(e.tool_name, e.agent_id, JSON.stringify(e.tool_input))
    // No open call: already announced, already answered, or a background ask nobody sees.
    if (call === undefined) return answer
    call.askedAt = await $.clock.now()
    void needsYou($, waitingOn(e.tool_name))
    return answer
  }).catch(($, e, next) => next(e))

  // The tool ran, or ran and failed: it was approved when it started, `duration_ms` before now.
  on('classic.PostToolUse', async ($, e, next) => {
    await markAnswered($, e.tool_use_id, e.duration_ms)
    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    await markAnswered($, e.tool_use_id, e.duration_ms)
    return next(e)
  })

  on('command.run', { command: 'chime' }, async ($, e) => {
    const [verb = '', value] = e.args.trim().toLowerCase().split(/\s+/)
    switch (verb) {
      case '':
        await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
        return { text: 'Opened the Sessions waiting inbox.' }
      case 'test': {
        const { volume } = await read($, prefs)
        play($, 'done', volume)
        $.clock.after(1600, () => play($, 'attention', volume))
        return { text: 'Playing the done chime, then the needs-input ping.' }
      }
      case 'mute':
        await setPrefs($, current => ({ ...current, isMuted: true }))
        return { text: 'Chimes muted in every session. /chime unmute turns them back on.' }
      case 'unmute':
        await setPrefs($, current => ({ ...current, isMuted: false }))
        return { text: 'Chimes are back on in every session.' }
      case 'volume': {
        const percent = Math.round(Number(value))
        if (value === undefined || !Number.isFinite(percent) || percent < 0 || percent > 200) {
          const { volume } = await read($, prefs)
          return { text: `Volume is ${volume}%. Set it with /chime volume <0-200>.` }
        }
        await setPrefs($, current => ({ ...current, volume: percent }))
        play($, 'done', percent)
        return { text: `Volume set to ${percent}% in every session.` }
      }
      case 'clear': {
        const { entries } = await read($, inbox)
        await dismiss($, entries)
        return { text: `Cleared ${entries.length} from the inbox.` }
      }
      default:
        return { text: USAGE }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const { entries, now } = await read($, inbox)
    const { isMuted } = await read($, prefs)
    const waiting = entries.filter(entry => entry.kind !== 'done')
    const finished = entries.filter(entry => entry.kind === 'done')
    // The terminal draws no Svg: there the status is a glyph.
    const icon = (status: keyof typeof ICON, size = 16) =>
      'Svg' in table ? (
        <table.Svg source={svg(ICON[status])} alt={ICON[status].label} width={size} height={size} />
      ) : (
        <Text color={ICON[status].theme}>{ICON[status].mark}</Text>
      )
    const text = (entry: Entry, isUrgent: boolean) => (
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        <Text weight="semibold" wrap="truncate">{entry.title}</Text>
        {isUrgent && (
          <Text size="footnote" weight="medium" color={ICON[entry.kind].theme}>{detailOf(entry)}</Text>
        )}
        <Text size="footnote" dimColor>{metaOf(entry, now)}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap="md">
        <Box flexDirection="row" gap="sm" alignItems="center">
          <Text weight="semibold">Sessions waiting</Text>
          {entries.length > 0 && <Text weight="semibold" dimColor>{String(entries.length)}</Text>}
          <Box flexGrow={1} />
          <Button
            key="mute"
            label={isMuted ? 'Unmute' : 'Mute'}
            variant={isMuted ? 'primary' : 'secondary'}
            onPress={() => setPrefs($, current => ({ ...current, isMuted: !current.isMuted }))}
          />
        </Box>
        {isMuted && (
          <Box flexDirection="row" gap="sm" alignItems="center" borderStyle="round" borderDimColor paddingX="sm" paddingY="xs">
            {icon('muted')}
            <Text size="footnote">Chimes are off in every session. The inbox still fills.</Text>
          </Box>
        )}
        {entries.length === 0 && (
          <Box flexDirection="column" alignItems="center" gap="xs" paddingY="lg">
            {icon('clear', 32)}
            <Text weight="semibold">You're all caught up</Text>
            <Text size="footnote" dimColor>
              Sessions show up here when they finish or need you. Click Open to jump straight to one.
            </Text>
          </Box>
        )}
        {waiting.length > 0 && (
          <Box flexDirection="column" gap="xs">
            <Text size="caption" weight="semibold" dimColor>{`NEEDS YOU · ${waiting.length}`}</Text>
            {waiting.map(entry => (
              <Box flexDirection="row" gap="sm" alignItems="flex-start" borderStyle="round" borderDimColor paddingX="sm" paddingY="xs">
                {icon(entry.kind)}
                {text(entry, true)}
                <Button key={entry.id} label="Open" variant="primary" onPress={() => jump($, entry)} />
              </Box>
            ))}
          </Box>
        )}
        {finished.length > 0 && (
          <Box flexDirection="column" gap="xs">
            <Text size="caption" weight="semibold" dimColor>{`FINISHED · ${finished.length}`}</Text>
            {finished.map(entry => (
              <Box flexDirection="row" gap="sm" alignItems="flex-start" paddingY="xs">
                {icon(entry.kind)}
                {text(entry, false)}
                <Button key={entry.id} label="Open" variant="secondary" onPress={() => jump($, entry)} />
              </Box>
            ))}
          </Box>
        )}
        {entries.length > 0 && (
          <Box flexDirection="row" gap="sm" alignItems="center">
            <Button key="clear" label="Clear all" onPress={() => dismiss($, entries)} />
            <Text size="footnote" dimColor>Rows clear when you reply.</Text>
          </Box>
        )}
      </Box>
    )
  })
}

// The open call a permission dialog is about: its own loop's, by its arguments first.
function askedBy(tool: string, agentId: string | undefined, input: string): Call | undefined {
  const own = [...local.calls.values()].filter(
    call => call.askedAt === 0 && call.tool === tool && call.agentId === agentId,
  )
  const call =
    own.find(one => one.isAsk && one.checked === input) ??
    own.find(one => one.checked === input) ??
    own.find(one => one.isAsk) ??
    own[0]
  // A subagent's dialog reaches a person only where tool.check saw someone to answer it.
  return call !== undefined && (call.agentId === undefined || call.mayAsk) ? call : undefined
}

// Writes to this session's own entry run one at a time, in the order asked.
function enqueue(work: () => Promise<void>): Promise<void> {
  const run = local.writes.then(work)
  local.writes = run.catch(() => undefined)
  return run
}

async function readJson<T>($: Engine, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(String(await $.fs.read(path))) as T
  } catch {
    return undefined
  }
}

// Every *.json under `sub`, read again only when its mtime moved.
async function listJson<T>($: Engine, sub: string): Promise<Map<string, T>> {
  const found = new Map<string, T>()
  let files
  try {
    files = await $.fs.list(`${local.dir}/${sub}`)
  } catch {
    return found
  }
  for (const file of files) {
    if (file.kind !== 'file' || !file.name.endsWith('.json')) continue
    const path = `${local.dir}/${sub}/${file.name}`
    const hit = local.cache.get(path)
    if (hit?.mtimeMs === file.mtimeMs) {
      found.set(file.name, hit.value as T)
      continue
    }
    const value = await readJson<T>($, path)
    if (value === undefined) continue
    local.cache.set(path, { mtimeMs: file.mtimeMs, value })
    found.set(file.name, value)
  }
  return found
}

async function loadEntries($: Engine): Promise<Entry[]> {
  const posted = await listJson<Entry>($, 'sessions')
  const dismissed = await listJson<{ at: number }>($, 'dismissed')
  const now = await $.clock.now()
  return [...posted]
    .filter(([name, entry]) => {
      const isDismissed = (dismissed.get(name)?.at ?? -1) >= entry.at
      return !entry.isCleared && !isDismissed && now - entry.at < MAX_AGE_MS
    })
    .map(([, entry]) => entry)
    .sort((a, b) => b.at - a.at)
}

async function poll($: Engine) {
  const entries = await loadEntries($)
  const shared = await readJson<Prefs>($, `${local.dir}/prefs.json`)
  const now = await $.clock.now()
  const current = await read($, inbox)
  // Redraw when the rows change or any row's age would read differently.
  const isSame =
    JSON.stringify(entries) === JSON.stringify(current.entries) &&
    entries.every(entry => metaOf(entry, now) === metaOf(entry, current.now))
  if (!isSame) await update($, inbox, () => ({ entries, now }))
  const mine = await read($, prefs)
  if (shared && (shared.isMuted !== mine.isMuted || shared.volume !== mine.volume)) {
    await update($, prefs, () => shared)
  }
  const newest = Math.max(0, ...entries.map(entry => entry.at))
  if (newest > local.lastSeenAt) {
    local.lastSeenAt = newest
    if (local.shouldAutoOpen) await $.ui.open({ id: PANE, title: PANE_TITLE })
  }
}

// Rows of sessions that were archived or deleted leave every inbox.
async function prune($: Engine) {
  const { entries } = await read($, inbox)
  for (const entry of entries) {
    if (entry.link === null || entry.id === local.id) continue
    const found = await ask($, entry.id)
    if (found === undefined) continue
    const isGone = found.isError ? /not found/i.test(found.text) : parseField(found.text, 'isArchived') === true
    if (isGone) await $.fs.write(`${local.dir}/dismissed/${entry.id}.json`, JSON.stringify({ at: entry.at }))
  }
}

// The desktop's record of a session, or undefined when it does not answer in time.
async function ask($: Engine, sessionId: string): Promise<{ isError: boolean; text: string } | undefined> {
  const stop = new AbortController()
  const found = await Promise.race([
    $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: sessionId }).catch(() => undefined),
    $.clock.sleep(TITLE_WAIT_MS, { signal: stop.signal }).then(
      () => undefined,
      () => undefined,
    ),
  ])
  stop.abort()
  if (found === undefined) return undefined
  return { isError: found.isError, text: found.content.find(block => block.type === 'text')?.text ?? '' }
}

function parseField(text: string, field: string): unknown {
  try {
    return (JSON.parse(text) as Record<string, unknown>)[field]
  } catch {
    return undefined
  }
}

// The desktop's own title for this session, kept for posts that cannot wait for it.
async function refreshTitle($: Engine) {
  if (local.link === null) return
  const found = await ask($, 'self')
  const named = found === undefined || found.isError ? undefined : parseField(found.text, 'title')
  if (typeof named === 'string' && named !== '') await update($, title, () => named)
}

function play($: Engine, sound: Sound, volume: number) {
  void $.audio.play({ asset: SOUND[sound] }, { gain: volume / 100 }).catch((error: unknown) => {
    $.ui.log(`chime failed: ${String(error)}`, { to: 'debug' })
  })
}

async function chime($: Engine, sound: Sound) {
  const { isMuted, volume } = await read($, prefs)
  if (!isMuted) play($, sound, volume)
}

async function setPrefs($: Engine, change: (current: Prefs) => Prefs) {
  const changed = change(await read($, prefs))
  await $.fs.write(`${local.dir}/prefs.json`, JSON.stringify(changed))
  await update($, prefs, () => changed)
}

function ownPath(): string {
  return `${local.dir}/sessions/${local.id}.json`
}

async function post($: Engine, kind: EntryKind, durationMs: number, detail: string | null = null) {
  const entry: Entry = {
    id: local.id,
    title: (await read($, title)) || local.cwd.split('/').filter(Boolean).at(-1) || 'A session',
    cwd: local.cwd,
    kind,
    at: await $.clock.now(),
    durationMs,
    isCleared: false,
    link: local.link,
    detail,
  }
  await $.fs.write(ownPath(), JSON.stringify(entry))
  await poll($)
}

async function clearOwn($: Engine, onlyKind?: EntryKind, shouldPoll = true) {
  const entry = await readJson<Entry>($, ownPath())
  if (entry === undefined || entry.isCleared) return
  if (onlyKind !== undefined && entry.kind !== onlyKind) return
  await $.fs.write(ownPath(), JSON.stringify({ ...entry, isCleared: true }))
  if (shouldPoll) await poll($)
}

async function dismiss($: Engine, entries: readonly Entry[]) {
  for (const entry of entries) {
    await $.fs.write(`${local.dir}/dismissed/${entry.id}.json`, JSON.stringify({ at: entry.at }))
  }
  await poll($)
}

// A dialog is up for the person: ping (once for a burst of them) and post the row.
async function needsYou($: Engine, detail: string) {
  const now = await $.clock.now()
  if (now - local.lastPingAt >= DEDUPE_MS) {
    local.lastPingAt = now
    await chime($, 'attention')
  }
  await enqueue(() => post($, 'input', 0, detail))
  // A new session is named only after its first prompt: put the name on the row once it lands.
  await refreshTitle($)
  await enqueue(() => retitleOwn($))
}

async function markAnswered($: Engine, toolUseId: string, durationMs: number | undefined) {
  const call = local.calls.get(toolUseId)
  if (call !== undefined && call.askedAt > 0) call.answeredAt = (await $.clock.now()) - (durationMs ?? 0)
}

// Keeps the row's time, so no pane pops open again and a dismissal still holds.
async function retitleOwn($: Engine) {
  const named = await read($, title)
  const entry = await readJson<Entry>($, ownPath())
  if (named === '' || entry === undefined || entry.isCleared || entry.title === named) return
  await $.fs.write(ownPath(), JSON.stringify({ ...entry, title: named }))
  await poll($)
}

async function jump($: Engine, entry: Entry) {
  await dismiss($, [entry])
  if (entry.link === null) {
    $.ui.toast(`${entry.title} runs in a terminal; switch to it there.`)
    return
  }
  const opened = await $.process.run(['open', entry.link], { cwd: '/' }).catch(() => undefined)
  if (opened?.exitCode !== 0) {
    $.ui.toast(`Couldn't switch to ${entry.title}. Open it from the sidebar.`)
  }
}

// What a waiting session wants, in the words its row shows.
function waitingOn(tool: string): string {
  if (tool === 'AskUserQuestion') return 'Has a question for you'
  if (tool === 'ExitPlanMode') return 'Has a plan for you to approve'
  if (tool === 'Bash') return 'Wants to run a command'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'Wants to edit files'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'Wants to go online'
  const mcp = /^mcp__.+?__(.+)$/.exec(tool)
  return `Wants to use ${mcp?.[1] ?? tool}`
}

// Entries posted before 0.3.0 carry no detail.
function detailOf(entry: Entry): string {
  return entry.detail ?? (entry.kind === 'input' ? 'Needs your input' : 'Stopped on an error')
}

// The folder (unless the title already says it), the age and, for finished work, how long it ran.
function metaOf(entry: Entry, now: number): string {
  const folder = entry.cwd.split('/').filter(Boolean).at(-1)
  return [
    folder === entry.title ? undefined : folder,
    agoText(now - entry.at),
    entry.kind === 'input' ? undefined : `ran ${ranText(entry.durationMs)}`,
  ]
    .filter(part => part !== undefined)
    .join(' · ')
}

function svg(icon: { stroke: string; paths: string }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${icon.stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon.paths}</svg>`
}

function agoText(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  return `${Math.floor(ms / 3_600_000)}h ago`
}

function ranText(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
