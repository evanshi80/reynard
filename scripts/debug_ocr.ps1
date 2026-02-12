[CmdletBinding()]
param(
    [string]$SearchText = ""
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# Find WeChat process
$wechat = Get-Process | Where-Object { $_.MainWindowTitle -match "WeChat|微信" -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $wechat) {
    # Try by process name
    $wechat = Get-Process -Name "WeChat" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
}

if (-not $wechat) {
    Write-Host "WeChat not found!"
    exit 1
}

Write-Host "WeChat PID=$($wechat.Id) Title='$($wechat.MainWindowTitle)' Handle=$($wechat.MainWindowHandle)"

$rect = New-Object Win32+RECT
[Win32]::GetWindowRect($wechat.MainWindowHandle, [ref]$rect) | Out-Null

$winX = $rect.Left
$winY = $rect.Top
$winW = $rect.Right - $rect.Left
$winH = $rect.Bottom - $rect.Top
Write-Host "Window: ($winX,$winY) ${winW}x${winH}"

$sidebarW = [Math]::Min([int]($winW * 0.35), 500)
$captureX = $winX
$captureY = $winY
$captureW = $sidebarW
$captureH = [Math]::Min($winH, 800)

Write-Host "Capture: X=$captureX Y=$captureY W=$captureW H=$captureH"

# Capture
$bitmap = New-Object System.Drawing.Bitmap($captureW, $captureH)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($captureX, $captureY, 0, 0, [System.Drawing.Size]::new($captureW, $captureH))
$tempFile = Join-Path $env:TEMP "wechat_debug_ocr.png"
$bitmap.Save($tempFile, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Host "Screenshot: $tempFile"

# OCR
try {
    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
    [void][Windows.Storage.StorageFile, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]

    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

    function Await($WinRTTask, $ResultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($WinRTTask))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }

    $absPath = (Resolve-Path $tempFile).Path
    $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absPath)) ([Windows.Storage.StorageFile])
    $stream = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    Write-Host "Image: $($softwareBitmap.PixelWidth)x$($softwareBitmap.PixelHeight)"

    $ocrEngine = $null
    foreach ($lang in @("zh-Hans-CN", "zh-CN", "zh-Hant-TW")) {
        try {
            $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
                [Windows.Globalization.Language]::new($lang))
            if ($ocrEngine) { Write-Host "OCR lang: $lang"; break }
        } catch {}
    }
    if (-not $ocrEngine) {
        $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if ($ocrEngine) { Write-Host "OCR: user profile" }
    }
    if (-not $ocrEngine) {
        Write-Host "No OCR engine! Available:"
        foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
            Write-Host "  $($l.LanguageTag)"
        }
        exit 1
    }

    $ocrResult = Await ($ocrEngine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])

    Write-Host "`n=== OCR ($($ocrResult.Lines.Count) lines) ==="
    $i = 0
    foreach ($line in $ocrResult.Lines) {
        $i++
        $minX = 99999; $minY = 99999; $maxX = 0; $maxY = 0
        foreach ($word in $line.Words) {
            $r = $word.BoundingRect
            if ($r.X -lt $minX) { $minX = $r.X }
            if ($r.Y -lt $minY) { $minY = $r.Y }
            if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
            if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
        }
        $cx = $captureX + [int](($minX + $maxX) / 2)
        $cy = $captureY + [int](($minY + $maxY) / 2)
        $mark = ""
        if ($SearchText -and $line.Text -like "*$SearchText*") { $mark = " <<< MATCH" }
        Write-Host ("  [{0}] '{1}' rel({2},{3}) screen({4},{5}){6}" -f $i, $line.Text, [int]$minX, [int]$minY, $cx, $cy, $mark)
    }
    if ($ocrResult.Lines.Count -eq 0) { Write-Host "  (nothing)" }

    $stream.Dispose()
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    Write-Host $_.ScriptStackTrace
}

Write-Host "`nImage at: $tempFile"
