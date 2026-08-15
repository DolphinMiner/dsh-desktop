import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
@preconcurrency import ScreenCaptureKit
import Vision

private let protocolVersion = 2
private let observationVersion = 2
private let maxOutputText = 32_768

private struct Bounds: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ rect: CGRect) {
        x = rect.origin.x
        y = rect.origin.y
        width = rect.width
        height = rect.height
    }

    var rect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}

private struct Target: Codable {
    let id: String
    let kind: String
    let name: String
    let applicationName: String?
    let bundleId: String?
    let pid: Int32?
    let frontmost: Bool?
    let bounds: Bounds?
    let displayScale: Double?
}

private struct PermissionResult: Codable {
    let supported: Bool
    let screenRecording: String
    let accessibility: String
    let canObserve: Bool
    let canAct: Bool
}

private struct TargetListResult: Codable {
    let permissions: PermissionResult
    let targets: [Target]
}

private struct ApplicationResult: Codable {
    let id: String
    let name: String
    let bundleId: String?
    let pid: Int32
    let frontmost: Bool
}

private struct ElementResult: Codable {
    let id: String
    let role: String
    let label: String?
    let value: String?
    let actions: [String]
    let bounds: Bounds?
    let secure: Bool
}

private struct DisplayStateResult: Codable {
    let id: String
    let bounds: Bounds
    let displayScale: Double
}

private struct CompatibilityResult: Codable {
    let surfaceId: String
    let surfaceBounds: Bounds
    let displayTopology: [DisplayStateResult]
    let foregroundApplicationId: String?
}

private struct CaptureResult: Codable {
    let bounds: Bounds
    let displayScale: Double
    let pixelWidth: Int
    let pixelHeight: Int
    let screenshotCaptured: Bool
    let ocrText: String?
}

private struct ObservationResult: Codable {
    let version: Int
    let snapshotId: String
    let observedAt: String
    let target: Target
    let foregroundApplication: ApplicationResult?
    let compatibility: CompatibilityResult
    let capture: CaptureResult
    let elements: [ElementResult]
    let truncated: Bool
    let warnings: [String]
}

private struct Request: Decodable {
    let version: Int
    let id: String
    let method: String
    let snapshotId: String?
    let target: Target?
    let screenshotPath: String?
    let maxDepth: Int?
    let maxElements: Int?
    let actionId: String?
    let sourceSnapshotId: String?
    let compatibility: CompatibilityResult?
    let action: ActionRequest?
    let element: ElementResult?
}

private struct PointRequest: Codable {
    let x: Double
    let y: Double
}

private struct ActionTargetRequest: Codable {
    let mode: String
    let elementId: String?
    let coordinateSpace: String?
    let point: PointRequest?
}

private struct ActionRequest: Codable {
    let kind: String
    let target: ActionTargetRequest?
    let button: String?
    let clickCount: Int?
    let elementId: String?
    let text: String?
    let replace: Bool?
    let key: String?
    let modifiers: [String]?
    let deltaX: Double?
    let deltaY: Double?
}

private struct ActionReceipt: Codable {
    let actionId: String
    let performedAt: String
}

private struct ErrorBody: Encodable {
    let code: String
    let message: String
}

private struct SuccessResponse<Value: Encodable>: Encodable {
    let version: Int
    let id: String
    let ok = true
    let result: Value
}

private struct FailureResponse: Encodable {
    let version: Int
    let id: String
    let ok = false
    let error: ErrorBody
}

