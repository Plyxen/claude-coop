// Plain-text views of the board, tasks and events, shared by the MCP tools
// (what Claude reads) and the CLI (what people read). All of it came from the
// network, so nothing here may move a terminal's cursor or close a <channel> tag.
import { cleanText, neutralizeMarkup } from './validate.js'

const safe = (text) => neutralizeMarkup(cleanText(text))

export function ago(iso, now = Date.now()) {
  if (!iso) return 'never'
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function oneLine(text, max = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function taskLine(task) {
  const who = task.assignee ?? '-'
  const extras = []
  if (task.priority && task.priority !== 'normal') extras.push(`[${task.priority}]`)
  if (task.pr_url) extras.push(task.pr_url)
  else if (task.branch && task.status !== 'open') extras.push(task.branch)
  return `#${task.id}  ${task.status.padEnd(11)} ${who.padEnd(12)} ${oneLine(task.title, 80)}${extras.length ? `  ${extras.join('  ')}` : ''}`
}

export function formatBoard(board) {
  const lines = [`Crew "${board.hub}": you are ${board.me} (${board.role})`, '', 'Members']
  if (board.security_alerts) lines.splice(1, 0, `Security: ${board.security_alerts} alert(s) in the last day. Run coop audit --alerts.`)
  if (board.pending_permissions) lines.splice(1, 0, `Permissions: ${board.pending_permissions} open request(s). Run coop permissions.`)
  for (const m of board.members) {
    const state = m.online ? 'online' : `offline (last seen ${ago(m.last_seen)})`
    const working = m.working_on.length ? `, working on ${m.working_on.map((id) => `#${id}`).join(', ')}` : ''
    lines.push(`  ${m.online ? '●' : '○'} ${m.name}${m.role === 'lead' ? ' (lead)' : ''}: ${state}${working}`)
  }
  lines.push('', 'Tasks')
  if (board.tasks.length) for (const task of board.tasks) lines.push(`  ${taskLine(task)}`)
  else lines.push('  (none open)')
  if (board.recently_done.length) {
    lines.push('', `Recently done: ${board.recently_done.map((t) => `#${t.id} ${oneLine(t.title, 50)}${t.assignee ? ` (${t.assignee})` : ''}`).join('; ')}`)
  }
  if (board.recent.length) {
    lines.push('', 'Recent activity')
    for (const event of board.recent) lines.push(`  ${ago(event.ts).padEnd(9)} ${describeEvent(event)}`)
  }
  return safe(lines.join('\n'))
}

export function formatTask({ task, history = [] }) {
  const lines = [
    `#${task.id} ${task.title}`,
    `Status: ${task.status}${task.assignee ? ` (${task.assignee})` : ''} · priority ${task.priority} · created by ${task.created_by} ${ago(task.created_at)}`,
  ]
  if (task.branch) lines.push(`Branch: ${task.branch}`)
  if (task.pr_url) lines.push(`Pull request: ${task.pr_url}`)
  if (task.scope) lines.push(`Scope: ${task.scope}`)
  if (task.details) lines.push('', 'Details:', task.details)
  if (task.summary) lines.push('', 'Submitted summary:', task.summary)
  if (history.length) {
    lines.push('', 'History')
    for (const event of history) lines.push(`  ${ago(event.ts).padEnd(9)} ${describeEvent(event)}`)
  }
  return safe(lines.join('\n'))
}

// One line per event, for the board and history views.
export function describeEvent(event) {
  const d = event.data ?? {}
  const who = event.actor
  const task = event.task_id ? `#${event.task_id}${d.title ? ` "${oneLine(d.title, 60)}"` : ''}` : ''
  const note = event.text ? `: ${oneLine(event.text, 140)}` : ''
  switch (event.type) {
    case 'task_created':
      return `${who} created ${task}${d.assignee ? ` for ${d.assignee}` : ' (open to anyone)'}`
    case 'task_assigned':
      return d.assignee ? `${who} assigned ${task} to ${d.assignee}` : `${who} put ${task} back in the pool`
    case 'task_claimed':
      return `${who} claimed ${task}`
    case 'task_progress':
      return `${who} on ${task}${note}`
    case 'task_blocked':
      return `${who} is blocked on ${task}${note}`
    case 'task_submitted':
      return `${who} submitted ${task} for review${note}`
    case 'task_approved':
      return `${who} approved ${task}${note}`
    case 'task_changes_requested':
      return `${who} asked for changes on ${task}${note}`
    case 'task_released':
      return `${who} released ${task}${note}`
    case 'task_cancelled':
      return `${who} cancelled ${task}${note}`
    case 'task_reopened':
      return `${who} reopened ${task}${d.assignee ? ` for ${d.assignee}` : ''}${note}`
    case 'task_comment':
      return `${who} commented on ${task}${note}`
    case 'message':
      return `${who} → ${event.target ?? 'everyone'}${task ? ` (about ${task})` : ''}${note}`
    case 'permission_request':
      return `${who} asked permission for ${d.tool_name}${note} [${d.request_id}]`
    case 'permission_verdict':
      return `${who} answered permission ${d.request_id}: ${d.behavior}`
    case 'security_alert':
      return `security alert${note}`
    default:
      return event.text ? `${event.text}` : `${who}: ${event.type}`
  }
}
