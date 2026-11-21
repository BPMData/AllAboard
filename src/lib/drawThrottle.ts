/** Network pacing for live drawing. Shared by the client and the load test (scripts/loadtest.ts). */

/**
 * Streaming ink: queue points and send them at most this often (2/s). Your own stroke always draws instantly;
 * other people see it grow in half-second chunks, which is plenty for underlining a worksheet. Every send goes to
 * every viewer of the board, so this is the main-board cost knob. Load test, 90 students on one board, pen down 40%:
 * 50 ms → 45% CPU, 333 ms → 18%, 500 ms → 15%, 1000 ms → 14% (diminishing returns past 500).
 */
export const POINT_FLUSH_MS = 500;

/** Remote cursors: send our pointer position at most this often (10/s). */
export const CURSOR_EMIT_MS = 100;
