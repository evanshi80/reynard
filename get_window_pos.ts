import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class WinAPI {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpWindowText, int nMaxCount);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rc);
  [DllImport("user32.dll")]
  public static extern bool GetClientRect(IntPtr hWnd, out RECT rc);
  [DllImport("user32.dll")]
  public static extern bool ClientToScreen(IntPtr hWnd, ref POINT pt);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int x, y; }
}

public class WindowFinder {
  static List<string> results = new List<string>();
  static readonly string WeiXin = "\\u5FAE\\u4FE1";

  static bool IsWeChat(string title) {
    if (string.IsNullOrEmpty(title)) return false;
    string lower = title.ToLower();
    return lower.Contains("weixin") || lower.Contains("wxtray") || lower.Contains("messagetray") || title.Contains(WeiXin);
  }

  static bool cb(IntPtr hWnd, IntPtr lParam) {
    int len = WinAPI.GetWindowTextLength(hWnd);
    if (len > 0 && len < 256) {
      var sb = new StringBuilder(len + 1);
      WinAPI.GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (IsWeChat(title)) {
        WinAPI.RECT winRect;
        if (WinAPI.GetWindowRect(hWnd, out winRect)) {
          int w = winRect.Right - winRect.Left;
          int h = winRect.Bottom - winRect.Top;
          long area = (long)w * h;
          if (w > 100 && h > 100) {
            WinAPI.RECT clientRect;
            WinAPI.POINT clientPoint = new WinAPI.POINT();
            if (WinAPI.GetClientRect(hWnd, out clientRect)) {
              clientPoint.x = 0;
              clientPoint.y = clientRect.Bottom;
              if (WinAPI.ClientToScreen(hWnd, ref clientPoint)) {
                int cw = clientRect.Right - clientRect.Left;
                int ch = clientRect.Bottom - clientRect.Top;
                if (cw > 100 && ch > 100) {
                  results.Add(title + "|" + hWnd.ToString() + "|" + winRect.Left.ToString() + "," + clientPoint.y.ToString() + "," + cw.ToString() + "," + ch.ToString() + "|" + area.ToString());
                }
              }
            }
            if (results.Count == 0 || !results[results.Count-1].Contains("|" + hWnd.ToString() + "|")) {
              results.Add(title + "|" + hWnd.ToString() + "|" + winRect.Left.ToString() + "," + winRect.Top.ToString() + "," + w.ToString() + "," + h.ToString() + "|" + area.ToString());
            }
          }
        }
      }
    }
    return true;
  }

  public static string Find() {
    results.Clear();
    WinAPI.EnumWindows(cb, IntPtr.Zero);
    if (results.Count == 0) return "NONE";
    string best = "";
    long bestScore = -1;
    foreach (string r in results) {
      string[] parts = r.Split('|');
      if (parts.Length < 5) continue;
      long x = long.Parse(parts[2].Split(',')[0]);
      long area = long.Parse(parts[4]);
      bool isChinese = parts[0] == WeiXin;
      long score = area;
      if (isChinese && x > 500) score += 2000000;
      else if (isChinese) score += 1000000;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  }
}
"@
$result = [WindowFinder]::Find()
$result | Out-File -FilePath $env:TEMP\\reynard_window.txt -Encoding UTF8
`;

// Write PowerShell script to temp file
const scriptPath = path.join(process.cwd(), 'find_window_temp.ps1');
fs.writeFileSync(scriptPath, PS_SCRIPT);

// Execute and read result
try {
  execSync(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeout: 5000 });
  const resultPath = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'reynard_window.txt');
  if (fs.existsSync(resultPath)) {
    const output = fs.readFileSync(resultPath, 'utf-8').trim();
    console.log(output);
  }
} catch (e) {
  console.error('Error:', e);
} finally {
  // Cleanup
  try { fs.unlinkSync(scriptPath); } catch {}
}
