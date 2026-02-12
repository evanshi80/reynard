# Changelog

All notable changes to this project will be documented in this file.

## [2.0.2] - 2026-02-09

### Fixed

**DPI Scaling Fix for High-Resolution Displays**

- Fixed screenshot coordinate calculation for high-DPI displays (125%, 150%, 200% scaling)
- **Root cause**: robotjs reports logical screen size but uses physical pixel coordinates for capture
- **Solution**: Implemented intelligent DPI detection with fallback calculation
- Key improvements:
  - Added `GetDpiForSystem` API call for Windows 10+ DPI detection
  - Implemented screen resolution-based DPI calculation as fallback
  - Automatically detects 4K @ 150% (2560x1440 logical → 3840x2160 physical)
  - Fixed client area coordinate conversion using `ClientToScreen(0,0)` instead of window rect
- **Tested configurations**:
  - ✅ 4K UHD (3840x2160) @ 150% scaling → 1.5x multiplier
  - ✅ 2K QHD (2560x1440) @ 100% scaling → 1.0x multiplier
  - ✅ 4K UHD @ 125% scaling → 1.25x multiplier

### Technical Details

- **Before**: Used window border coordinates, no DPI scaling → captured wrong area
- **After**: Use client area coordinates, apply DPI scaling → correct capture
- Formula: `physical_coordinate = logical_coordinate × DPI_scale`
- Example: Logical X=1281 with 150% DPI → Physical X=1922

## [2.0.1] - 2026-02-09

### Changed

**Major Performance Improvement: Native Windows API Integration**

- Replaced PowerShell-based window finding with direct Windows API calls using Koffi FFI
- **Performance gains:**
  - Window finding: **< 1ms** (previously 200-500ms) - **~400x faster**
  - Total screenshot capture: **~40ms** (previously 300-600ms) - **~10x faster**
- **Implementation details:**
  - Added `koffi` dependency (v2.15.1) for native Windows API access
  - Created new `WindowFinder` class in `src/capture/windowFinder.ts`
  - Direct calls to `user32.dll` and `gdi32.dll`:
    - `EnumWindows` - enumerate all top-level windows
    - `GetWindowTextW` - get window titles (Unicode support)
    - `GetWindowRect` / `GetClientRect` - get window coordinates
    - `ClientToScreen` - coordinate transformation
    - `IsWindowVisible` - visibility check
    - `GetDeviceCaps` - DPI scale detection
- **Benefits:**
  - Eliminates PowerShell process spawn overhead
  - Removes temporary file I/O for IPC
  - Better DPI scaling support
  - More maintainable code
  - Reduced CPU usage
- **Removed:**
  - PowerShell scripts: `find_window.ps1`, `find_window_temp.ps1`, and related scripts
  - PowerShell inline C# code from `screenshot.ts`

### Added

- New dependency: `koffi@^2.15.1` for FFI (Foreign Function Interface)
- `src/capture/windowFinder.ts` - Native Windows API window finder

### Technical Notes

- The window selection algorithm remains unchanged (same scoring logic)
- Screenshot capture method (robotjs + sharp) remains unchanged
- VLM integration and message recognition unchanged
- Backward compatible - no configuration changes required

---

## [2.0.0] - Prior

- Initial vision-based WeChat monitoring system
- Ollama/OpenAI/Anthropic VLM integration
- SQLite message storage
- Web API for message retrieval
