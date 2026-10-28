# Remotely — Handoff

Status as of **2026-10-28**. Read this first; `README.md` has the user-facing overview.

## 1. What this is

Control a **Mac** and a **Windows PC** from an **iPhone** or **Android phone**, on the same Wi-Fi or over the internet.
One phone can watch every paired computer live at once and take full control of any of them; several phones can
be connected to the same computer at the same time.

| Part | Path | Stack |
|---|---|---|
| Desktop agent (Mac + Windows) | `desktop/` | Electron 45, `@nut-tree-fork/nut-js` (input), `ws`, `qrcode` |
| Phone app (iOS + Android) | `mobile/` | Expo SDK 58, React Native 0.88, `react-native-webrtc`, `expo-camera`, `expo-clipboard` |
| Signaling server (internet access) | `server/` | Node + `ws`, Docker-ready |

## 2. Status — what is verified and what is not

| Item | Status |
|---|---|
| Windows agent (dev + packaged installer) | ✅ Built and E2E-tested on Windows 11 (see §6) |
| Windows installer `Remotely Setup 1.0.0.exe` | ✅ Builds locally (`npm run dist:win`). **Unsigned** → SmartScreen warning |
| LAN path (same Wi-Fi) | ✅ E2E-tested |
| Internet path via `server/` | ✅ E2E-tested against a local server. Not yet deployed anywhere |
| Two phones on one computer at once | ✅ E2E-tested |
| Clipboard sync (both directions) | ✅ E2E-tested (agent side) |
| Signed handshake / forged-offer rejection | ✅ E2E-tested |
| Mac agent | ⚠️ Code complete, **never run on a Mac**. CI workflow builds the `.dmg` on `macos-latest` |
| Phone app (iOS + Android) | ⚠️ Code complete and type-checks (`tsc` clean, `expo-doctor` 19/20). **Never built or run on a device** — this PC has no Android SDK/Xcode |
| TURN relay | ❌ Not set up. Needed for strict NATs / mobile data (see §5) |
| Code signing (Windows/macOS), App Store / Play Store | ❌ Not done |

**The first job for whoever picks this up: build the phone app and test it on real devices (§4).**

## 3. Architecture

```
 Phone (mobile/)                                     Computer (desktop/)
 ┌─────────────────────────┐   WebRTC video (H.264/VP8) ┌──────────────────────────┐
 │ AllScreen: live tiles   │ ◀───────────────────────── │ renderer/app.js          │
 │ SessionScreen: control  │ ─────────────────────────▶ │  Session per phone       │
 │ lib/sessions.ts (1/PC)  │   data channel "input"     │  getDisplayMedia capture │
 └───────────┬─────────────┘                            │ main/input.js (nut.js)   │
             │ signed signaling                         └────────────┬─────────────┘
             ├── ws://<lan-ip>:47800  ← agent's own relay (main/relay.js) ─┘
             └── wss://<server>       ← server/relay.js (same code)  ──────┘
```

- **Pairing:** the agent shows a QR = base64url JSON `{v, id, s(secret), n(name), lan[], srv}`.
- **Signaling:** both relays run the same `relay.js` (`server/relay.js` is canonical; `desktop/scripts/copy-relay.js` copies it before start/build).
  The relay is untrusted: every payload is `HMAC-SHA256(secret)` signed with timestamp + nonce
  (`desktop/src/renderer/protocol.js` ⇄ `mobile/src/lib/protocol.ts`, verified byte-identical).
  The agent registers with `key = HMAC(secret, "register:"+id)`; the server pins the first key per ID (TOFU, in-memory).
- **Connection choice:** the phone tries every LAN address in parallel, gives the LAN a 600 ms head start, then the server; first relay that reports the agent online wins.
- **Media:** the phone offers recv-only video + an ordered data channel. The agent answers with a screen track.
  Quality tiers: `full` (≤1920px, 8 Mbps, 30 fps) while controlling, `thumb` (⅓ scale, 600 kbps, 10 fps) in the overview.
- **Input protocol** (phone → agent, JSON over data channel): `move{x,y}` (normalized 0–1), `down/up{b}`, `click{b,n}`,
  `scroll{dx,dy}`, `text{s}`, `key{k,mods[]}`, `screen{id}`, `quality{q}`, `clip-get`, `clip-set{s}`, `ping{ts}`.
  Agent → phone: `hello`, `screen`, `clip`, `pong`. The agent tags each input with the display that phone is viewing.

### Key files

