import koffi from 'koffi';
import logger from '../utils/logger';

/**
 * Window boundary information
 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  handle: any; // Window handle (Koffi opaque pointer)
}

/**
 * RECT structure for Windows API
 */
const RECT = koffi.struct('RECT', {
  left: 'int32',
  top: 'int32',
  right: 'int32',
  bottom: 'int32',
});

/**
 * POINT structure for Windows API
 */
const POINT = koffi.struct('POINT', {
  x: 'int32',
  y: 'int32',
});

/**
 * Windows API function definitions
 */
const user32 = koffi.load('user32.dll');

// Window enumeration - callback prototype
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc *proc, intptr_t lParam)');

// Window text functions
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(void *hWnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, uint16 *lpString, int nMaxCount)');

// Window position functions
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(void *hWnd, _Out_ RECT *lpRect)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(void *hWnd, _Inout_ POINT *lpPoint)');

// Window visibility
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hWnd)');

// DPI functions
const GetDC = user32.func('void *__stdcall GetDC(void *hWnd)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(void *hWnd, void *hDC)');
const GetDpiForWindow = user32.func('uint32 __stdcall GetDpiForWindow(void *hwnd)');
const GetDpiForSystem = user32.func('uint32 __stdcall GetDpiForSystem()');

const gdi32 = koffi.load('gdi32.dll');
const GetDeviceCaps = gdi32.func('int __stdcall GetDeviceCaps(void *hdc, int nIndex)');

// Try to load SHCore for monitor-specific DPI (Windows 8.1+)
let GetScaleFactorForMonitor: any = null;
try {
  const shcore = koffi.load('shcore.dll');
  // DEVICE_SCALE_FACTOR enum values: 100, 120, 125, 140, 150, 160, 175, 180, 200, 225, 250, 300, 350, 400, 450, 500
  GetScaleFactorForMonitor = shcore.func('int __stdcall GetScaleFactorForMonitor(void *hMonitor, _Out_ int32 *pScale)');
} catch {
  // SHCore not available on older Windows versions
}

// Window control functions
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hWnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(void *hWnd, int nCmdShow)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(void *hWnd)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)');

// SW_* constants for ShowWindow
const SW_RESTORE = 9;
const SW_SHOW = 5;

// HWND_* constants for SetWindowPos
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_SHOWWINDOW = 0x0040;

/**
 * Window finder using native Windows API via Koffi FFI
 */
export class WindowFinder {
  private windows: WindowBounds[] = [];
  private lastFoundWindowHandle: any = null;

  /**
   * Find the WeChat window with the best score
   */
  findWeChatWindow(): WindowBounds | null {
    this.windows = [];

    // Create callback for window enumeration
    const self = this;
    const callback = (hwnd: unknown, lParam: number): boolean => {
      try {
        // Check if window is visible
        if (!IsWindowVisible(hwnd)) {
          return true; // Continue enumeration
        }

        // Get window title
        const length = GetWindowTextLengthW(hwnd);
        if (length === 0 || length > 255) {
          return true;
        }

        // Allocate buffer for Unicode string (UTF-16)
        const buffer = Buffer.alloc((length + 1) * 2);
        const result = GetWindowTextW(hwnd, buffer, length + 1);

        if (result === 0) {
          return true;
        }

        // Decode UTF-16 string
        const title = buffer.toString('utf16le').replace(/\0/g, '');

        // Check if this is a WeChat window
        if (!self.isWeChatWindow(title)) {
          return true;
        }

        // Get window rectangle (full window including borders)
        const winRect = { left: 0, top: 0, right: 0, bottom: 0 };
        if (!GetWindowRect(hwnd, winRect)) {
          return true;
        }

        const width = winRect.right - winRect.left;
        const height = winRect.bottom - winRect.top;

        // Filter out tiny windows
        if (width < 100 || height < 100) {
          return true;
        }

        // Try to get client area (content area without title bar and borders)
        const clientRect = { left: 0, top: 0, right: 0, bottom: 0 };
        const clientPoint = { x: 0, y: 0 };

        let finalX = winRect.left;
        let finalY = winRect.top;
        let finalWidth = width;
        let finalHeight = height;

        if (GetClientRect(hwnd, clientRect)) {
          const clientWidth = clientRect.right - clientRect.left;
          const clientHeight = clientRect.bottom - clientRect.top;

          clientPoint.x = 0;
          clientPoint.y = 0;
          if (ClientToScreen(hwnd, clientPoint)) {
            if (clientWidth > 100 && clientHeight > 100) {
              finalX = clientPoint.x;
              finalY = clientPoint.y;
              finalWidth = clientWidth;
              finalHeight = clientHeight;
            }
          }
        }

        // Store window information with handle for DPI detection
        self.windows.push({
          x: finalX,
          y: finalY,
          width: finalWidth,
          height: finalHeight,
          title,
          handle: hwnd, // Store the actual window handle
        });

        logger.debug(`Found WeChat window: "${title}" at (${finalX}, ${finalY}) ${finalWidth}x${finalHeight}`);
      } catch (error) {
        logger.error('Error in EnumWindows callback:', error);
      }

      return true; // Continue enumeration
    };

    // Enumerate all windows
    try {
      EnumWindows(callback, 0);
    } catch (error) {
      logger.error('EnumWindows failed:', error);
      return null;
    }

    // Select the best window based on scoring
    return this.selectBestWindow(this.windows);
  }

