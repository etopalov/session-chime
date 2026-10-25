export type EntryKind = 'done' | 'input' | 'error'

/** One session's latest ping, as ~/.claude/session-chime/sessions/<id>.json holds it. */
export type Entry = {
  id: string
  title: string
  cwd: string
  kind: EntryKind
  at: number
  durationMs: number
  isCleared: boolean
  link: string | null
  /** What a waiting session wants ("Wants to run a command"); null for finished work. */
  detail?: string | null
}

/** The waiting entries, newest first, and the time their ages were drawn at. */
export type Inbox = { entries: Entry[]; now: number }

export type Prefs = { isMuted: boolean; volume: number }

declare module 'claude-code' {
  interface PluginState {
    'session-chime': { inbox: Inbox; prefs: Prefs; title: string }
  }
}
