# session-chime

A Claude Code mod that chimes when one of your sessions finishes its work or
needs you, and keeps a **Sessions waiting** inbox beside the chat so you can see
every session that's done and jump straight to it.

- **Done chime**: a soft two-note chime when a session finishes a turn that ran
  at least `minSeconds` (default 15). Time spent waiting on your answers doesn't
  count, and quick replies, interrupted turns and subagent turns stay quiet.
  While background agents or workflows are still running it waits, then chimes
  when the session wraps up; a long background shell chimes when it ends.
- **Needs-input ping**: a sharper double ping when a session puts a permission
  dialog, a question, or a plan approval to you. This one always sounds.
- **Inbox pane**: opens on a new ping. Sessions that need you sit on top as
  cards that say what they want ("Wants to run a command", "Has a question for
  you"), with finished work listed below, newest first. Press Open to jump to
  that session in the desktop app. Rows clear when you reply to that session,
  and archived or deleted sessions drop out on their own.
- **/chime**: `/chime` opens the inbox, `/chime test` plays both sounds,
  `/chime mute` and `/chime unmute` apply to every session,
  `/chime volume <0-200>` sets the volume, and `/chime clear` empties the inbox.

Options (`minSeconds`, `autoOpenInbox`) are in the config menu. Sessions share
the inbox through files under `~/.claude/session-chime/`. Sounds play with
`afplay`, so they work on macOS only.

## Install

At the prompt of a terminal session:

```
/plugin install session-chime --marketplace etopalov/session-chime
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in
every session).

From a shell:

```bash
claude plugin install session-chime --marketplace etopalov/session-chime
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `etopalov/session-chime`, then Add
plugin.