private struct HelperError: Error {
    let code: String
    let message: String

    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

private struct ResolvedCapture {
    let target: Target
    let filter: SCContentFilter
    let bounds: CGRect
    let surfaceId: String
    let pid: pid_t?
    let warning: String?
}

private struct AccessibilityResult {
    let elements: [ElementResult]
    let handles: [String: AXUIElement]
    let truncated: Bool
}

private func permissions() -> PermissionResult {
    let screenGranted = CGPreflightScreenCaptureAccess()
    let accessibilityGranted = AXIsProcessTrustedWithOptions(nil)
    return PermissionResult(
        supported: true,
        screenRecording: screenGranted ? "granted" : "denied",
        accessibility: accessibilityGranted ? "granted" : "denied",
        canObserve: screenGranted,
        canAct: screenGranted && accessibilityGranted
    )
}

private func nonEmpty(_ value: String?) -> String? {
    guard let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines),
          !normalized.isEmpty else { return nil }
    return normalized
}

private func applicationTarget(_ application: NSRunningApplication) -> Target? {
    guard application.activationPolicy == .regular,
          !application.isTerminated,
          let name = application.localizedName,
          !name.isEmpty else { return nil }
    let bundle = nonEmpty(application.bundleIdentifier)
    let id = "application:\(application.processIdentifier):\(bundle ?? "-")"
    return Target(
        id: id,
        kind: "application",
        name: name,
        applicationName: nil,
        bundleId: bundle,
        pid: application.processIdentifier,
        frontmost: application.isActive,
        bounds: nil,
        displayScale: nil
    )
}

private func displayName(_ display: SCDisplay, index: Int) -> String {
    if display.displayID == CGMainDisplayID() { return "Main Display" }
    return "Display \(index + 1)"
}

private func targetList() async throws -> TargetListResult {
    let currentPermissions = permissions()
    var targets = NSWorkspace.shared.runningApplications.compactMap(applicationTarget)

    if !currentPermissions.canObserve {
        for (index, screen) in NSScreen.screens.enumerated() {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
                continue
            }
            let displayId = number.uint32Value
            targets.append(Target(
                id: "display:\(displayId)",
                kind: "display",
                name: displayId == CGMainDisplayID() ? "Main Display" : "Display \(index + 1)",
                applicationName: nil,
                bundleId: nil,
                pid: nil,
                frontmost: nil,
                bounds: Bounds(screen.frame),
                displayScale: screen.backingScaleFactor
            ))
        }
        return TargetListResult(permissions: currentPermissions, targets: sortedTargets(targets))
    }

    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    for (index, display) in content.displays.enumerated() {
        let filter = SCContentFilter(display: display, excludingWindows: [])
        targets.append(Target(
            id: "display:\(display.displayID)",
            kind: "display",
            name: displayName(display, index: index),
            applicationName: nil,
            bundleId: nil,
            pid: nil,
            frontmost: nil,
            bounds: Bounds(display.frame),
            displayScale: Double(filter.pointPixelScale)
        ))
    }
    for window in content.windows where window.isOnScreen && window.frame.width >= 80 && window.frame.height >= 60 {
        guard let owner = window.owningApplication else { continue }
        let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = title?.isEmpty == false ? title! : "Window"
        targets.append(Target(
            id: "window:\(window.windowID):\(owner.processID)",
            kind: "window",
            name: name,
            applicationName: nonEmpty(owner.applicationName),
            bundleId: nonEmpty(owner.bundleIdentifier),
            pid: owner.processID,
            frontmost: nil,
            bounds: Bounds(window.frame),
            displayScale: nil
        ))
    }
    return TargetListResult(permissions: currentPermissions, targets: sortedTargets(targets))
}

private func sortedTargets(_ targets: [Target]) -> [Target] {
    let order = ["application": 0, "window": 1, "display": 2]
    return targets.sorted {
        let left = order[$0.kind] ?? 9
        let right = order[$1.kind] ?? 9
        if left != right { return left < right }
        let compared = $0.name.localizedCaseInsensitiveCompare($1.name)
        if compared != .orderedSame { return compared == .orderedAscending }
        return $0.id < $1.id
    }
}

