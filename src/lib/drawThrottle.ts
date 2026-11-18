/** Network pacing for live drawing. Shared by the client and the load test (scripts/loadtest.ts). */

/** Streaming ink: queue points and send them at most this often (20/s). Smooth to watch, ~3x fewer messages than per-move. */
export const POINT_FLUSH_MS = 50;

/** Remote cursors: send our pointer position at most this often (10/s). */
export const CURSOR_EMIT_MS = 100;
