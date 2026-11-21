# Voice mode

**עברית בקצרה:** מדברים בטבעיות והמערכת שולחת כשעוצרים; Esc מסיים. תמלול הדיבור (Whisper) רץ במחשב כברירת מחדל, ובמצב קולי התשובה תמיד מוקראת. הקראה בשיחות רגילות כבויה כברירת מחדל (הגדרות ← נגישות).

## What it does
Hands-free conversation: your speech becomes text, the chat model answers, and the answer is read aloud.

## Prerequisites
A microphone (the phone's works in the app) and a speech-to-text model; a read-aloud voice for answers. A cloud speech service is optional and asks first.

## Steps
1. Press the microphone in the message box to dictate, or start voice mode from the same control.
2. Talk normally; it sends when you pause. Press Esc (or tap again) to end.
3. Settings > Accessibility: choose whether answers are read aloud outside voice mode (off by default; the speaker button under an answer reads it on demand).
4. On the phone use remote access ([phone-remote.md](phone-remote.md)); the microphone belongs to the phone.

## Verify
Say a short sentence; it appears as text, the answer is spoken.

## Troubleshooting
- Nothing heard: allow the microphone in the browser or Android settings.
- Wrong language: say it in the language set for the model; Hebrew works with Hebrew-capable models.
- Slow: use a smaller speech model.

## Safety
Speech is processed on your computer unless you choose a cloud service; the app says so when you do.