| File | Purpose |
|---|---|
| `desktop/src/main/main.js` | Window, tray, start-at-login, LAN relay, IPC, keep-awake while connected |
| `desktop/src/main/input.js` | Mouse/keyboard injection; DIP→physical pixel mapping on Windows |
| `desktop/src/renderer/app.js` | Signaling clients, multi-session WebRTC, UI |
| `mobile/src/lib/connection.ts` | `RemoteSession`: relay discovery, WebRTC, events + snapshot |
| `mobile/src/lib/sessions.ts` | One live session per computer, shared across screens |
| `mobile/src/screens/SessionScreen.tsx` | Full control: gestures, zoom, keyboard bar, clipboard, monitor switch |
| `mobile/src/screens/AllScreen.tsx` | Live overview of all computers |

## 4. Getting it onto all four devices

### Windows PC
```bash
cd desktop && npm install && npm run dist:win     # → desktop/dist/Remotely Setup 1.0.0.exe
```
Run the installer (SmartScreen: *More info → Run anyway* until it's signed). On first launch allow it through the
firewall on **Private** networks.

### Mac
Either build on the Mac (`cd desktop && npm install && npm run dist:mac` → `desktop/dist/*.dmg`), or run the GitHub
Action **Desktop installers** (Actions tab → *Run workflow*) and download the `remotely-macos-latest` artifact.
Unsigned app: right-click → **Open** the first time. Then grant **Screen Recording** and **Accessibility** in
System Settings → Privacy & Security, and restart Remotely.

### Android
No Android Studio needed — build in Expo's cloud:
```bash
cd mobile && npm install
npx eas-cli@latest login          # free Expo account
npx eas-cli@latest build -p android --profile preview    # → installable .apk link/QR
```
(`development` profile = dev client for live reload with `npx expo start`.)

### iPhone
Needs an **Apple Developer account ($99/yr)** for installing outside the App Store via EAS:
```bash
npx eas-cli@latest device:create                     # register your iPhone (once)
npx eas-cli@latest build -p ios --profile preview    # → install link
```
Free alternative: on the Mac with Xcode, `npx expo run:ios --device` signs with a personal team (app expires after 7 days).

## 5. Internet access (deploy the server)

1. Deploy `server/` to any host that gives you HTTPS/WSS (Fly.io, Render, Railway, a VPS behind Caddy/nginx).
   Docker: `docker build -t remotely-server server && docker run -p 8080:8080 remotely-server`. Health check: `GET /health`.
2. In the desktop app: **Settings → Signaling server** = `wss://your-host`, **Save**, then **re-scan the QR** on each phone.
3. For phones on mobile data / strict NATs add a TURN server (coturn or a hosted provider) and set
   `TURN_URLS` + `TURN_SECRET` (or `TURN_USERNAME`/`TURN_CREDENTIAL`) on the server. Without TURN, some networks will
   show "Connection failed. A TURN server may be needed".

## 6. Tests

```bash
cd desktop
npm run test:e2e            # dev app
npm run test:e2e:packaged   # the built app in dist/
```
Starts the server + an agent with a throwaway identity, then two simulated phones at once (Wi-Fi + internet).
Checks: signed handshake, forged offer rejected, video frames arrive, mouse lands on the target pixel, clipboard
round-trip, first phone still works while the second connects. **It moves your mouse** and briefly uses the clipboard
(restored after). Last result on Windows 11: `ALL E2E TESTS PASSED`.

Phone app checks: `cd mobile && npx tsc --noEmit && npx expo-doctor`.

## 7. Known issues / risks

- `react-native-webrtc` is flagged by `expo-doctor` as untested on RN's New Architecture (runs via interop). If the
  build fails or video is black on device, this is the first suspect.
- Windows: UAC prompts, the lock screen, and Ctrl+Alt+Del can't be controlled (needs a Windows service running as SYSTEM).
- macOS: login screen can't be controlled; permissions must be granted by hand once.
- Server's ID ownership (TOFU) is in memory — restarting the server resets it (harmless, but not hardened).
- Default Electron icon is used; no app icons/branding yet.
- `npx expo export` crashed on this PC with an out-of-memory error (`VirtualAlloc failed`) — environment issue, not reproduced elsewhere.

## 8. Suggested next steps

1. Build + device-test Android and iPhone (§4); fix whatever device testing finds.
2. Run the Mac agent on a Mac; verify permissions flow and Retina coordinate mapping.
3. Deploy `server/` + TURN; test from mobile data.
4. Code signing: Windows (Authenticode cert → `CSC_LINK`/`CSC_KEY_PASSWORD` secrets), macOS (Developer ID + notarization).
5. Features: audio, file transfer, Windows service for UAC/lock screen, wake-on-LAN, app icons.
