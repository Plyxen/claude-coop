// The tools each Claude gets. Leads plan, review and manage the crew;
// workers claim, report and submit. Both can read the board and message.
import { formatBoard, formatTask } from '../format.js'

const taskId = { type: 'integer', minimum: 1, description: 'Task number, like 3 for #3' }

function idOf(value) {
  const id = Number(String(value ?? '').replace(/^#/, ''))
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error(`"${value}" is not a task number`), { expose: true })
  return id
}

const common = [
  {
    name: 'coop_status',
    description: 'Show the crew board: who is online and what they are working on, open tasks, work waiting for review, recently finished work and recent activity.',
    inputSchema: { type: 'object', properties: {} },
    run: async ({ client }) => formatBoard(await client.board()),
  },
  {
    name: 'coop_task',
    description: 'Show one task in full: details, scope, branch, pull request and its history.',
    inputSchema: { type: 'object', properties: { id: taskId }, required: ['id'] },
    run: async ({ client }, args) => formatTask(await client.task(idOf(args.id))),
  },
  {
    name: 'coop_inbox',
    description: 'Crew updates for you since you last checked. Only needed when channel messages are not arriving in this session. With wait_seconds it waits until something arrives.',
    inputSchema: {
      type: 'object',
      properties: { wait_seconds: { type: 'integer', minimum: 0, maximum: 600, description: 'Wait up to this many seconds for an update (0 just checks).' } },
    },
    run: async ({ readInbox }, args) => readInbox(Math.min(600, Math.max(0, Number(args.wait_seconds) || 0))),
  },
]

const lead = [
  {
    name: 'coop_assign',
    description: 'Create a task for the crew. Name a worker in "to", or leave it empty so any free worker can claim it. Write it so a Claude with no context can do it: goal, where in the code, how to check it, what not to touch.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, like "Add CSV export to the dashboard"' },
        details: { type: 'string', description: 'Everything the worker needs: goal, files or areas, how to check it is done, what not to touch.' },
        to: { type: 'string', description: 'Worker name. Empty: open to any free worker.' },
        scope: { type: 'string', description: 'Files or folders this task may change, so others know to stay clear.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        branch: { type: 'string', description: 'Branch name. Default: coop/<number>-<title>.' },
      },
      required: ['title', 'details'],
    },
    run: async ({ client }, args) => {
      const { task } = await client.createTask({
        title: args.title,
        details: args.details,
        to: args.to || undefined,
        scope: args.scope,
        priority: args.priority,
        branch: args.branch,
      })
      return `Created #${task.id} "${task.title}" ${task.assignee ? `for ${task.assignee}` : '(open: any free worker can claim it)'}. Branch: ${task.branch}.`
    },
  },
  {
    name: 'coop_review',
    description: 'Finish reviewing submitted work: approve it, or send it back with the changes you want.',
    inputSchema: {
      type: 'object',
      properties: {
        id: taskId,
        decision: { type: 'string', enum: ['approve', 'changes'] },
        feedback: { type: 'string', description: 'Required for changes: what to fix, concretely. Optional note for approve.' },
      },
      required: ['id', 'decision'],
    },
    run: async ({ client }, args) => {
      const id = idOf(args.id)
      const { task } = await client.taskAction(id, args.decision === 'approve' ? 'approve' : 'changes', { note: args.feedback })
      return args.decision === 'approve'
        ? `Approved #${id} "${task.title}". It's done on the board${task.pr_url ? '; merging it is a separate step.' : '. If it left a branch, merging that is a separate step.'}`
        : `Sent #${id} back to ${task.assignee} with your feedback.`
    },
  },
  {
    name: 'coop_manage_task',
    description: 'Change a task: assign it to a worker (or back to the pool with "to" empty), release it, cancel it, reopen a finished or cancelled one, or add a comment for whoever has it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: taskId,
        action: { type: 'string', enum: ['assign', 'release', 'cancel', 'reopen', 'comment'] },
        to: { type: 'string', description: 'For assign and reopen: the worker. Empty: open to anyone.' },
        note: { type: 'string', description: 'Why, or the comment text (required for comment).' },
      },
      required: ['id', 'action'],
    },
    run: async ({ client }, args) => {
      const { task } = await client.taskAction(idOf(args.id), args.action, { to: args.to || undefined, note: args.note })
      return `#${task.id} "${task.title}" is now ${task.status}${task.assignee ? ` (${task.assignee})` : ''}.`
    },
  },
  {
    name: 'coop_send',
    description: 'Send a message to one worker, or to the whole crew when "to" is empty. Use it to answer questions and give directions.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        to: { type: 'string', description: 'Worker name. Empty: everyone.' },
        task_id: { ...taskId, description: 'The task this is about, if any.' },
      },
      required: ['text'],
    },
    run: async ({ client }, args) => {
      const { to } = await client.send({ text: args.text, to: args.to || undefined, task_id: args.task_id ? idOf(args.task_id) : undefined })
      return `Sent to ${to ?? 'everyone'}.`
    },
  },
  {
    name: 'coop_remove',
    description: 'Remove a worker from the crew. Their tokens stop working and their unfinished tasks go back to the pool. To invite someone, ask your user to run coop invite NAME in their own terminal: tokens never pass through this conversation.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: async ({ client }, args) => {
      const result = await client.remove(args.name)
      return `Removed ${result.removed}.${result.released.length ? ` Back in the pool: ${result.released.map((id) => `#${id}`).join(', ')}.` : ''}`
    },
  },
  {
    name: 'coop_permission',
    description: "Refuse a worker's permission request. You can't approve one: only your user can, by running coop approve in their own terminal with their passphrase.",
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string' },
        request_id: { type: 'string', description: 'The five-letter id from the request' },
        decision: { type: 'string', enum: ['deny'] },
      },
      required: ['worker', 'request_id', 'decision'],
    },
    run: async ({ client }, args) => {
      if (args.decision !== 'deny') {
        throw Object.assign(new Error(`you can't approve permission requests. Ask your user to run this in their own terminal: coop approve ${args.worker} ${args.request_id}`), { expose: true })
      }
      await client.permissionVerdict({ worker: args.worker, request_id: args.request_id, behavior: 'deny' })
      return `Refused request ${args.request_id} from ${args.worker}.`
    },
  },
]

