Get-Process | Where-Object { $_.ProcessName -like '*WeChat*' -or $_.ProcessName -like '*wechat*' } | ForEach-Object {
    Write-Host "Process: $($_.ProcessName) PID=$($_.Id) Title='$($_.MainWindowTitle)' Handle=$($_.MainWindowHandle)"
}