  /**
   * Check if a window title indicates a WeChat window
   */
  private isWeChatWindow(title: string): boolean {
    if (!title || title.length === 0) {
      return false;
    }

    const lower = title.toLowerCase();
    return (
      lower.includes('weixin') ||
      lower.includes('wechat') ||
      lower.includes('wxtray') ||
      lower.includes('messagetray') ||
      title.includes('微信')
    );
  }

  /**
   * Select the best WeChat window using a scoring algorithm
   * Scoring criteria:
   * - Window area (larger is better)
   * - Chinese title "微信" gets bonus points
   * - Position (windows at x > 500 get higher score for Chinese titles)
   */
  private selectBestWindow(windows: WindowBounds[]): WindowBounds | null {
    if (windows.length === 0) {
      return null;
    }

    if (windows.length === 1) {
      return windows[0];
    }

    let bestWindow = windows[0];
    let bestScore = -1;

    for (const win of windows) {
      const area = win.width * win.height;
      let score = area;

      const isChinese = win.title === '微信';
      if (isChinese && win.x > 500) {
        score += 2000000;
      } else if (isChinese) {
        score += 1000000;
      }

      logger.debug(`Window "${win.title}" score: ${score} (area: ${area}, isChinese: ${isChinese}, x: ${win.x})`);

      if (score > bestScore) {
        bestScore = score;
        bestWindow = win;
      }
    }

    logger.info(`Selected window: "${bestWindow.title}" at (${bestWindow.x}, ${bestWindow.y}) ${bestWindow.width}x${bestWindow.height}`);

    // Save the window handle for DPI detection
    this.lastFoundWindowHandle = bestWindow.handle;

    return bestWindow;
  }

  /**
   * Get DPI scale factor for the last found window
   * Uses intelligent fallback based on screen resolution if APIs fail
   * @returns Scale factor (1.0 = 100%, 1.25 = 125%, 1.5 = 150%, etc.)
   */
  getDpiScaleForLastWindow(): number {
    let scale = this.getDpiScale(this.lastFoundWindowHandle);

    // If API returned 1.0 (default), try to calculate from screen resolution
    if (scale === 1.0) {
      const calculatedScale = this.calculateDpiFromScreenResolution();
      if (calculatedScale !== 1.0) {
        logger.info(`DPI detection failed (returned 100%), using calculated scale from screen resolution: ${calculatedScale} (${Math.round(calculatedScale * 100)}%)`);
        scale = calculatedScale;
      }
    }

    return scale;
  }

  /**
   * Calculate DPI scale by comparing logical screen resolution to known configurations
   * This is a fallback when Windows API doesn't return correct DPI
   */
  private calculateDpiFromScreenResolution(): number {
    try {
      const robot = require('robotjs');
      const screenSize = robot.getScreenSize();
      const width = screenSize.width;
      const height = screenSize.height;

      // Common configurations: [logical resolution] -> scale factor
      const knownConfigs: { [key: string]: number } = {
        // 4K UHD (3840x2160) scaled
        '2560x1440': 1.5,  // 150% scaling (most common for 4K)
        '3072x1728': 1.25, // 125% scaling
        '1920x1080': 2.0,  // 200% scaling

        // 2K QHD (2560x1440) scaled
        '2048x1152': 1.25, // 125% scaling

        // 5K scaled
        '3200x1800': 1.25, // 125% scaling
      };

      const key = `${width}x${height}`;
      if (knownConfigs[key]) {
        logger.debug(`Screen resolution ${key} matches known scaled configuration: ${knownConfigs[key]}x scaling`);
        return knownConfigs[key];
      }

      // No match found, assume 100%
      logger.debug(`Screen resolution ${key} not in known scaled configurations, assuming 100%`);
      return 1.0;
    } catch (error) {
      logger.error('Failed to calculate DPI from screen resolution:', error);
      return 1.0;
    }
  }

