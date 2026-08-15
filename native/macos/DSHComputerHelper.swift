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

private func applicationTarget(_ application: NSRunningApplication) -> Target? {
    guard application.activationPolicy == .regular,
          !application.isTerminated,
          let name = application.localizedName,
          !name.isEmpty else { return nil }
    let bundle = application.bundleIdentifier
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
            applicationName: owner.applicationName,
            bundleId: owner.bundleIdentifier,
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
        return AccessibilityResult(elements: [], truncated: false)
    }
    let root = AXUIElementCreateApplication(pid)
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var elements: [ElementResult] = []
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
        elements.append(ElementResult(
            id: "ax:\(elements.count)",
            role: role,
            label: label,
            value: secure ? nil : stringAttribute(element, kAXValueAttribute as CFString),
            actions: actions,
            bounds: elementBounds(element),
            secure: secure
        ))

        guard depth < maxDepth,
              let childrenValue = copyAttribute(element, kAXChildrenAttribute as CFString),
              let children = childrenValue as? [AXUIElement] else { continue }
        let remaining = max(0, maxElements - elements.count - queue.count)
        if children.count > remaining { truncated = true }
        queue.append(contentsOf: children.prefix(remaining).map { ($0, depth + 1) })
    }
    return AccessibilityResult(elements: elements, truncated: truncated)
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
    } ?? AccessibilityResult(elements: [], truncated: false)

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
