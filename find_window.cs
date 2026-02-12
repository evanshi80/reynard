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
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}

public class WindowFinder {
    static List<string> results = new List<string>();

    static bool Callback(IntPtr hWnd, IntPtr lParam) {
        int len = WinAPI.GetWindowTextLength(hWnd);
        if (len > 0 && len < 256) {
            var sb = new StringBuilder(len + 1);
            WinAPI.GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            string lower = title.ToLower();
            if (lower.Contains("weixin") || lower.Contains("wxtray") || lower.Contains("messagetray")) {
                RECT rc;
                if (WinAPI.GetWindowRect(hWnd, out rc)) {
                    int w = rc.Right - rc.Left;
                    int h = rc.Bottom - rc.Top;
                    if (w > 100 && h > 100) {
                        results.Add(title + "|" + hWnd.ToString() + "|" + rc.Left + "," + rc.Top + "," + w + "," + h);
                    }
                }
            }
        }
        return true;
    }

    public static string Find() {
        results.Clear();
        WinAPI.EnumWindows(Callback, IntPtr.Zero);
        if (results.Count == 0) return "NONE";
        // Return window with smallest Left value (most likely main window)
        string best = results[0];
        int minX = int.MaxValue;
        foreach (string r in results) {
            string[] parts = r.Split('|');
            if (parts.Length >= 3) {
                string[] coords = parts[2].Split(',');
                if (coords.Length == 4) {
                    int x = int.Parse(coords[0]);
                    if (x < minX) {
                        minX = x;
                        best = r;
                    }
                }
            }
        }
        return best;
    }
}

public class Program {
    public static void Main() {
        string result = WindowFinder.Find();
        Console.WriteLine(result);
    }
}
