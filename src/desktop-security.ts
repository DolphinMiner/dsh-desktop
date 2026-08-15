export function isTrustedDesktopBridgeSender(
  senderUrl: string,
  loadingPageUrl: string,
  harnessOrigin?: string,
): boolean {
  if (senderUrl === loadingPageUrl) return true
  if (harnessOrigin === undefined) return false
  try {
    const sender = new URL(senderUrl)
    const harness = new URL(harnessOrigin)
    return sender.origin === harness.origin && sender.protocol === 'http:' &&
      sender.hostname === '127.0.0.1'
  } catch {
    return false
  }
}
