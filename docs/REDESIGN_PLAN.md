# Redesign plan (2026-11)

The design canvas ("KesherAI — redesign") holds every screen at computer and phone width. This is the order it goes
into the app. Every step keeps the canvas's look: tokens (bg #121213, panel #18181a, panel-2 #1f1f22, line #2a2a2e,
accent #98a3ff, text #ededee, muted #94949c, waiting #f0b37e), Heebo, RTL, 44px targets, 390px phone.

## Stage 1: the new design
1. Shared base: tokens as CSS variables; one segmented control, card, tabs, switch, and the computer/phone toggle.
2. Sidebar: one "new" button, recents always visible, routines folded; phone top bar (☰, bell) and the
   computer/phone toggle on screens that work on both.
3. Home, chat and message box: the `@` menu (F17), the approval card, dictation with ▾.
4. Code and code start: the approvals chip only in code.
5. Inbox: "Watch and approve" moves in; the bell opens it.
6. Models: tabs chat, code, images, video, music, speech, more; each with loaded now, recommended, on this computer.
7. PC health: overview, storage, programs, battery, and the computer/phone toggle.
8. All tools, settings, my day, memory, self-work.
9. Images (tabs by action), batch, training, canvas, Nodes, pipelines, compare.
10. Knowledge, libraries and their store as one screen, prompts, pages, personas, community.
11. Unity, Unreal, game helper, usage, updates, remote, dictation bar, text helper.
12. Phone pass: every screen at 390px; Android phone health (needs native code in the Android app).

## Stage 2: features the canvas already draws
13. F12 the chat changes settings, with an old → new approval card.
14. F21 usage heatmap of 12 weeks, top models and tools.
15. F11 model benchmark ("8/10 right") beside the speed.
16. F19 two models loaded at once.
17. A local update source: updates without GitHub. Done for computers (0.6.245); the phone is next.
18. F3 side chat.
19. F6 previews of Word, Excel and 3D.
20. F10 smart auto approvals.
21. F1 a model on the phone itself: already in the phone app ("On this phone": GGUF through wllama, Gemma 4 through LiteRT, models from the computer); the toggle's "on the phone" side opens it.

## Status (2026-11-15 evening)
- Stage 1 is in (0.6.238–0.6.243). Android phone health already existed in the phone app (Health page).
- Stage 2: 13–16 and 18 are in (0.6.240–0.6.244); 17 for computers in 0.6.245; 19 already existed.

## Later (asked by Roee)
- Synced cloud keys ("My devices") encrypted with a password the user sets, entered once on each new computer.
- **Students (asked 2026-11-16): AI study helpers that run well on a modest laptop** (8 GB RAM, no graphics card):
  speech with whisper base/small int8 on the CPU (small ≈ 0.85 GB RAM, about 2.5× faster than real time on a laptop
  i7), a 1–4 B chat model in Q4 (1–3 GB), and a cloud key as the optional faster path. Research: docs/RESEARCH_LOG.md
  "Students".
  - Lecture recording and summary: live transcript with timestamps, summary, key terms, slides captured when they
    change, per course.
  - Zoom / Teams lectures: record the computer's sound while a meeting app is open (the meeting recorder exists) and
    summarise it the same way.
  - Flashcards and quizzes from a lecture or a PDF, spaced repetition, Anki export.
  - Ask the course: answers from all its lectures and files, with the minute in the recording.
  - Live captions and translation (Hebrew ↔ English) during a lecture.
  - Exam plan from the syllabus and the calendar; practice from past exams.
  - A tutor mode that guides through homework step by step instead of giving the answer.
  - PDF/article reader: summary, glossary, "explain this paragraph".
  - Focus timer with study streaks; a short audio recap (text to speech) to listen to on the way.
  - Avatar in Zoom in place of the camera: open question with Roee (being shown as present while not there may
    break the course's rules; an honest version: a clearly labelled avatar or "Roee's notes bot").

## Throughout
- A security and performance scan every 5 changes.
- Each step checked on the computer through KesherAI, at 390px and through remote.
- A release every few steps.