const worker = [
  {
    name: 'coop_claim',
    description: 'Claim a task: one assigned to you, or an open one when you are free. Returns the full task.',
    inputSchema: { type: 'object', properties: { id: taskId }, required: ['id'] },
    run: async ({ client }, args) => {
      const id = idOf(args.id)
      await client.taskAction(id, 'claim')
      const full = await client.task(id)
      return `${formatTask(full)}\n\nIt's yours. Next: git fetch, create ${full.task.branch} from the latest default branch (usually origin/main), do the work, run the checks, push, then coop_submit.`
    },
  },
  {
    name: 'coop_progress',
    description: 'Post a progress note on your task at a real milestone. Set blocked=true when you need the lead before you can go on.',
    inputSchema: {
      type: 'object',
      properties: { id: taskId, note: { type: 'string' }, blocked: { type: 'boolean', description: 'True if you are stuck until the lead answers.' } },
      required: ['id', 'note'],
    },
    run: async ({ client }, args) => {
      const id = idOf(args.id)
      await client.taskAction(id, args.blocked ? 'block' : 'progress', { note: args.note })
      return args.blocked ? `Marked #${id} blocked; the lead has been told. Their answer arrives as a channel message.` : `Posted on #${id}.`
    },
  },
  {
    name: 'coop_submit',
    description: 'Hand in your finished task for review, after pushing the branch (and opening a pull request if the project uses them).',
    inputSchema: {
      type: 'object',
      properties: {
        id: taskId,
        summary: { type: 'string', description: 'What changed and how you checked it.' },
        branch: { type: 'string', description: 'The branch you pushed, if not the task default.' },
        pr_url: { type: 'string', description: 'Pull request link, if you opened one.' },
      },
      required: ['id', 'summary'],
    },
    run: async ({ client }, args) => {
      const id = idOf(args.id)
      await client.taskAction(id, 'submit', { note: args.summary, branch: args.branch, pr_url: args.pr_url })
      return `Submitted #${id} for review. The lead's answer arrives as a channel message; meanwhile you're free for other tasks.`
    },
  },
  {
    name: 'coop_release',
    description: "Give a task back to the pool because you can't or shouldn't do it. Say why.",
    inputSchema: { type: 'object', properties: { id: taskId, reason: { type: 'string' } }, required: ['id', 'reason'] },
    run: async ({ client }, args) => {
      const id = idOf(args.id)
      await client.taskAction(id, 'release', { note: args.reason })
      return `Released #${id} back to the pool.`
    },
  },
  {
    name: 'coop_send',
    description: 'Send a message to your lead (the default), to another worker, or to "everyone". Use it for questions and anything the lead should know.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        to: { type: 'string', description: 'Default: your lead. A worker name, or "everyone".' },
        task_id: { ...taskId, description: 'The task this is about, if any.' },
      },
      required: ['text'],
    },
    run: async ({ client }, args) => {
      const to = !args.to ? 'lead' : args.to === 'everyone' ? undefined : args.to
      const result = await client.send({ text: args.text, to, task_id: args.task_id ? idOf(args.task_id) : undefined })
      return `Sent to ${result.to ?? 'everyone'}.`
    },
  },
]

export function toolsFor(role) {
  if (role === 'lead') return [...common, ...lead]
  return role === 'worker' ? [...common, ...worker] : common
}
