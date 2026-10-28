# Remotely

Control your Mac or Windows computer from an iPhone or Android phone — on the same Wi-Fi or over the internet.

> **Picking this up?** Read [HANDOFF.md](HANDOFF.md) for status, what's verified, and how to install on all four devices.

```
 phone (mobile/)                         computer (desktop/)
 ┌──────────────┐   WebRTC: screen video  ┌──────────────────┐
 │ Expo / RN    │ ◀────────────────────── │ Electron agent   │
 │ controller   │ ──────────────────────▶ │ nut.js input     │
 └──────┬───────┘   data channel: input   └────────┬─────────┘
        │  signed signaling (offer/answer/ICE)     │
        ├──── ws://<lan-ip>:47800  (agent's built-in LAN relay)
        └──── wss://your-server    (server/, for internet access)
```

| Folder     | What                                                                 |
|------------|----------------------------------------------------------------------|
| `desktop/` | Electron agent for macOS + Windows. Shows a pairing QR code, streams the screen, applies mouse/keyboard input. |
| `mobile/`  | Expo (React Native) app for iOS + Android. Scans the QR, shows the screen, trackpad/touch gestures, keyboard. |
| `server/`  | Tiny Node signaling relay + TURN credential minting. Needed only for internet connections. |

## Security model

- Pairing = scanning a QR that contains the device ID and a 256-bit secret. The secret never leaves the two devices.
- Every signaling message is HMAC-SHA256 signed with that secret, timestamped, and nonce-checked. The relay
  (LAN or cloud) is untrusted: it can't read the secret, forge an offer, or swap DTLS fingerprints, so it can't
  man-in-the-middle the WebRTC session.
- Video and input travel over WebRTC (DTLS-SRTP / SCTP), end-to-end encrypted.
- "Unpair all phones" on the computer rotates the ID and secret.

## Run it

### 1. Desktop agent (Mac or Windows)

```bash
cd desktop
npm install
npm start
```

macOS: grant **Screen Recording** and **Accessibility** when prompted (buttons appear in the app), then restart it.
Windows: allow Remotely through the firewall on **private networks** so phones on your Wi-Fi can reach port 47800.

Build installers: `npm run dist:win` (on Windows) / `npm run dist:mac` (on a Mac).

### 2. Mobile app (iPhone / Android)

WebRTC needs native code, so Expo Go won't work — use a development build:

```bash
cd mobile
npm install
npx expo run:android          # Android device/emulator (needs Android Studio)
npx expo run:ios --device     # iPhone (needs a Mac with Xcode)
# or build in the cloud, no Xcode/Android Studio required:
npx eas-cli@latest build --profile development --platform all
```

Then `npx expo start` and open the dev build.

Open the app → **Add computer** → scan the QR shown in the desktop agent. Tap the computer to connect.

### 3. Internet access (optional, for "from anywhere")

Same-Wi-Fi works with nothing else. For internet access deploy `server/` (any Node host or Docker: Fly.io,
Render, Railway, a VPS) behind HTTPS so it's reachable as `wss://…`:

```bash
cd server && npm install && PORT=8080 npm start
# or
docker build -t remotely-server server && docker run -p 8080:8080 remotely-server
```

Put the `wss://` URL into **Settings → Signaling server** on the computer, then re-scan the QR on the phone.

Most networks connect directly with STUN. Strict NATs / mobile carriers need a **TURN** relay (e.g. coturn,
or a hosted provider). Configure the server with:

| Env var | Meaning |
|---|---|
| `TURN_URLS` | `turn:turn.example.com:3478,turns:turn.example.com:5349` |
| `TURN_SECRET` | coturn `static-auth-secret` (short-lived creds are minted per connection) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | static creds instead of `TURN_SECRET` |
| `STUN_URLS` | override STUN (default: Google) |

## Using it on the phone

| Gesture | Trackpad mode (default) | Touch mode |
|---|---|---|
| 1-finger drag | move cursor | drag (mouse held) |
| tap | left click | click at that spot |
| 2-finger tap | right click | right click |
| 3-finger tap | middle click | middle click |
| long-press | start drag (click-and-hold) | right click |
| 2-finger drag | scroll | scroll |
| pinch | zoom in/out (cursor stays in view) | zoom in/out |

⌨ opens the keyboard plus a key bar (Esc, Tab, Ctrl/Alt/Shift/⌘-Win as sticky modifiers, arrows, F-keys).
🖥 switches between monitors. 📋 sends the phone clipboard to the computer or fetches the computer's clipboard.

**All computers at once:** with 2+ computers paired, tap **View all computers live** on the home screen. Every
computer streams as a live tile; tap one for full control, go back and the others are still connected.
Several phones (e.g. your iPhone and your Android) can be connected to the same computer at the same time.

The desktop agent keeps running in the system tray when its window is closed, can start at login, and keeps the
computer awake while a phone is connected.

## Tests

```bash
cd desktop
npm run test:e2e            # dev app: server + agent + two simulated phones at once
npm run test:e2e:packaged   # same against the built installer app in dist/
```

## Known limitations (v1)

- No audio or file transfer yet.
- Windows: can't control UAC prompts or the lock screen (needs a Windows service).
- macOS: the login screen can't be controlled (Apple restriction for non-system apps).
- `react-native-webrtc` runs through RN's New Architecture interop layer (flagged by `expo-doctor`).
