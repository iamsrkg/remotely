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
| Mac agent | ⚠️ `.dmg` builds in CI, **never run on a Mac** |
| Phone app (iOS + Android) | ⚠️ APK + unsigned IPA build in CI. **Never run on a device yet** |
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

### Easiest: download the prebuilt files (free, personal use)
GitHub → **Actions → Build all apps → latest run → Artifacts** (or *Run workflow* to build fresh). You get:

| Artifact | Install |
|---|---|
| `remotely-windows` (.exe) | Run it → SmartScreen *More info → Run anyway* |
| `remotely-mac` (.dmg) | Drag to Applications → open → System Settings → Privacy & Security → *Open Anyway* → grant Screen Recording + Accessibility |
| `remotely-android` (.apk) | Copy to phone, open, allow "install unknown apps" |
| `remotely-iphone-unsigned` (.ipa) | Sign with a **free Apple ID** using Sideloadly or AltStore (Mac or Windows), or Xcode. Free signing expires every 7 days — re-sign to refresh |

No developer subscription is needed for any of these. The paid Apple account only removes the 7-day limit.

### Building yourself

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

## 7. Audit: limits, edge cases, security

### Fixed in the audit (2026-10-28)
- Phone trackpad cursor drifted when the computer's mouse moved → agent now streams cursor position (`cursor` msg); phone follows it except while your finger is down.
- Video froze when a monitor was unplugged / resolution changed → capture auto-recovers and the phone gets the new monitor list.
- Pairing secrets were stored unencrypted on the phone → moved to iOS Keychain / Android Keystore (`expo-secure-store`), with migration.
- "Copy pairing code" left the secret in the clipboard → auto-cleared after 60 s.
- No visible alert when a phone connects → desktop notification + tray icon turns green.
- Android keyboard suggestions garbled typed text → composition disabled on the hidden input.
- Clipboard read crash, video-quality race (found by the E2E test).

### What "full control" cannot do (OS restrictions, not bugs)
| Situation | Windows | macOS |
|---|---|---|
| UAC "Yes/No" prompt (secure desktop) | Screen goes black, input blocked | n/a |
| Apps running **as Administrator** | Can see them, but clicks/keys are ignored (Windows UIPI) | n/a |
| Lock screen / login screen | Not controllable (agent runs only while you're logged in) | Not controllable |
| Ctrl+Alt+Del | Impossible to send | n/a |
| Computer asleep / lid closed | Offline (no wake-on-LAN yet) | Offline |
| Permissions | Firewall prompt on first run (allow **Private**) | Screen Recording + Accessibility must be granted once; macOS 15+ re-asks for Screen Recording periodically |
Fixing UAC/admin apps/lock screen needs a Windows service running as SYSTEM (future work).

### Edge cases / possible glitches (not yet verified on devices)
- `react-native-webrtc` is the biggest risk (flagged for RN New Architecture): black video or crash on open.
- Android: video uses SurfaceViews; in the "All computers" grid they may draw over the header while scrolling, and pinch-zoom can briefly flash black as the view resizes.
- The local cursor dot leads the cursor in the video by the stream latency (two cursors briefly visible) — by design for responsiveness.
- If the computer's IP changes, the phone's saved LAN address is stale: it falls back to the internet server, or fails if none is set. Re-scan the QR.
- Network drop → phone shows "Reconnecting…" then "Couldn't connect"; tap Retry (no automatic ICE restart yet).
- Mobile data without a TURN server: connection will often fail.
- Two phones controlling the same computer at once will fight over the mouse (allowed on purpose).
- Typing emoji / non-Latin text may not work everywhere (depends on nut.js and keyboard layout); scroll speed on macOS may feel different from Windows.
- The pairing QR includes every network adapter's IP (incl. VPN/virtual adapters); harmless, slightly slower discovery.

### Security model and remaining risks
- **Whoever has the QR / pairing code has full, silent-able control** (mouse, keyboard, clipboard, screen) until you click **Unpair all phones**. Treat it like a password; don't screenshot it.
- Relays (LAN + server) are untrusted: every signaling message is HMAC-SHA256 signed, timestamped, nonce-checked; a hostile server can't forge offers or swap DTLS fingerprints (no MITM). Video/input are end-to-end encrypted by WebRTC (DTLS-SRTP).
- Desktop secret is stored in plain JSON in the user profile (`%APPDATA%/Remotely/config.json`, `~/Library/Application Support/Remotely/config.json`). Anyone with access to your user account could read it.
- No per-connection approval prompt: a paired phone connects without asking (you get a notification). Add an "Ask before allowing" option if needed.
- A paired phone can read the computer's clipboard at any time (passwords copied there are exposed to it).
- LAN relay (port 47800) is reachable by anyone on the network but can't do anything without the secret; it could be spammed (no rate limiting). Same for the server.
- Server's device-ID ownership is in memory (resets on restart); someone who knows your 9-digit ID could block (not hijack) internet access until the agent reconnects.
- Desktop builds are unsigned (SmartScreen / Gatekeeper warnings).

## 8. Suggested next steps

1. Build + device-test Android and iPhone (§4); fix whatever device testing finds.
2. Run the Mac agent on a Mac; verify permissions flow and Retina coordinate mapping.
3. Deploy `server/` + TURN; test from mobile data.
4. Code signing: Windows (Authenticode cert → `CSC_LINK`/`CSC_KEY_PASSWORD` secrets), macOS (Developer ID + notarization).
5. Features: audio, file transfer, Windows service for UAC/lock screen, wake-on-LAN, app icons.
