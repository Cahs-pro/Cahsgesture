// src/app/stateMachine.js
//
// Explicit finite state machines for the two device roles. Pure logic, no
// DOM/network — invalid transitions are rejected rather than silently
// ignored, which is what makes this testable and what stops the UI from
// ever showing an impossible screen (e.g. "PUT" before a GRAB was ever
// broadcast).

export const SENDER_STATES = Object.freeze({
  IDLE: 'IDLE',
  PAIRED: 'PAIRED',
  FILE_SELECTED: 'FILE_SELECTED',
  WAITING_FOR_GRAB: 'WAITING_FOR_GRAB',
  GRABBED: 'GRABBED',
  TRANSFERRING: 'TRANSFERRING',
  WAITING_FOR_PUT_CONFIRMATION: 'WAITING_FOR_PUT_CONFIRMATION',
  COMPLETE: 'COMPLETE',
  ERROR: 'ERROR',
});

export const RECEIVER_STATES = Object.freeze({
  IDLE: 'IDLE',
  PAIRED: 'PAIRED',
  WAITING_FOR_GRAB: 'WAITING_FOR_GRAB',
  PUT_SCREEN: 'PUT_SCREEN',
  BUFFERING: 'BUFFERING',
  PUT_DETECTED: 'PUT_DETECTED',
  REVEAL: 'REVEAL',
  COMPLETE: 'COMPLETE',
  ERROR: 'ERROR',
});

// Transition tables: { [fromState]: { [event]: toState } }
// ERROR and RESET are available from (almost) any state and are added
// automatically below rather than repeated on every row.

const SENDER_TRANSITIONS = {
  [SENDER_STATES.IDLE]: { PAIRED: SENDER_STATES.PAIRED },
  [SENDER_STATES.PAIRED]: { FILE_SELECTED: SENDER_STATES.FILE_SELECTED },
  [SENDER_STATES.FILE_SELECTED]: { READY: SENDER_STATES.WAITING_FOR_GRAB },
  [SENDER_STATES.WAITING_FOR_GRAB]: { GRAB_DETECTED: SENDER_STATES.GRABBED },
  [SENDER_STATES.GRABBED]: { TRANSFER_STARTED: SENDER_STATES.TRANSFERRING },
  [SENDER_STATES.TRANSFERRING]: {
    TRANSFER_COMPLETE: SENDER_STATES.WAITING_FOR_PUT_CONFIRMATION,
  },
  [SENDER_STATES.WAITING_FOR_PUT_CONFIRMATION]: {
    PUT_DETECTED: SENDER_STATES.COMPLETE,
  },
  [SENDER_STATES.COMPLETE]: { FILE_SELECTED: SENDER_STATES.FILE_SELECTED },
  [SENDER_STATES.ERROR]: { PAIRED: SENDER_STATES.PAIRED },
};

const RECEIVER_TRANSITIONS = {
  [RECEIVER_STATES.IDLE]: { PAIRED: RECEIVER_STATES.PAIRED },
  [RECEIVER_STATES.PAIRED]: { SESSION_READY: RECEIVER_STATES.WAITING_FOR_GRAB },
  [RECEIVER_STATES.WAITING_FOR_GRAB]: { GRAB_START: RECEIVER_STATES.PUT_SCREEN },
  [RECEIVER_STATES.PUT_SCREEN]: { TRANSFER_STARTED: RECEIVER_STATES.BUFFERING },
  [RECEIVER_STATES.BUFFERING]: {
    PUT_GESTURE_DETECTED: RECEIVER_STATES.PUT_DETECTED,
  },
  [RECEIVER_STATES.PUT_DETECTED]: { DATA_READY: RECEIVER_STATES.REVEAL },
  [RECEIVER_STATES.REVEAL]: { ACKNOWLEDGED: RECEIVER_STATES.COMPLETE },
  [RECEIVER_STATES.COMPLETE]: { GRAB_START: RECEIVER_STATES.PUT_SCREEN },
  [RECEIVER_STATES.ERROR]: { PAIRED: RECEIVER_STATES.PAIRED },
};

/**
 * A small, strict finite state machine. Emits 'transition' and 'reject'
 * events via the provided listener map so the UI layer can react without
 * this module knowing anything about the DOM.
 */
export class StateMachine {
  constructor(transitions, initialState, { allStates } = {}) {
    this.transitions = transitions;
    this.state = initialState;
    this.allStates = allStates || null;
    this.history = [initialState];
    this._listeners = { transition: [], reject: [] };
  }

  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  _emit(event, payload) {
    for (const handler of this._listeners[event] || []) handler(payload);
  }

  /** @returns {boolean} true if `event` is a legal transition from the current state */
  can(event) {
    const row = this.transitions[this.state] || {};
    return Object.prototype.hasOwnProperty.call(row, event);
  }

  /**
   * Attempt a transition. Returns the new state on success, or false if the
   * event is not legal from the current state (the machine does not move).
   */
  send(event, meta) {
    // ERROR is always reachable — a fatal condition can interrupt any flow.
    if (event === 'ERROR') {
      const from = this.state;
      this.state = this._errorState();
      this.history.push(this.state);
      this._emit('transition', { from, to: this.state, event, meta });
      return this.state;
    }

    if (!this.can(event)) {
      this._emit('reject', { from: this.state, event, meta });
      return false;
    }

    const from = this.state;
    this.state = this.transitions[from][event];
    this.history.push(this.state);
    this._emit('transition', { from, to: this.state, event, meta });
    return this.state;
  }

  _errorState() {
    // Both tables name their failure state 'ERROR'; fall back to the
    // current state if a custom table omits one (defensive, not expected).
    return this.allStates && 'ERROR' in this.allStates ? this.allStates.ERROR : 'ERROR';
  }

  reset(initialState) {
    const from = this.state;
    this.state = initialState;
    this.history.push(this.state);
    this._emit('transition', { from, to: this.state, event: 'RESET' });
    return this.state;
  }
}

export function createSenderMachine() {
  return new StateMachine(SENDER_TRANSITIONS, SENDER_STATES.IDLE, {
    allStates: SENDER_STATES,
  });
}

export function createReceiverMachine() {
  return new StateMachine(RECEIVER_TRANSITIONS, RECEIVER_STATES.IDLE, {
    allStates: RECEIVER_STATES,
  });
}
