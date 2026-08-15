export function isTrustedDesktopBridgeSender(senderUrl: string, loadingPageUrl: string): boolean {
  return senderUrl === loadingPageUrl
}