private func resolveCapture(target: Target, content: SCShareableContent) throws -> ResolvedCapture {
    switch target.kind {
    case "display":
        guard let displayId = UInt32(target.id.split(separator: ":").last ?? ""),
              let display = content.displays.first(where: { $0.displayID == displayId }) else {
            throw HelperError("TARGET_CHANGED", "The selected display is no longer available.")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        return ResolvedCapture(
            target: target,
            filter: filter,
            bounds: display.frame,
            surfaceId: "display:\(display.displayID)",
            pid: nil,
            warning: nil
        )
    case "window":
        let pieces = target.id.split(separator: ":")
        guard pieces.count == 3,
              let windowId = UInt32(pieces[1]),
              let window = content.windows.first(where: { $0.windowID == windowId && $0.isOnScreen }),
              let owner = window.owningApplication,
              target.pid == owner.processID else {
            throw HelperError("TARGET_CHANGED", "The selected window is no longer available.")
        }
        return ResolvedCapture(
            target: target,
            filter: SCContentFilter(desktopIndependentWindow: window),
            bounds: window.frame,
            surfaceId: "window:\(window.windowID):\(owner.processID)",
            pid: owner.processID,
            warning: nil
        )
    case "application":
        guard let pid = target.pid,
              let application = content.applications.first(where: {
                  $0.processID == pid && (target.bundleId == nil || $0.bundleIdentifier == target.bundleId)
              }) else {
            throw HelperError("TARGET_CHANGED", "The selected application is no longer running.")
        }
        guard let window = content.windows
            .filter({ $0.isOnScreen && $0.owningApplication?.processID == pid })
            .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            throw HelperError("TARGET_CHANGED", "The selected application has no visible window.")
        }
        return ResolvedCapture(
            target: target,
            filter: SCContentFilter(desktopIndependentWindow: window),
            bounds: window.frame,
            surfaceId: "window:\(window.windowID):\(application.processID)",
            pid: application.processID,
            warning: "Captured the largest visible window for the selected application."
        )
    default:
        throw HelperError("BAD_MESSAGE", "The computer target kind is invalid.")
    }
}

private func copyAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
    guard let value = copyAttribute(element, attribute) else { return nil }
    if let string = value as? String { return String(string.prefix(2_000)) }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

private func elementBounds(_ element: AXUIElement) -> Bounds? {
    guard let positionValue = copyAttribute(element, kAXPositionAttribute as CFString),
          let sizeValue = copyAttribute(element, kAXSizeAttribute as CFString),
          CFGetTypeID(positionValue) == AXValueGetTypeID(),
          CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    let positionAX = unsafeBitCast(positionValue, to: AXValue.self)
    let sizeAX = unsafeBitCast(sizeValue, to: AXValue.self)
    guard AXValueGetValue(positionAX, .cgPoint, &position),
          AXValueGetValue(sizeAX, .cgSize, &size) else { return nil }
    return Bounds(CGRect(origin: position, size: size))
}

