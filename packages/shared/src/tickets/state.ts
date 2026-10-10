/**
 * Support ticket lifecycle, shared by every bot that opens tickets (ported
 * from the Ops bot). Pure functions only so the rules are unit-testable.
 *
 *            claim / userReply
 *          ┌──────────────┐
 *          ▼              │
 *        open ──markWaiting──▶ waiting
 *          │  ◀──userReply────   │
 *          │                     │
 *          └──close──▶ closed ◀──close
 *
 * - claim:       staff takes ownership; allowed while open or waiting, status unchanged.
 * - markWaiting: staff is waiting on the user; open -> waiting.
 * - userReply:   ticket owner posts a message; waiting -> open (no-op while open).
 * - close:       open|waiting -> closed. Closed is terminal.
 */
export const TICKET_STATUSES = ['open', 'waiting', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_ACTIONS = ['claim', 'markWaiting', 'userReply', 'close'] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

export class InvalidTransitionError extends Error {
  override name = 'InvalidTransitionError';
  constructor(
    readonly from: TicketStatus,
    readonly action: TicketAction,
  ) {
    super(describeInvalid(from, action));
  }
}

const TRANSITIONS: Record<TicketStatus, Partial<Record<TicketAction, TicketStatus>>> = {
  open: { claim: 'open', markWaiting: 'waiting', userReply: 'open', close: 'closed' },
  waiting: { claim: 'waiting', userReply: 'open', close: 'closed' },
  closed: {},
};

export function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === 'string' && (TICKET_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: TicketStatus, action: TicketAction): boolean {
  return TRANSITIONS[from][action] !== undefined;
}

/** Returns the status after applying `action`, or throws {@link InvalidTransitionError}. */
export function nextStatus(from: TicketStatus, action: TicketAction): TicketStatus {
  const to = TRANSITIONS[from][action];
  if (to === undefined) throw new InvalidTransitionError(from, action);
  return to;
}

function describeInvalid(from: TicketStatus, action: TicketAction): string {
  if (from === 'closed') return 'This ticket is already closed.';
  if (action === 'markWaiting' && from === 'waiting') return 'This ticket is already waiting on the user.';
  return `Cannot ${action} a ticket that is ${from}.`;
}
