import AppKit

/// Minimal macOS app that sends a native notification via NSAppleScript.
///
/// Using an .app bundle (rather than bare osascript) lets macOS display a
/// custom icon in Notification Center. LSUIElement keeps it out of the Dock.
///
/// Usage: open PiNotify.app --args <title> <body> [sound]

let args = ProcessInfo.processInfo.arguments

guard args.count >= 3 else {
    fputs("Usage: PiNotify <title> <body> [sound]\n", stderr)
    exit(1)
}

let title = args[1]
let body  = args[2]
let sound = args.count >= 4 ? args[3] : "Glass"

// Hide from Dock
NSApplication.shared.setActivationPolicy(.accessory)

/// Escape a string for safe interpolation into an AppleScript double-quoted
/// string literal. Without this, a `"` or `\` in the title/body (e.g. a bash
/// command like `echo "hi"`) breaks the script so it never compiles and no
/// notification is shown. Newlines are collapsed to spaces (AppleScript string
/// literals can't span raw newlines).
func escapeForAppleScript(_ s: String) -> String {
    var out = s.replacingOccurrences(of: "\\", with: "\\\\")
    out = out.replacingOccurrences(of: "\"", with: "\\\"")
    out = out.replacingOccurrences(of: "\n", with: " ")
    out = out.replacingOccurrences(of: "\r", with: " ")
    return out
}

let source = """
    display notification "\(escapeForAppleScript(body))" with title "\(escapeForAppleScript(title))" sound name "\(escapeForAppleScript(sound))"
"""

let script = NSAppleScript(source: source)
script?.executeAndReturnError(nil)

// Give Notification Center a moment to pick up the notification before exiting
Thread.sleep(forTimeInterval: 0.5)
