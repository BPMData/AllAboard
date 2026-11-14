# AllAboard

**Real-Time Multiplayer Classroom Whiteboard, Breakout Rooms & IRC Chat**

**AllAboard** is a real-time collaborative infinite canvas and classroom workspace built for groups of 15–25+ students. Teachers can drop in PDF/image worksheets or customizable graphic organizers (like 4-Box Frayer Models), split the class into individual student boards or breakout group rooms, and monitor every board live in real time.

> Sister project to [**OverBoard**](https://github.com/bpmdata/OverBoard).

---

## Features

### Infinite Collaborative Canvas
- **Per-Student Isolated Ink & Eraser**: Each student's strokes live on their own isolated layer—students can erase or undo their own work without ever rubbing out a classmate's drawing or the teacher's background worksheet.
- **Drawing & Annotation Toolkit**:
  - Freehand Pen, Highlighter, and Per-User Eraser Brush
  - Straight Line, Arrow, Rectangle, and Circle shape tools
  - Floating **Text (`T`)** tool for typing directly onto worksheets
  - **Quick Stamp (`S`)** tool with one-click classroom stamps (**✓ Check**, **? Question**, **★ Star**, **👍 Thumbs Up**, **♥ Heart**, and a **[ My Name ]** username badge stamp)
- **Live Multiplayer Cursors**: Throttled real-time cursors with student names and active tool indicators.

### Non-Erasable Teacher Worksheets & Templates
- **Upload PDFs & Images**: Upload `.pdf`, `.png`, `.jpg`, or `.webp` files directly onto the board as a locked background layer underneath student ink. Multi-page PDFs can be arranged side-by-side or stacked vertically.
- **Built-In Customizable Classroom Templates**:
  1. **Task Check-In Columns** (*Got It / Still Working / Need Help*)
  2. **4-Corner Spectrum** (*Strongly Agree / Agree / Disagree / Strongly Disagree*)
  3. **4-Box Frayer Model** (*Definition / Characteristics / Examples / Non-Examples* with custom center concept)
- **Adjust & Reposition**: Teachers can drag and resize the background worksheet directly on the canvas and lock it in place.

### Breakout Rooms & Individual Student Boards
- **3 Classroom Modes**:
  - **Whole-Class Board**: Everyone collaborates on a single shared canvas.
  - **Individual Student Boards**: Every student automatically gets their own personal board (including late joiners)—ideal for individual Frayer Models or exit tickets.
  - **Breakout Group Rooms (2–8 Groups)**: Assign students via **Auto-Randomize**, **Manual Drag/Dropdown Assignment**, or **Student Self-Select**.
- **Worksheet Pre-Loading**: Automatically stamp a template or current worksheet onto every student or breakout board when launching an activity.
- **Teacher Live Grid Overview & Board Switcher**: View all student or group boards simultaneously in a live grid (with stroke counts and assigned students) or jump into any board from the top dropdown to give live feedback in red pen.

### IRC-Style Classroom Chat & Room Persistence
- **Unified or Per-Board Chat**: Keep the entire class in one chat channel or scope chat messages to each breakout room.
- **PIN-Protected Teacher Controls**: Claim or protect Teacher Mode with a room passcode, lock/unlock student drawing during instruction, or clear individual/all student ink.
- **7-Day Room Persistence & Portable Snapshots**: Rooms automatically persist on the server for 7 days and can be exported/imported as `.json` snapshots (or `.png` images) at any time.

---

## Quick Start (Local Development)

```bash
# Install dependencies
npm install

# Start the full-stack Express + Socket.IO + Vite server on port 3000
npm run dev
```

Open `http://localhost:3000` in your browser. Share the room URL or in-app **Invite QR Code** with students to join.

## Storage

Room state and worksheet assets are stored in `$DATA_DIR/allaboard.db` (default `.data/allaboard.db`). SQLite uses WAL mode, so `-wal` and `-shm` files may also be present. Stop the server before copying the `.db` file for backup. A legacy `rooms-store.json` is migrated automatically on first start and renamed `rooms-store.json.migrated-<timestamp>`.

In production on Cloud Run, local disk is wiped on cold starts and redeploys. Mount a Cloud Storage bucket as a volume and set `BACKUP_DIR` to its mount path (e.g. `/backup`). Rooms are copied there within ~10 s of changing (immediately on shutdown) and restored automatically at startup. Keep **max instances = 1**: one server process must be the only writer. Leave `DATA_DIR` unset (local disk); never point it at the bucket mount, because SQLite needs real file locking.

## Testing

```bash
# Unit + server integration tests (Node test runner, no browser needed)
npm test

# Browser end-to-end tests (Playwright + Chromium; boots its own server on port 3100)
npx playwright install chromium   # first time only
npm run test:e2e
```

- `tests/` — Node tests for pure logic (`inkCore`, `breakoutRounds`, `batchPdfExport`) and Socket.IO server behavior.
- `e2e/` — Playwright specs: multi-user classroom flows (chat, live ink sync, undo, lock, Clear Ink, Teacher PIN) and the canvas/PDF.js code in `worksheetLoader` and `batchPdfExport`, which needs a real browser.

---

## Tech Stack
- **Frontend**: React 19, TypeScript, Tailwind CSS, Konva / React-Konva, PDF.js (`pdfjs-dist`), Lucide Icons
- **Backend**: Node.js, Express, Socket.IO (WebSocket rooms with SQLite persistence)