private func accessibilityTree(pid: pid_t, maxDepth: Int, maxElements: Int) -> AccessibilityResult {
    guard AXIsProcessTrustedWithOptions(nil) else {
        return AccessibilityResult(elements: [], handles: [:], truncated: false)
    }
    let root = AXUIElementCreateApplication(pid)
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var elements: [ElementResult] = []
    var handles: [String: AXUIElement] = [:]
    var truncated = false

    while !queue.isEmpty {
        let (element, depth) = queue.removeFirst()
        if elements.count >= maxElements {
            truncated = true
            break
        }
        let role = stringAttribute(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
        let subrole = stringAttribute(element, kAXSubroleAttribute as CFString)
        let secure = subrole == "AXSecureTextField" || role == "AXSecureTextField"
        let title = stringAttribute(element, kAXTitleAttribute as CFString)
        let description = stringAttribute(element, kAXDescriptionAttribute as CFString)
        let label = title?.isEmpty == false ? title : description
        var actionNames: CFArray?
        let actions: [String]
        if AXUIElementCopyActionNames(element, &actionNames) == .success,
           let names = actionNames as? [String] {
            actions = Array(names.prefix(64))
        } else {
            actions = []
        }
        let id = "ax:\(elements.count)"
        elements.append(ElementResult(
            id: id,
            role: role,
            label: label,
            value: secure ? nil : stringAttribute(element, kAXValueAttribute as CFString),
            actions: actions,
            bounds: elementBounds(element),
            secure: secure
        ))
        handles[id] = element

        guard depth < maxDepth,
              let childrenValue = copyAttribute(element, kAXChildrenAttribute as CFString),
              let children = childrenValue as? [AXUIElement] else { continue }
        let remaining = max(0, maxElements - elements.count - queue.count)
        if children.count > remaining { truncated = true }
        queue.append(contentsOf: children.prefix(remaining).map { ($0, depth + 1) })
    }
    return AccessibilityResult(elements: elements, handles: handles, truncated: truncated)
}

private func redactedImage(_ image: CGImage, captureBounds: CGRect, elements: [ElementResult]) -> CGImage {
    let secureBounds = elements.compactMap { element -> CGRect? in
        guard element.secure, let bounds = element.bounds?.rect else { return nil }
        return bounds.intersection(captureBounds).isNull ? nil : bounds.intersection(captureBounds)
    }
    guard !secureBounds.isEmpty,
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
              data: nil,
              width: image.width,
              height: image.height,
              bitsPerComponent: 8,
              bytesPerRow: 0,
              space: colorSpace,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else { return image }

    let full = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    context.draw(image, in: full)
    context.setFillColor(NSColor.black.cgColor)
    let scaleX = Double(image.width) / max(captureBounds.width, 1)
    let scaleY = Double(image.height) / max(captureBounds.height, 1)
    for bounds in secureBounds {
        let x = (bounds.minX - captureBounds.minX) * scaleX
        let top = (bounds.minY - captureBounds.minY) * scaleY
        let width = bounds.width * scaleX
        let height = bounds.height * scaleY
        context.fill(CGRect(x: x, y: Double(image.height) - top - height, width: width, height: height))
    }
    return context.makeImage() ?? image
}

private func recognizedText(in image: CGImage) throws -> String? {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    guard !lines.isEmpty else { return nil }
    return String(lines.joined(separator: "\n").prefix(maxOutputText))
}

private func writePNG(_ image: CGImage, path: String) throws {
    guard path.hasSuffix(".png") else {
        throw HelperError("BAD_MESSAGE", "The screenshot output path is invalid.")
    }
    let url = URL(fileURLWithPath: path)
    let representation = NSBitmapImageRep(cgImage: image)
    guard let data = representation.representation(using: .png, properties: [:]) else {
        throw HelperError("INTERNAL_ERROR", "The screenshot could not be encoded.")
    }
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
}

private func foregroundApplication() -> ApplicationResult? {
    guard let application = NSWorkspace.shared.frontmostApplication,
          let name = application.localizedName else { return nil }
    return ApplicationResult(
        id: "application:\(application.processIdentifier):\(application.bundleIdentifier ?? "-")",
        name: name,
        bundleId: application.bundleIdentifier,
        pid: application.processIdentifier,
        frontmost: true
    )
}

private func displayTopology(_ content: SCShareableContent) -> [DisplayStateResult] {
    content.displays.map { display in
        let filter = SCContentFilter(display: display, excludingWindows: [])
        return DisplayStateResult(
            id: "display:\(display.displayID)",
            bounds: Bounds(display.frame),
            displayScale: Double(filter.pointPixelScale)
        )
    }.sorted { $0.id < $1.id }
}

private func nearlyEqual(_ left: Double, _ right: Double, tolerance: Double = 0.5) -> Bool {
    abs(left - right) <= tolerance
}

private func boundsMatch(_ left: Bounds, _ right: Bounds) -> Bool {
    nearlyEqual(left.x, right.x) && nearlyEqual(left.y, right.y) &&
        nearlyEqual(left.width, right.width) && nearlyEqual(left.height, right.height)
}

private func topologyMatches(_ expected: [DisplayStateResult], _ current: [DisplayStateResult]) -> Bool {
    guard expected.count == current.count else { return false }
    return zip(expected.sorted { $0.id < $1.id }, current.sorted { $0.id < $1.id }).allSatisfy {
        $0.id == $1.id && boundsMatch($0.bounds, $1.bounds) &&
            nearlyEqual($0.displayScale, $1.displayScale, tolerance: 0.01)
    }
}

private func validateCompatibility(
    _ expected: CompatibilityResult,
    resolved: ResolvedCapture,
    content: SCShareableContent
) throws {
    guard expected.surfaceId == resolved.surfaceId,
          boundsMatch(expected.surfaceBounds, Bounds(resolved.bounds)),
          topologyMatches(expected.displayTopology, displayTopology(content)),
          let expectedApplication = expected.foregroundApplicationId,
          foregroundApplication()?.id == expectedApplication else {
        throw HelperError("TARGET_CHANGED", "The foreground application, window, or display layout changed.")
    }
}

private func optionalBoundsMatch(_ left: Bounds?, _ right: Bounds?) -> Bool {
    switch (left, right) {
    case (nil, nil): return true
    case let (.some(left), .some(right)): return boundsMatch(left, right)
    default: return false
    }
}

private func validatedElement(
    id: String,
    expected: ElementResult?,
    accessibility: AccessibilityResult
) throws -> (ElementResult, AXUIElement) {
    guard let expected = expected,
          expected.id == id,
          let current = accessibility.elements.first(where: { $0.id == id }),
          let handle = accessibility.handles[id],
          current.role == expected.role,
          current.label == expected.label,
          current.value == expected.value,
          current.actions == expected.actions,
          current.secure == expected.secure,
          optionalBoundsMatch(current.bounds, expected.bounds) else {
        throw HelperError("TARGET_CHANGED", "The requested interface element changed after observation.")
    }
    guard !current.secure else {
        throw HelperError("PERMISSION_DENIED", "Computer actions are not allowed on secure text fields.")
    }
    return (current, handle)
}

private func pointForTarget(
    _ target: ActionTargetRequest,
    expectedElement: ElementResult?,
    accessibility: AccessibilityResult,
    captureBounds: CGRect
) throws -> CGPoint {
    if target.mode == "element" {
        guard let id = target.elementId else {
            throw HelperError("BAD_MESSAGE", "The semantic action target is incomplete.")
        }
        let (_, handle) = try validatedElement(id: id, expected: expectedElement, accessibility: accessibility)
        guard let bounds = elementBounds(handle)?.rect, bounds.width > 0, bounds.height > 0 else {
            throw HelperError("TARGET_CHANGED", "The interface element no longer has actionable bounds.")
        }
        return CGPoint(x: bounds.midX, y: bounds.midY)
    }
    guard target.mode == "point", target.coordinateSpace == "capture", let point = target.point,
          point.x >= 0, point.y >= 0,
          point.x <= captureBounds.width, point.y <= captureBounds.height else {
        throw HelperError("BAD_MESSAGE", "The fallback action point is outside the observed capture.")
    }
    return CGPoint(x: captureBounds.minX + point.x, y: captureBounds.minY + point.y)
}

private func ensureForeground(_ applicationId: String) throws {
    guard foregroundApplication()?.id == applicationId else {
        throw HelperError("TARGET_CHANGED", "The foreground application changed before the action was dispatched.")
    }
}

private func postMouseClick(point: CGPoint, button: String, count: Int) throws {
    let downType: CGEventType
    let upType: CGEventType
    let mouseButton: CGMouseButton
    if button == "left" {
        downType = .leftMouseDown
        upType = .leftMouseUp
        mouseButton = .left
    } else if button == "right" {
        downType = .rightMouseDown
        upType = .rightMouseUp
        mouseButton = .right
    } else {
        throw HelperError("BAD_MESSAGE", "The mouse button is invalid.")
    }
    guard count == 1 || count == 2 else {
        throw HelperError("BAD_MESSAGE", "The click count is invalid.")
    }
    for index in 1...count {
        guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: mouseButton),
              let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: mouseButton) else {
            throw HelperError("INTERNAL_ERROR", "The mouse event could not be created.")
        }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

private func eventFlags(_ modifiers: [String]) throws -> CGEventFlags {
    var flags: CGEventFlags = []
    for modifier in modifiers {
        switch modifier {
        case "command": flags.insert(.maskCommand)
        case "control": flags.insert(.maskControl)
        case "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: throw HelperError("BAD_MESSAGE", "The keyboard modifier is invalid.")
        }
    }
    guard Set(modifiers).count == modifiers.count else {
        throw HelperError("BAD_MESSAGE", "Keyboard modifiers must be unique.")
    }
    return flags
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16,
    "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34,
    "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "enter": 36, "tab": 48, "backspace": 51, "escape": 53, "delete": 117,
    "home": 115, "end": 119, "page-up": 116, "page-down": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
]

private func postKey(code: CGKeyCode, flags: CGEventFlags) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        throw HelperError("INTERNAL_ERROR", "The keyboard event could not be created.")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

private func postText(_ text: String, expectedApplicationId: String) throws {
    let characters = Array(text.utf16)
    for offset in stride(from: 0, to: characters.count, by: 128) {
        try ensureForeground(expectedApplicationId)
        let chunk = Array(characters[offset..<min(offset + 128, characters.count)])
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            throw HelperError("INTERNAL_ERROR", "The text event could not be created.")
        }
        chunk.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

private func performAction(
    _ action: ActionRequest,
    expectedElement: ElementResult?,
    accessibility: AccessibilityResult,
    resolved: ResolvedCapture,
    expectedApplicationId: String
) throws {
    try ensureForeground(expectedApplicationId)
    switch action.kind {
    case "click":
        guard let target = action.target, let button = action.button, let count = action.clickCount else {
            throw HelperError("BAD_MESSAGE", "The click action is incomplete.")
        }
        if target.mode == "element", button == "left", count == 1, let id = target.elementId {
            let (element, handle) = try validatedElement(
                id: id,
                expected: expectedElement,
                accessibility: accessibility
            )
            if element.actions.contains(kAXPressAction as String) {
                try ensureForeground(expectedApplicationId)
                guard AXUIElementPerformAction(handle, kAXPressAction as CFString) == .success else {
                    throw HelperError("INTERNAL_ERROR", "The interface element could not be pressed.")
                }
                return
            }
        }
        let point = try pointForTarget(
            target,
            expectedElement: expectedElement,
            accessibility: accessibility,
            captureBounds: resolved.bounds
        )
        try ensureForeground(expectedApplicationId)
        try postMouseClick(point: point, button: button, count: count)
    case "type":
        guard let id = action.elementId, let text = action.text, !text.isEmpty,
              text.count <= 8_192, let replace = action.replace else {
            throw HelperError("BAD_MESSAGE", "The type action is incomplete.")
        }
        let (element, handle) = try validatedElement(
            id: id,
            expected: expectedElement,
            accessibility: accessibility
        )
        guard element.role.localizedCaseInsensitiveContains("text") ||
                element.role.localizedCaseInsensitiveContains("combo") else {
            throw HelperError("BAD_MESSAGE", "The selected element is not text editable.")
        }
        guard AXUIElementSetAttributeValue(
            handle,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        ) == .success else {
            throw HelperError("TARGET_CHANGED", "The text field could not be focused safely.")
        }
        try ensureForeground(expectedApplicationId)
        if replace { try postKey(code: 0, flags: .maskCommand) }
        try postText(text, expectedApplicationId: expectedApplicationId)
    case "key":
        guard let key = action.key?.lowercased(), let modifiers = action.modifiers,
              let code = keyCodes[key] else {
            throw HelperError("BAD_MESSAGE", "The key action is invalid.")
        }
        let flags = try eventFlags(modifiers)
        if key.count == 1 && !flags.contains(.maskCommand) && !flags.contains(.maskControl) {
            throw HelperError("BAD_MESSAGE", "Printable text must use the type action.")
        }
        try ensureForeground(expectedApplicationId)
        try postKey(code: code, flags: flags)
    case "scroll":
        guard let deltaX = action.deltaX, let deltaY = action.deltaY,
              abs(deltaX) <= 10_000, abs(deltaY) <= 10_000,
              deltaX != 0 || deltaY != 0 else {
            throw HelperError("BAD_MESSAGE", "The scroll action is invalid.")
        }
        let point = try action.target.map {
            try pointForTarget(
                $0,
                expectedElement: expectedElement,
                accessibility: accessibility,
                captureBounds: resolved.bounds
            )
        } ?? CGPoint(x: resolved.bounds.midX, y: resolved.bounds.midY)
        try ensureForeground(expectedApplicationId)
        guard let move = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: point,
            mouseButton: .left
        ), let scroll = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: Int32(-deltaY.rounded()),
            wheel2: Int32(-deltaX.rounded()),
            wheel3: 0
        ) else {
            throw HelperError("INTERNAL_ERROR", "The scroll event could not be created.")
        }
        move.post(tap: .cghidEventTap)
        scroll.post(tap: .cghidEventTap)
    default:
        throw HelperError("BAD_MESSAGE", "The computer action kind is invalid.")
    }
}