  /**
   * Get DPI scale factor for a specific window
   * @param hwnd Optional window handle to get DPI for
   * @returns Scale factor (1.0 = 100%, 1.25 = 125%, 1.5 = 150%, etc.)
   */
  private getDpiScale(hwnd?: any): number {
    try {
      // Method 1: GetDpiForSystem (Windows 10 1607+)
      // This returns the system DPI which is usually correct for most scenarios
      try {
        const dpi = GetDpiForSystem();
        if (dpi > 0 && dpi !== 96) { // If not default, use it
          const scale = dpi / 96;
          logger.debug(`GetDpiForSystem: ${dpi} DPI, Scale: ${scale}`);
          return scale;
        }
      } catch (error) {
        logger.debug('GetDpiForSystem not available');
      }

      // Method 2: GetDpiForWindow (Windows 10 1607+)
      // This gives per-window DPI
      if (hwnd) {
        try {
          const dpi = GetDpiForWindow(hwnd);
          if (dpi > 0 && dpi !== 96) {
            const scale = dpi / 96;
            logger.debug(`GetDpiForWindow: ${dpi} DPI, Scale: ${scale}`);
            return scale;
          }
        } catch (error) {
          logger.debug('GetDpiForWindow not available');
        }
      }

      // Method 3: GetDeviceCaps (legacy, may not reflect scaling on modern Windows)
      const hdc = GetDC(null);
      if (hdc) {
        const LOGPIXELSX = 88;
        const dpi = GetDeviceCaps(hdc, LOGPIXELSX);
        ReleaseDC(null, hdc);

        if (dpi > 0) {
          const scale = dpi / 96;
          logger.debug(`GetDeviceCaps: ${dpi} DPI, Scale: ${scale}`);
          return scale;
        }
      }
    } catch (error) {
      logger.error('Failed to get DPI scale:', error);
    }

    // Default fallback
    logger.warn('Could not detect DPI, assuming 100% (1.0)');
    return 1.0;
  }

  /**
   * Check if a window is visible
   */
  isWindowVisible(handle: number): boolean {
    try {
      const hwnd = koffi.decode(handle, 'void *');
      return IsWindowVisible(hwnd);
    } catch {
      return false;
    }
  }

  /**
   * Bring window to foreground and activate it
   */
  activateWindow(): boolean {
    const handle = this.lastFoundWindowHandle;
    if (!handle) {
      logger.warn('No window handle available for activation');
      return false;
    }

    try {
      logger.debug(`Activating window with handle type: ${typeof handle}`);

      // First restore if minimized
      ShowWindow(handle, SW_RESTORE);

      // Then bring to top
      const result = SetForegroundWindow(handle);
      if (result) {
        logger.info('Window activated successfully');
        return true;
      }

      // Fallback to BringWindowToTop
      return BringWindowToTop(handle) !== 0;
    } catch (error) {
      logger.error('Failed to activate window:', error);
      return false;
    }
  }

  /**
   * Make window always on top
   */
  setWindowTopMost(handle: number, topMost: boolean): boolean {
    try {
      const hwnd = koffi.decode(handle, 'void *');
      const hwndInsertAfter = topMost ? HWND_TOPMOST : HWND_NOTOPMOST;
      return SetWindowPos(hwnd, hwndInsertAfter, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE) !== 0;
    } catch (error) {
      logger.error('Failed to set window top most:', error);
      return false;
    }
  }

  /**
   * Get the stored window handle for the last found window
   */
  getLastWindowHandle(): any {
    return this.lastFoundWindowHandle;
  }

  /**
   * Store a specific window handle
   */
  setWindowHandle(handle: any): void {
    this.lastFoundWindowHandle = handle;
  }
}
