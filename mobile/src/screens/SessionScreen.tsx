import { ComponentRef, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  GestureResponderEvent,
  Keyboard,
  Platform,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { RTCView } from 'react-native-webrtc';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useKeepAwake } from 'expo-keep-awake';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Device } from '../lib/devices';
import { Hello, InputMsg, RemoteSession, ScreenInfo, Status } from '../lib/connection';
import { closeSession, getSession, restartSession } from '../lib/sessions';
import { colors } from '../theme';

type Mode = 'trackpad' | 'touch';
type Viewport = { z: number; ox: number; oy: number };
type Pt = { x: number; y: number };

const SLOP = 8;
const LONG_PRESS_MS = 450;
const TAP_MS = 350;
const SCROLL_STEP_PX = 14;
const MAX_ZOOM = 5;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const centroid = (t: Pt[]): Pt => ({
  x: t.reduce((s, p) => s + p.x, 0) / t.length,
  y: t.reduce((s, p) => s + p.y, 0) / t.length,
});
const spread = (t: Pt[]) => (t.length < 2 ? 0 : Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y));

type Props = {
  device: Device;
  onExit: () => void;
  /** Keep the connection alive (as a thumbnail) after leaving, e.g. when opened from "All computers". */
  keepAlive?: boolean;
};

export default function SessionScreen({ device, onExit, keepAlive }: Props) {
  useKeepAwake();
  const insets = useSafeAreaInsets();

  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<{ s: Status; detail?: string }>({ s: 'finding' });
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [hello, setHello] = useState<Hello | null>(null);
  const [screen, setScreen] = useState<ScreenInfo | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('trackpad');
  const [view, setView] = useState<Viewport>({ z: 1, ox: 0, oy: 0 });
  const [cursor, setCursor] = useState<Pt>({ x: 0.5, y: 0.5 });
  const [layout, setLayout] = useState({ cw: 0, ch: 0 });
  const [kbOpen, setKbOpen] = useState(false);
  const [kbHeight, setKbHeight] = useState(0);
  const [mods, setMods] = useState<string[]>([]);
  const [showScreens, setShowScreens] = useState(false);
  const [showClip, setShowClip] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };

  const sessionRef = useRef<RemoteSession | null>(null);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const overlayRef = useRef<ComponentRef<typeof View>>(null);

  // Mirrors of state for the (stable) PanResponder callbacks.
  const r = useRef({
    mode: 'trackpad' as Mode,
    view: { z: 1, ox: 0, oy: 0 } as Viewport,
    cursor: { x: 0.5, y: 0.5 } as Pt,
    layout: { cw: 0, ch: 0, px: 0, py: 0 },
    screen: { w: 16, h: 9 },
    touching: false,
    lastLocalMove: 0,
  });
  r.current.mode = mode;

  const send = (m: InputMsg) => sessionRef.current?.send(m);

  // ---------- connection lifecycle ----------
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const s: RemoteSession = attempt === 0 ? getSession(device) : restartSession(device);
    sessionRef.current = s;
    // Pick up where the session already is (it may have been live in "All computers").
    const snap = s.snap;
    setStatus({ s: snap.status, detail: snap.detail });
    setStreamUrl(snap.streamUrl);
    setHello(snap.hello);
    setLatency(snap.latency);
    if (snap.screen) applyScreen(snap.screen, snap.cursor);
    s.send({ t: 'quality', q: 'full' });
    const unsubscribe = s.subscribe({
      onStatus: (st, detail) => setStatus({ s: st, detail }),
      onStream: setStreamUrl,
      onHello: (h) => {
        setHello(h);
        applyScreen(h.screen, h.cursor);
        s.send({ t: 'quality', q: 'full' });
      },
      onScreen: applyScreen,
      onLatency: setLatency,
      onCursor: (c) => {
        // Follow mouse moves made on the computer, but never fight the user's own finger.
        if (r.current.touching || Date.now() - r.current.lastLocalMove < 600) return;
        const cur = { x: clamp01(c.x), y: clamp01(c.y) };
        r.current.cursor = cur;
        setCursor(cur);
      },
      onClipboard: (text) => {
        Clipboard.setStringAsync(text)
          .then(() => flash(text ? 'Computer clipboard copied to phone' : 'Computer clipboard is empty'))
          .catch(() => flash('Could not write phone clipboard'));
      },
    });
    return () => {
      unsubscribe();
      if (keepAlive) s.send({ t: 'quality', q: 'thumb' });
      else closeSession(device.id);
    };
  }, [device, attempt]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKbHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKbHeight(0);
      setKbOpen(false);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  function applyScreen(s: ScreenInfo, c: Pt) {
    setScreen(s);
    r.current.screen = { w: s.w || 16, h: s.h || 9 };
    const cur = { x: clamp01(c?.x ?? 0.5), y: clamp01(c?.y ?? 0.5) };
    r.current.cursor = cur;
    setCursor(cur);
    updateView({ z: 1, ox: 0, oy: 0 });
  }

  // ---------- geometry ----------
  function geom() {
    const { cw, ch } = r.current.layout;
    const { w, h } = r.current.screen;
    const a = w / h;
    const fitWide = cw / Math.max(1, ch) > a;
    const bw = fitWide ? ch * a : cw;
    const bh = fitWide ? ch : cw / a;
    return { cw, ch, bw, bh, ...r.current.view };
  }

  function updateView(v: Viewport) {
    const { cw, ch, bw, bh } = geom();
    const z = Math.min(MAX_ZOOM, Math.max(1, v.z));
    const w = bw * z;
    const h = bh * z;
    const ox = w <= cw ? (cw - w) / 2 : Math.min(0, Math.max(cw - w, v.ox));
    const oy = h <= ch ? (ch - h) / 2 : Math.min(0, Math.max(ch - h, v.oy));
    r.current.view = { z, ox, oy };
    setView(r.current.view);
  }

  function toNorm(p: Pt): Pt {
    const { bw, bh, z, ox, oy } = geom();
    return { x: clamp01((p.x - ox) / (bw * z)), y: clamp01((p.y - oy) / (bh * z)) };
  }

  function setRemoteCursor(n: Pt) {
    r.current.lastLocalMove = Date.now();
    r.current.cursor = n;
    setCursor(n);
    send({ t: 'move', x: n.x, y: n.y });
  }

  function moveCursorBy(dx: number, dy: number) {
    const { bw, bh, z, cw, ch, ox, oy } = geom();
    const accel = 1.2 + Math.min(Math.hypot(dx, dy) / 12, 2);
    const c = r.current.cursor;
    const n = { x: clamp01(c.x + (dx * accel) / (bw * z)), y: clamp01(c.y + (dy * accel) / (bh * z)) };
    setRemoteCursor(n);
    if (z > 1) {
      // Keep the cursor in view while zoomed.
      const m = 48;
      const px = ox + n.x * bw * z;
      const py = oy + n.y * bh * z;
      let nox = ox;
      let noy = oy;
      if (px < m) nox += m - px;
      if (px > cw - m) nox -= px - (cw - m);
      if (py < m) noy += m - py;
      if (py > ch - m) noy -= py - (ch - m);
      if (nox !== ox || noy !== oy) updateView({ z, ox: nox, oy: noy });
    }
  }

  function zoomAt(c: Pt, ratio: number) {
    const { bw, bh, z, ox, oy } = geom();
    const nz = Math.min(MAX_ZOOM, Math.max(1, z * ratio));
    const ux = (c.x - ox) / (bw * z);
    const uy = (c.y - oy) / (bh * z);
    updateView({ z: nz, ox: c.x - ux * bw * nz, oy: c.y - uy * bh * nz });
  }

  // ---------- gestures ----------
  const g = useRef({
    start: 0,
    startPts: [] as Pt[],
    count: 0,
    maxF: 0,
    origin: { x: 0, y: 0 } as Pt,
    originSpread: 0,
    last: { x: 0, y: 0 } as Pt,
    lastSpread: 0,
    moved: false,
    dragging: false,
    longFired: false,
    kind: null as null | 'pinch' | 'scroll',
    sx: 0,
    sy: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
  }).current;

  const touches = (e: GestureResponderEvent): Pt[] =>
    e.nativeEvent.touches.map((t) => ({ x: t.pageX - r.current.layout.px, y: t.pageY - r.current.layout.py }));

  const clearLong = () => {
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
  };

  const rebase = (t: Pt[]) => {
    g.count = t.length;
    g.maxF = Math.max(g.maxF, t.length);
    g.origin = g.last = centroid(t);
    g.originSpread = g.lastSpread = spread(t);
    g.kind = null;
    g.sx = g.sy = 0;
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          r.current.touching = true;
          const t = touches(e);
          g.start = Date.now();
          g.startPts = t;
          g.maxF = 0;
          g.moved = false;
          g.dragging = false;
          g.longFired = false;
          rebase(t);
          clearLong();
          g.timer = setTimeout(() => {
            if (g.moved || g.count !== 1) return;
            g.longFired = true;
            if (r.current.mode === 'trackpad') {
              send({ t: 'down', b: 'left' });
              g.dragging = true;
            } else {
              setRemoteCursor(toNorm(g.startPts[0]));
              send({ t: 'click', b: 'right' });
            }
          }, LONG_PRESS_MS);
        },
        onPanResponderMove: (e) => {
          const t = touches(e);
          if (!t.length) return;
          if (t.length !== g.count) {
            if (t.length > 1) clearLong();
            rebase(t);
            return;
          }
          const c = centroid(t);
          const d = spread(t);
          const dx = c.x - g.last.x;
          const dy = c.y - g.last.y;
          if (!g.moved && (Math.hypot(c.x - g.origin.x, c.y - g.origin.y) > SLOP || Math.abs(d - g.originSpread) > SLOP)) {
            g.moved = true;
            clearLong();
          }
          if (g.moved) {
            if (t.length === 1) {
              if (r.current.mode === 'trackpad') moveCursorBy(dx, dy);
              else if (!g.longFired) {
                if (!g.dragging) {
                  setRemoteCursor(toNorm(g.origin));
                  send({ t: 'down', b: 'left' });
                  g.dragging = true;
                }
                setRemoteCursor(toNorm(c));
              }
            } else if (t.length === 2) {
              if (!g.kind) g.kind = Math.abs(d - g.originSpread) > 24 ? 'pinch' : 'scroll';
              if (g.kind === 'pinch') {
                if (g.lastSpread > 0) zoomAt(c, d / g.lastSpread);
                const v = r.current.view;
                updateView({ z: v.z, ox: v.ox + dx, oy: v.oy + dy });
              } else {
                g.sx += dx;
                g.sy += dy;
                const stepY = Math.trunc(g.sy / SCROLL_STEP_PX);
                const stepX = Math.trunc(g.sx / SCROLL_STEP_PX);
                if (stepY || stepX) {
                  // Natural scrolling: fingers up => content scrolls down.
                  send({ t: 'scroll', dx: -stepX, dy: -stepY });
                  g.sx -= stepX * SCROLL_STEP_PX;
                  g.sy -= stepY * SCROLL_STEP_PX;
                }
              }
            }
          }
          g.last = c;
          g.lastSpread = d;
        },
        onPanResponderRelease: () => finish(),
        onPanResponderTerminate: () => finish(),
      }),
    []
  );

  function finish() {
    r.current.touching = false;
    clearLong();
    if (g.dragging) {
      send({ t: 'up', b: 'left' });
      g.dragging = false;
      return;
    }
    if (g.moved || g.longFired || Date.now() - g.start > TAP_MS) return;
    const touchMode = r.current.mode === 'touch';
    if (touchMode && g.startPts[0]) setRemoteCursor(toNorm(g.startPts[0]));
    if (g.maxF >= 3) send({ t: 'click', b: 'middle' });
    else if (g.maxF === 2) send({ t: 'click', b: 'right' });
    else send({ t: 'click', b: 'left' });
  }

  // ---------- keyboard ----------
  const toggleMod = (m: string) => setMods((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));

  const sendKey = (k: string) => {
    send({ t: 'key', k, mods });
    setMods([]);
  };

  const onText = (text: string) => {
    if (!text) return;
    if (mods.length && text.length === 1 && /[a-z0-9]/i.test(text)) sendKey(text.toLowerCase());
    else send({ t: 'text', s: text });
    inputRef.current?.clear();
  };

  const toggleKeyboard = () => {
    if (kbOpen) {
      inputRef.current?.blur();
      Keyboard.dismiss();
      setKbOpen(false);
    } else {
      setKbOpen(true);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const metaLabel = hello?.platform === 'darwin' ? '⌘' : 'Win';
  const keys: [string, string, boolean?][] = [
    ['Esc', 'escape'],
    ['Tab', 'tab'],
    ['Ctrl', 'ctrl', true],
    ['Alt', 'alt', true],
    ['Shift', 'shift', true],
    [metaLabel, 'meta', true],
    ['←', 'left'],
    ['↑', 'up'],
    ['↓', 'down'],
    ['→', 'right'],
    ['Del', 'delete'],
    ['Home', 'home'],
    ['End', 'end'],
    ['PgUp', 'pageup'],
    ['PgDn', 'pagedown'],
    ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `f${i + 1}`] as [string, string]),
  ];

  // ---------- render ----------
  const { bw, bh } = geom();
  const connected = status.s === 'connected' && !!streamUrl;
  const cursorPx = { x: view.ox + cursor.x * bw * view.z, y: view.oy + cursor.y * bh * view.z };

  return (
    <View
      style={styles.root}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        r.current.layout.cw = width;
        r.current.layout.ch = height;
        setLayout({ cw: width, ch: height });
        overlayRef.current?.measureInWindow((px: number, py: number) => {
          r.current.layout.px = px;
          r.current.layout.py = py;
        });
        updateView(r.current.view);
      }}
    >
      {streamUrl && layout.cw > 0 && (
        <RTCView
          streamURL={streamUrl}
          objectFit="contain"
          style={{ position: 'absolute', left: view.ox, top: view.oy, width: bw * view.z, height: bh * view.z }}
          zOrder={0}
        />
      )}

      <View ref={overlayRef} style={StyleSheet.absoluteFill} {...responder.panHandlers} />

      {connected && mode === 'trackpad' && (
        <View pointerEvents="none" style={[styles.cursor, { left: cursorPx.x - 7, top: cursorPx.y - 7 }]} />
      )}

      {!connected && (
        <View style={styles.overlay} pointerEvents="box-none">
          {status.s === 'failed' ? (
            <>
              <Text style={styles.overlayTitle}>Couldn't connect</Text>
              <Text style={styles.overlayText}>{status.detail}</Text>
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                <Pressable style={styles.btn} onPress={onExit}>
                  <Text style={styles.btnText}>Back</Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => setAttempt((a) => a + 1)}>
                  <Text style={styles.btnText}>Retry</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <ActivityIndicator color={colors.text} size="large" />
              <Text style={styles.overlayText}>
                {status.s === 'finding'
                  ? `Looking for ${device.name}…`
                  : status.s === 'reconnecting'
                    ? 'Reconnecting…'
                    : `Connecting (${status.detail ?? ''})…`}
              </Text>
              <Pressable style={styles.btn} onPress={onExit}>
                <Text style={styles.btnText}>Cancel</Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      {/* Toolbar */}
      <View style={[styles.toolbar, { top: 8, left: Math.max(8, insets.left) }]}>
        <ToolButton label="✕" onPress={onExit} />
        <ToolButton label={mode === 'trackpad' ? 'Trackpad' : 'Touch'} onPress={() => setMode(mode === 'trackpad' ? 'touch' : 'trackpad')} />
        <ToolButton label="⌨" active={kbOpen} onPress={toggleKeyboard} />
        {view.z > 1 && <ToolButton label="1×" onPress={() => updateView({ z: 1, ox: 0, oy: 0 })} />}
        {(hello?.screens.length ?? 0) > 1 && <ToolButton label="🖥" onPress={() => setShowScreens((v) => !v)} />}
        {connected && <ToolButton label="📋" active={showClip} onPress={() => setShowClip((v) => !v)} />}
        {connected && (
          <Text style={styles.stat}>
            {sessionRef.current?.via === 'lan' ? 'Wi-Fi' : 'Internet'}
            {latency != null ? ` · ${latency} ms` : ''}
          </Text>
        )}
      </View>

      {showScreens && hello && (
        <View style={[styles.screens, { left: Math.max(8, insets.left) }]}>
          {hello.screens.map((s, i) => (
            <Pressable
              key={s.id}
              style={[styles.screenItem, screen?.id === s.id && styles.screenItemActive]}
              onPress={() => {
                send({ t: 'screen', id: s.id });
                setShowScreens(false);
              }}
            >
              <Text style={styles.btnText}>
                {s.name || `Screen ${i + 1}`} ({s.w}×{s.h})
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {showClip && (
        <View style={[styles.screens, { left: Math.max(8, insets.left) }]}>
          <Pressable
            style={styles.screenItem}
            onPress={async () => {
              setShowClip(false);
              const text = await Clipboard.getStringAsync().catch(() => '');
              if (!text) return flash('Phone clipboard is empty');
              send({ t: 'clip-set', s: text });
              flash('Sent to computer clipboard — paste with Ctrl/⌘+V');
            }}
          >
            <Text style={styles.btnText}>Phone → computer clipboard</Text>
          </Pressable>
          <Pressable
            style={styles.screenItem}
            onPress={() => {
              setShowClip(false);
              send({ t: 'clip-get' });
            }}
          >
            <Text style={styles.btnText}>Computer → phone clipboard</Text>
          </Pressable>
        </View>
      )}

      {toast && (
        <View pointerEvents="none" style={styles.toast}>
          <Text style={styles.btnText}>{toast}</Text>
        </View>
      )}

      {/* Hidden input that drives the soft keyboard */}
      <TextInput
        ref={inputRef}
        style={styles.hiddenInput}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        // Android keyboards compose words with suggestions, which garbles text when the field is cleared
        // after every character; "visible-password" turns composition off.
        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
        submitBehavior="submit"
        onChangeText={onText}
        onSubmitEditing={() => sendKey('enter')}
        onKeyPress={(e) => {
          if (e.nativeEvent.key === 'Backspace') sendKey('backspace');
        }}
      />

      {kbOpen && (
        <View style={[styles.keybar, { bottom: kbHeight }]}>
          <ScrollView horizontal keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 6, paddingHorizontal: 8 }}>
            {keys.map(([label, k, isMod]) => (
              <Pressable
                key={k}
                style={[styles.key, isMod && mods.includes(k) && styles.keyActive]}
                onPress={() => (isMod ? toggleMod(k) : sendKey(k))}
              >
                <Text style={styles.keyText}>{label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

function ToolButton({ label, onPress, active }: { label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable style={[styles.tool, active && styles.toolActive]} onPress={onPress} hitSlop={6}>
      <Text style={styles.toolText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  cursor: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(79,140,255,0.5)',
  },
  overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  overlayTitle: { color: colors.text, fontSize: 20, fontWeight: '600' },
  overlayText: { color: colors.muted, textAlign: 'center', maxWidth: 420 },
  btn: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 },
  btnPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  btnText: { color: colors.text, fontWeight: '500' },
  toolbar: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 6 },
  tool: { backgroundColor: 'rgba(24,27,34,0.85)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  toolActive: { backgroundColor: colors.accent },
  toolText: { color: colors.text, fontSize: 14 },
  stat: { color: colors.muted, fontSize: 12, marginLeft: 4 },
  screens: { position: 'absolute', top: 48, backgroundColor: colors.card, borderRadius: 10, padding: 6, gap: 4 },
  screenItem: { padding: 10, borderRadius: 8 },
  screenItemActive: { backgroundColor: colors.line },
  toast: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    backgroundColor: 'rgba(24,27,34,0.95)',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -10, top: -10 },
  keybar: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(15,17,21,0.95)', paddingVertical: 6 },
  key: { backgroundColor: colors.card, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8, minWidth: 40, alignItems: 'center' },
  keyActive: { backgroundColor: colors.accent },
  keyText: { color: colors.text, fontSize: 14 },
});