private func act(_ request: Request) async throws -> ActionReceipt {
    let currentPermissions = permissions()
    guard currentPermissions.canAct else {
        throw HelperError(
            "PERMISSION_DENIED",
            "Screen Recording and Accessibility permissions are required for computer actions."
        )
    }
    guard let actionId = request.actionId, actionId.count == 36,
          let sourceSnapshotId = request.sourceSnapshotId, !sourceSnapshotId.isEmpty,
          let target = request.target, target.kind != "display", target.pid != nil,
          let expected = request.compatibility,
          let expectedApplicationId = expected.foregroundApplicationId,
          let action = request.action else {
        throw HelperError("BAD_MESSAGE", "The computer action request is incomplete.")
    }
    let maxDepth = min(max(request.maxDepth ?? 12, 1), 20)
    let maxElements = min(max(request.maxElements ?? 400, 1), 1_000)
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let resolved = try resolveCapture(target: target, content: content)
    try validateCompatibility(expected, resolved: resolved, content: content)
    guard let pid = resolved.pid else {
        throw HelperError("BAD_MESSAGE", "The computer action target does not have an application.")
    }
    let accessibility = accessibilityTree(pid: pid, maxDepth: maxDepth, maxElements: maxElements)
    try performAction(
        action,
        expectedElement: request.element,
        accessibility: accessibility,
        resolved: resolved,
        expectedApplicationId: expectedApplicationId
    )
    return ActionReceipt(actionId: actionId, performedAt: ISO8601DateFormatter().string(from: Date()))
}

