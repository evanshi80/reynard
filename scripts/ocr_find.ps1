param(
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height,
    [string]$SearchText,
    [string]$Language = "zh-Hans-CN"
)

# Capture screen region
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($X, $Y, 0, 0, [System.Drawing.Size]::new($Width, $Height))
$tempFile = Join-Path $env:TEMP "wechat_ocr_tmp.png"
$bitmap.Save($tempFile, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

try {
    # Load WinRT types
    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
    [void][Windows.Storage.StorageFile, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]

    # Async helper - convert WinRT IAsyncOperation to .NET Task
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

    function Await($WinRTTask, $ResultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($WinRTTask))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }

    # Load image file
    $absPath = (Resolve-Path $tempFile).Path
    $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absPath)) ([Windows.Storage.StorageFile])
    $stream = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    # Create OCR engine
    $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
        [Windows.Globalization.Language]::new($Language))

    if (-not $ocrEngine) {
        # Fallback to user profile languages
        $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }

    if (-not $ocrEngine) {
        Write-Output '{"found":false,"error":"OCR engine not available","lines":[]}'
        exit 1
    }

    # Run OCR
    $ocrResult = Await ($ocrEngine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])

    # Collect all lines with bounding info
    $lines = @()
    foreach ($line in $ocrResult.Lines) {
        $text = $line.Text
        # Calculate bounding rect from all words in the line
        $minX = [double]::MaxValue; $minY = [double]::MaxValue
        $maxX = 0; $maxY = 0
        foreach ($word in $line.Words) {
            $r = $word.BoundingRect
            if ($r.X -lt $minX) { $minX = $r.X }
            if ($r.Y -lt $minY) { $minY = $r.Y }
            if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
            if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
        }
        $lines += @{
            text = $text
            x    = [int]$minX
            y    = [int]$minY
            w    = [int]($maxX - $minX)
            h    = [int]($maxY - $minY)
        }
    }

    # Find the best match (contains SearchText, not a web search item)
    $match = $null
    foreach ($l in $lines) {
        if ($l.text -like "*$SearchText*" -and $l.text -notlike "*搜一搜*" -and $l.text -notlike "*搜索*网*") {
            $match = $l
            break
        }
    }

    if ($match) {
        # Return absolute screen coordinates (capture offset + relative position)
        $cx = $X + $match.x + [int]($match.w / 2)
        $cy = $Y + $match.y + [int]($match.h / 2)
        $safeText = $match.text -replace '"', '\"'
        Write-Output "{`"found`":true,`"text`":`"$safeText`",`"x`":$cx,`"y`":$cy}"
    }
    else {
        # Output all recognized lines for debugging
        $allLines = ($lines | ForEach-Object { $_.text }) -join "|"
        $allLines = $allLines -replace '"', '\"'
        Write-Output "{`"found`":false,`"text`":`"$allLines`",`"x`":0,`"y`":0}"
    }

    $stream.Dispose()
}
finally {
    Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
}
