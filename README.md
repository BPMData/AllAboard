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

---

## Tech Stack
- **Frontend**: React 19, TypeScript, Tailwind CSS, Konva / React-Konva, PDF.js (`pdfjs-dist`), Lucide Icons
- **Backend**: Node.js, Express, Socket.IO (WebSocket rooms with disk-backed JSON persistence)
