// Which hub events get pushed into a Claude session. The lead hears about
// everything the workers do. A worker hears about its own work, open tasks
// it could pick up, messages for it, and finished work it should pull.
export function shouldPush(event, profile) {
  const me = profile.member
  if (event.actor === me) return false
  if (profile.role === 'lead') return event.type !== 'permission_verdict'
  if (profile.role !== 'worker') return false

  const d = event.data ?? {}
  const mine = d.assignee === me || d.previous_assignee === me
  switch (event.type) {
    case 'message':
      return event.target === me || event.target === null
    case 'task_created':
    case 'task_assigned':
    case 'task_reopened':
    case 'task_released':
      return mine || d.status === 'open'
    case 'task_changes_requested':
    case 'task_cancelled':
    case 'task_comment':
      return mine
    case 'task_approved':
      return true
    case 'member_removed':
      return d.name === me
    default:
      return false
  }
}