private func observe(_ request: Request) async throws -> ObservationResult {
    guard permissions().screenRecording == "granted" else {
        throw HelperError(
            "PERMISSION_DENIED",
            "Screen Recording permission is required. Enable it in System Settings > Privacy & Security."
        )
    }
    guard let snapshotId = request.snapshotId,
          let target = request.target,
          let screenshotPath = request.screenshotPath else {
        throw HelperError("BAD_MESSAGE", "The observation request is incomplete.")
    }
    let maxDepth = min(max(request.maxDepth ?? 12, 1), 20)
    let maxElements = min(max(request.maxElements ?? 400, 1), 1_000)
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let resolved = try resolveCapture(target: target, content: content)
    let accessibility = resolved.pid.map {
        accessibilityTree(pid: $0, maxDepth: maxDepth, maxElements: maxElements)
    } ?? AccessibilityResult(elements: [], handles: [:], truncated: false)

    let configuration = SCStreamConfiguration()
    let sourceWidth = max(resolved.filter.contentRect.width * CGFloat(resolved.filter.pointPixelScale), 1)
    let sourceHeight = max(resolved.filter.contentRect.height * CGFloat(resolved.filter.pointPixelScale), 1)
    let downscale = min(1, 4_096 / max(sourceWidth, sourceHeight))
    configuration.width = Int(max(1, sourceWidth * downscale))
    configuration.height = Int(max(1, sourceHeight * downscale))
    configuration.scalesToFit = true
    configuration.preservesAspectRatio = true
    configuration.showsCursor = false
    let captured = try await SCScreenshotManager.captureImage(
        contentFilter: resolved.filter,
        configuration: configuration
    )
    let image = redactedImage(captured, captureBounds: resolved.bounds, elements: accessibility.elements)
    try writePNG(image, path: screenshotPath)

    var warnings: [String] = []
    if permissions().accessibility != "granted" {
        warnings.append("Accessibility permission is not granted; structured elements are unavailable.")
    }
    if let warning = resolved.warning { warnings.append(warning) }
    let scale = resolved.bounds.width > 0 ? Double(image.width) / resolved.bounds.width : 1
    let foreground = foregroundApplication()
    return ObservationResult(
        version: observationVersion,
        snapshotId: snapshotId,
        observedAt: ISO8601DateFormatter().string(from: Date()),
        target: target,
        foregroundApplication: foreground,
        compatibility: CompatibilityResult(
            surfaceId: resolved.surfaceId,
            surfaceBounds: Bounds(resolved.bounds),
            displayTopology: displayTopology(content),
            foregroundApplicationId: foreground?.id
        ),
        capture: CaptureResult(
            bounds: Bounds(resolved.bounds),
            displayScale: scale,
            pixelWidth: image.width,
            pixelHeight: image.height,
            screenshotCaptured: true,
            ocrText: try recognizedText(in: image)
        ),
        elements: accessibility.elements,
        truncated: accessibility.truncated,
        warnings: warnings
    )
}

