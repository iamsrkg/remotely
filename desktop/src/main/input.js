// Turns controller messages into real mouse/keyboard events.
const { screen } = require('electron');
const { mouse, keyboard, Key, Button, Point } = require('@nut-tree-fork/nut-js');

mouse.config.autoDelayMs = 0;
mouse.config.mouseSpeed = 100000;
keyboard.config.autoDelayMs = 0;

const BUTTONS = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE };
const isMac = process.platform === 'darwin';

const KEYS = {
  enter: Key.Enter,
  escape: Key.Escape,
  tab: Key.Tab,
  backspace: Key.Backspace,
  delete: Key.Delete,
  space: Key.Space,
  up: Key.Up,
  down: Key.Down,
  left: Key.Left,
  right: Key.Right,
  home: Key.Home,
  end: Key.End,
  pageup: Key.PageUp,
  pagedown: Key.PageDown,
  ctrl: Key.LeftControl,
  alt: Key.LeftAlt,
  shift: Key.LeftShift,
  meta: isMac ? Key.LeftCmd : Key.LeftSuper,
};
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = Key[`F${i}`];
for (const c of 'abcdefghijklmnopqrstuvwxyz') KEYS[c] = Key[c.toUpperCase()];
for (let i = 0; i <= 9; i++) KEYS[String(i)] = Key[`Num${i}`];

function display(id) {
  return screen.getAllDisplays().find((d) => String(d.id) === String(id)) || screen.getPrimaryDisplay();
}

function toPoint(x, y, displayId) {
  const { bounds } = display(displayId);
  const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  let p = { x: Math.round(bounds.x + clamp(x) * (bounds.width - 1)), y: Math.round(bounds.y + clamp(y) * (bounds.height - 1)) };
  // nut.js uses physical pixels on Windows; Electron reports DIPs.
  if (process.platform === 'win32') p = screen.dipToScreenPoint(p);
  return new Point(p.x, p.y);
}

function cursor(displayId) {
  const { bounds } = display(displayId);
  const c = screen.getCursorScreenPoint();
  return { x: (c.x - bounds.x) / bounds.width, y: (c.y - bounds.y) / bounds.height };
}

const held = new Set();

async function handle(m) {
  switch (m.t) {
    case 'move':
      return mouse.setPosition(toPoint(m.x, m.y, m.d));
    case 'down':
      if (BUTTONS[m.b]) held.add(m.b);
      return BUTTONS[m.b] && mouse.pressButton(BUTTONS[m.b]);
    case 'up':
      held.delete(m.b);
      return BUTTONS[m.b] && mouse.releaseButton(BUTTONS[m.b]);
    case 'click': {
      const b = BUTTONS[m.b] || Button.LEFT;
      const n = Math.min(3, Math.max(1, m.n | 0));
      for (let i = 0; i < n; i++) await mouse.click(b);
      return;
    }
    case 'scroll': {
      const dy = m.dy | 0;
      const dx = m.dx | 0;
      if (dy > 0) await mouse.scrollDown(Math.min(dy, 50));
      if (dy < 0) await mouse.scrollUp(Math.min(-dy, 50));
      if (dx > 0) await mouse.scrollRight(Math.min(dx, 50));
      if (dx < 0) await mouse.scrollLeft(Math.min(-dx, 50));
      return;
    }
    case 'text':
      if (typeof m.s === 'string' && m.s.length <= 1000) return keyboard.type(m.s);
      return;
    case 'key': {
      const key = KEYS[String(m.k).toLowerCase()];
      if (key === undefined) return;
      const mods = (Array.isArray(m.mods) ? m.mods : []).map((x) => KEYS[x]).filter((x) => x !== undefined);
      await keyboard.pressKey(...mods, key);
      await keyboard.releaseKey(...mods, key);
      return;
    }
  }
}

// Serialize so events apply in order.
let queue = Promise.resolve();
function enqueue(m) {
  queue = queue.then(() => handle(m)).catch((e) => console.error('input error', m && m.t, e.message));
}

async function releaseAll() {
  for (const b of held) await mouse.releaseButton(BUTTONS[b]).catch(() => {});
  held.clear();
}

module.exports = {
  enqueue,
  cursor,
  releaseAll: () => {
    queue = queue.then(releaseAll);
  },
};
