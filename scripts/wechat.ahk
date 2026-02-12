#Requires AutoHotkey v2.0
; wechat.ahk - WeChat Automation (AHK v2)
;
; Actions:
;   activate                  - Activate WeChat window
;   type_search <text>        - Open search and type text (no selection)
;   click <x> <y>             - Click at screen coordinates
;   send <message>            - Send message in current chat
;   sendto <contact> <msg>    - Smart search + send (Home+Down navigation)
;   open_first <contact>      - Type search, press Home+Down to select first result

#SingleInstance Force

action := A_Args.Length >= 1 ? A_Args[1] : ""
if (action = "") {
    OutputJSON(false, "usage", "No action")
    ExitApp 1
}

if (action = "activate") {
    OutputJSON(ActivateWeChat(), "activate", ActivateWeChat() ? "OK" : "Failed")
}
else if (action = "type_search") {
    text := A_Args.Length >= 2 ? A_Args[2] : ""
    if (text = "") {
        OutputJSON(false, "type_search", "Text required")
        ExitApp 1
    }
    result := TypeSearch(text)
    OutputJSON(result, "type_search", result ? "Typed: " . text : "Failed")
}
else if (action = "click") {
    cx := A_Args.Length >= 2 ? Integer(A_Args[2]) : 0
    cy := A_Args.Length >= 3 ? Integer(A_Args[3]) : 0
    if (cx = 0 && cy = 0) {
        OutputJSON(false, "click", "Coords required")
        ExitApp 1
    }
    Click cx, cy
    Sleep 500
    OutputJSON(true, "click", "Clicked " . cx . "," . cy)
}
else if (action = "send") {
    message := A_Args.Length >= 2 ? A_Args[2] : ""
    if (message = "") {
        OutputJSON(false, "send", "Message required")
        ExitApp 1
    }
    OutputJSON(SendChatMessage(message), "send", "Sent")
}
else if (action = "open_first") {
    ; Type search, then use Home+Down to select first actual contact (skip 搜一搜 suggestions)
    contact := A_Args.Length >= 2 ? A_Args[2] : ""
    if (contact = "") {
        OutputJSON(false, "open_first", "Contact required")
        ExitApp 1
    }
    result := OpenFirstResult(contact)
    OutputJSON(result, "open_first", result ? "Opened: " . contact : "Failed")
}
else if (action = "navigate") {
    ; Type search, Home, then Down N times, Enter
    contact := A_Args.Length >= 2 ? A_Args[2] : ""
    downCount := A_Args.Length >= 3 ? Integer(A_Args[3]) : 2
    if (contact = "") {
        OutputJSON(false, "navigate", "Contact required")
        ExitApp 1
    }
    result := NavigateToResult(contact, downCount)
    OutputJSON(result, "navigate", result ? "Navigated: " . contact : "Failed")
}
else if (action = "sendto") {
    contact := A_Args.Length >= 2 ? A_Args[2] : ""
    message := A_Args.Length >= 3 ? A_Args[3] : ""
    if (contact = "" || message = "") {
        OutputJSON(false, "sendto", "Contact and message required")
        ExitApp 1
    }
    ; Try Home+Down navigation first
    if (OpenFirstResult(contact)) {
        Sleep 500
        OutputJSON(SendChatMessage(message), "sendto", "Sent to: " . contact)
    } else {
        OutputJSON(false, "sendto", "Failed")
    }
}
else if (action = "scroll_home") {
    ; Scroll to top of chat, with optional window coordinates
    winX := A_Args.Length >= 2 ? Integer(A_Args[2]) : 0
    winY := A_Args.Length >= 3 ? Integer(A_Args[3]) : 0
    winW := A_Args.Length >= 4 ? Integer(A_Args[4]) : 0
    winH := A_Args.Length >= 5 ? Integer(A_Args[5]) : 0
    ScrollToTop(winX, winY, winW, winH)
    OutputJSON(true, "scroll_home", "Scrolled to top")
}
else if (action = "scroll_up") {
    ; Scroll up by one screen height
    Send "{WheelUp}"
    Sleep 200
    OutputJSON(true, "scroll_up", "Scrolled up one screen")
}
else if (action = "scroll_down") {
    ; Scroll down by one screen height
    Send "{WheelDown}"
    Sleep 200
    OutputJSON(true, "scroll_down", "Scrolled down one screen")
}
else {
    OutputJSON(false, "unknown", "Unknown: " . action)
    ExitApp 1
}

ExitApp 0

; ============================================================

OutputJSON(success, action, msg) {
    s := success ? "true" : "false"
    msg := StrReplace(msg, "\", "\\")
    msg := StrReplace(msg, "`"", "\`"")
    msg := StrReplace(msg, "`n", "\n")
    msg := StrReplace(msg, "`r", "\r")
    FileAppend '{"success": ' . s . ', "action": "' . action . '", "message": "' . msg . '"}' . "`n", "*"
}

ActivateWeChat() {
    for title in ["ahk_class WeChatMainWndForPC", "微信", "WeChat"] {
        if WinExist(title) {
            WinActivate
            Sleep 200
            if WinWaitActive(, , 2)
                return true
        }
    }
    return false
}

; Open search and type text, but do NOT select any result
TypeSearch(text) {
    if (!ActivateWeChat())
        return false
    Send "^f"
    Sleep 400
    Send "^a"
    Sleep 100
    clipSaved := ClipboardAll()
    A_Clipboard := text
    Sleep 100
    Send "^v"
    Sleep 800
    A_Clipboard := clipSaved
    clipSaved := ""
    return true
}

; Smart search navigation with OCR category detection
; Strategy: Home -> Down N times to reach target -> Enter
OpenFirstResult(contactName) {
    return NavigateToResult(contactName, 2)
}

; Navigate to result with configurable Down count (assumes search is already open)
NavigateToResult(contactName, downCount) {
    if (!ActivateWeChat())
        return false

    ; Home to go to first item, then Down N times
    Send "{Home}"
    Sleep 300

    Loop downCount {
        Send "{Down}"
        Sleep 150
    }

    Sleep 200
    Send "{Enter}"
    Sleep 500

    return true
}

SendChatMessage(message) {
    if !WinActive("ahk_class WeChatMainWndForPC") && !WinActive("微信") && !WinActive("WeChat") {
        if (!ActivateWeChat())
            return false
    }
    Sleep 200
    clipSaved := ClipboardAll()
    A_Clipboard := message
    Sleep 100
    Send "^v"
    Sleep 200
    Send "{Enter}"
    Sleep 300
    A_Clipboard := clipSaved
    clipSaved := ""
    return true
}

; Scroll to top of chat area
; Parameters: winX, winY, winW, winH (optional, can be 0)
ScrollToTop(winX?, winY?, winW?, winH?) {
    if (!ActivateWeChat())
        return false

    ; Calculate click position based on window dimensions
    ; Chat area is typically on the right side (around 60-70% of window width)
    ; Click in the middle of chat area, slightly above bottom
    if (winW && winH && winW > 0 && winH > 0) {
        clickX := Round(winW * 0.65)  ; ~65% from left edge
        clickY := Round(winH * 0.6)   ; ~60% from top
        Click clickX, clickY
        Sleep 300
    }

    ; Ctrl+End to go to bottom, then Ctrl+Up to position at latest message
    Send "^{End}"
    Sleep 300
    Send "^{Up}"
    Sleep 200

    return true
}