private func emit<Value: Encodable>(_ response: Value) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(response) else { exit(70) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

@main
private struct DSHComputerHelper {
    static func main() async {
        var requestId = "unknown"
        do {
            let input = FileHandle.standardInput.readDataToEndOfFile()
            let request = try JSONDecoder().decode(Request.self, from: input)
            requestId = request.id
            guard request.version == protocolVersion, !request.id.isEmpty, request.id.count <= 128 else {
                throw HelperError("BAD_MESSAGE", "The native helper request is invalid.")
            }
            switch request.method {
            case "permissions":
                emit(SuccessResponse(version: protocolVersion, id: request.id, result: permissions()))
            case "listTargets":
                emit(SuccessResponse(version: protocolVersion, id: request.id, result: try await targetList()))
            case "observe":
                emit(SuccessResponse(version: protocolVersion, id: request.id, result: try await observe(request)))
            case "act":
                emit(SuccessResponse(version: protocolVersion, id: request.id, result: try await act(request)))
            default:
                throw HelperError("METHOD_NOT_FOUND", "The native helper method is not available.")
            }
        } catch let error as HelperError {
            emit(FailureResponse(
                version: protocolVersion,
                id: requestId,
                error: ErrorBody(code: error.code, message: error.message)
            ))
            exit(1)
        } catch {
            emit(FailureResponse(
                version: protocolVersion,
                id: requestId,
                error: ErrorBody(code: "INTERNAL_ERROR", message: "The native helper operation failed.")
            ))
            exit(1)
        }
    }
}
