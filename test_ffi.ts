import ffi from 'ffi-napi';
import ref from 'ref-napi';

// Types
const int = ref.types.int;
const long = ref.types.long;
const void = ref.types.void;
const bool = ref.types.bool;
const string = ref.types.string;
const voidPtr = ref.refType(void);
const intPtr = ref.refType(int);
const longPtr = ref.refType(long);

// Struct for RECT
const RECT = StructType({
  left: long,
  top: long,
  right: long,
  bottom: long,
});

// Load user32.dll
const user32 = ffi.Library('user32', {
  EnumWindows: [bool, [ffi.Function(bool, [long, longPtr]), longPtr]],
  GetWindowTextLengthW: [int, [long]],
  GetWindowTextW: [int, [long, string, int]],
  GetWindowRect: [bool, [long, ref.refType(RECT)]],
  GetClientRect: [bool, [long, ref.refType(RECT)]],
  ClientToScreen: [bool, [long, ref.refType(POINT)]],
});

// Struct for POINT
const POINT = StructType({
  x: long,
  y: long,
});

// Callback for EnumWindows
const windows: Array<{ hwnd: number; title: string; rect: typeof RECT }> = [];

const enumProc = ffi.Callback(bool, [long, longPtr], (hwnd: number, lParam: number) => {
  const length = user32.GetWindowTextLengthW(hwnd);
  if (length > 0 && length < 256) {
    const buffer = Buffer.alloc(length * 2 + 2);
    user32.GetWindowTextW(hwnd, buffer, length + 1);
    const title = buffer.toString('utf16le').replace(/\0/g, '');

    if (title.toLowerCase().includes('weixin') || title.includes('微信')) {
      const rect = new RECT();
      if (user32.GetWindowRect(hwnd, rect.ref())) {
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        if (width > 100 && height > 100) {
          // Get client rect
          const clientRect = new RECT();
          if (user32.GetClientRect(hwnd, clientRect.ref())) {
            const point = new POINT({ x: 0, y: clientRect.bottom });
            if (user32.ClientToScreen(hwnd, point.ref())) {
              const clientWidth = clientRect.right - clientRect.left;
              const clientHeight = clientRect.bottom - clientRect.top;

              if (clientWidth > 100 && clientHeight > 100) {
                windows.push({
                  hwnd,
                  title,
                  rect: { left: rect.left, top: point.y, right: clientWidth, bottom: clientHeight },
                });
              }
            }
          }

          // Fallback to window rect
          if (windows.length === 0 || !windows[windows.length - 1]?.rect) {
            windows.push({
              hwnd,
              title,
              rect: { left: rect.left, top: rect.top, right: width, bottom: height },
            });
          }
        }
      }
    }
  }
  return true;
});

// Find WeChat window
user32.EnumWindows(enumProc, 0);

// Print results
console.log('=== All WeChat windows ===');
for (const win of windows) {
  const area = win.rect.right * win.rect.bottom;
  console.log(`${win.title}|${win.hwnd}|${win.rect.left},${win.rect.top}|${win.rect.right}x${win.rect.bottom}|area=${area}`);
}

// Select best window (Chinese title on right side)
let best = windows[0];
let bestScore = -1;

for (const win of windows) {
  const area = win.rect.right * win.rect.bottom;
  const isChinese = win.title.includes('微信');
  const x = win.rect.left;

  let score = area;
  if (isChinese && x > 500) {
    score += 2000000;
  } else if (isChinese) {
    score += 1000000;
  }

  if (score > bestScore) {
    bestScore = score;
    best = win;
  }
}

if (best) {
  console.log('=== Best match ===');
  console.log(`${best.title}|${best.hwnd}|${best.rect.left},${best.rect.top}|${best.rect.right}x${best.rect.bottom}`);
}
