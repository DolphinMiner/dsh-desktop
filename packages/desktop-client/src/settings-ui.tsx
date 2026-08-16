import type { ReactNode } from 'react'

const styles = `
.dsh-desktop-settings-page,
.dsh-desktop-settings-page * {
  box-sizing: border-box;
  letter-spacing: 0;
}
.dsh-desktop-settings-page {
  color: var(--dsw-alias-label-primary, #17191c);
  width: 100%;
  min-width: 0;
  padding: 2px 4px 28px;
}
.dsh-desktop-settings-header {
  margin: 0 0 24px;
}
.dsh-desktop-settings-title {
  font-size: 22px;
  font-weight: 500;
  line-height: 30px;
  margin: 0;
}
.dsh-desktop-settings-subtitle {
  color: var(--dsw-alias-label-tertiary, #74777d);
  font-size: 13px;
  line-height: 20px;
  margin: 3px 0 0;
}
.dsh-desktop-settings-section {
  margin-top: 22px;
}
.dsh-desktop-settings-section-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  margin: 0 0 8px;
}
.dsh-desktop-settings-group {
  border: 1px solid var(--dsw-alias-border-l2, #deded9);
  border-radius: 8px;
  overflow: hidden;
}
.dsh-desktop-settings-row {
  align-items: center;
  display: flex;
  gap: 16px;
  justify-content: space-between;
  min-height: 58px;
  padding: 10px 14px;
}
.dsh-desktop-settings-row + .dsh-desktop-settings-row {
  border-top: 1px solid var(--dsw-alias-border-l1, #ecece8);
}
.dsh-desktop-settings-row-leading {
  align-items: center;
  display: flex;
  gap: 12px;
  min-width: 0;
}
.dsh-desktop-settings-row-icon {
  align-items: center;
  background: var(--dsw-alias-bg-overlay, #f2f2ef);
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary, #45484d);
  display: flex;
  flex: 0 0 34px;
  height: 34px;
  justify-content: center;
  width: 34px;
}
.dsh-desktop-settings-row-copy {
  min-width: 0;
}
.dsh-desktop-settings-row-title {
  display: block;
  font-size: 13px;
  font-weight: 500;
  line-height: 19px;
  overflow-wrap: anywhere;
}
.dsh-desktop-settings-row-description {
  color: var(--dsw-alias-label-tertiary, #74777d);
  display: block;
  font-size: 12px;
  line-height: 18px;
  margin-top: 1px;
  overflow-wrap: anywhere;
}
.dsh-desktop-settings-control {
  flex: 0 0 auto;
  min-width: 0;
}
.dsh-desktop-settings-toggle {
  background: var(--dsw-alias-border-l4, #b5b7ba);
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  height: 20px;
  padding: 2px;
  position: relative;
  transition: background-color 120ms ease;
  width: 34px;
}
.dsh-desktop-settings-toggle[aria-checked="true"] {
  background: var(--dsw-alias-state-business-primary, #2f9cf4);
}
.dsh-desktop-settings-toggle:disabled {
  cursor: default;
  opacity: .5;
}
.dsh-desktop-settings-toggle::after {
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 1px 2px #0003;
  content: "";
  display: block;
  height: 16px;
  transform: translateX(0);
  transition: transform 120ms ease;
  width: 16px;
}
.dsh-desktop-settings-toggle[aria-checked="true"]::after {
  transform: translateX(14px);
}
.dsh-desktop-settings-select {
  background: var(--dsw-alias-bg-overlay, #f5f5f2);
  border: 0;
  border-radius: 7px;
  color: var(--dsw-alias-label-primary, #17191c);
  font: inherit;
  font-size: 12px;
  height: 30px;
  max-width: 220px;
  min-width: 96px;
  padding: 0 26px 0 10px;
}
.dsh-desktop-settings-select:focus-visible,
.dsh-desktop-settings-toggle:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #2f9cf4);
  outline-offset: 2px;
}
.dsh-desktop-settings-grid {
  align-items: start;
  display: grid;
  gap: 18px;
  grid-template-columns: minmax(0, 1fr) minmax(210px, .88fr);
  margin-top: 18px;
}
.dsh-desktop-settings-preview {
  aspect-ratio: 16 / 10;
  background: var(--dsw-alias-bg-overlay, #f2f2ef);
  border: 1px solid var(--dsw-alias-border-l2, #deded9);
  border-radius: 8px;
  display: grid;
  overflow: hidden;
  place-items: center;
  position: relative;
  width: 100%;
}
.dsh-desktop-settings-preview img {
  height: 100%;
  object-fit: contain;
  width: 100%;
}
.dsh-desktop-settings-preview-empty {
  color: var(--dsw-alias-label-tertiary, #74777d);
  font-size: 12px;
  padding: 20px;
  text-align: center;
}
.dsh-desktop-settings-preview-caption {
  background: color-mix(in srgb, var(--dsw-alias-bg-module-platform, #fff) 88%, transparent);
  bottom: 0;
  color: var(--dsw-alias-label-secondary, #45484d);
  font-size: 11px;
  left: 0;
  line-height: 17px;
  overflow: hidden;
  padding: 6px 8px;
  position: absolute;
  right: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-desktop-settings-notice {
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary, #45484d);
  font-size: 12px;
  line-height: 18px;
  margin-top: 12px;
  padding: 8px 10px;
}
.dsh-desktop-settings-notice[data-level="error"] {
  background: var(--dsw-alias-interactive-bg-hover-danger, #fdefed);
  color: var(--dsw-alias-state-error-primary, #b42318);
}
.dsh-desktop-settings-notice[data-level="info"] {
  background: var(--dsw-alias-interactive-bg-hover, #f2f2ef);
}
@media (max-width: 720px) {
  .dsh-desktop-settings-page { padding-inline: 0; }
  .dsh-desktop-settings-grid { grid-template-columns: minmax(0, 1fr); }
  .dsh-desktop-settings-row { align-items: flex-start; flex-wrap: wrap; }
  .dsh-desktop-settings-control { margin-left: auto; }
  .dsh-desktop-settings-select { max-width: min(100%, 220px); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-desktop-settings-toggle,
  .dsh-desktop-settings-toggle::after { transition: none; }
}
`

export function SettingsPage({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="dsh-desktop-settings-page" aria-label={title}>
      <style>{styles}</style>
      <header className="dsh-desktop-settings-header">
        <h2 className="dsh-desktop-settings-title">{title}</h2>
        {subtitle !== undefined && <p className="dsh-desktop-settings-subtitle">{subtitle}</p>}
      </header>
      {children}
    </section>
  )
}

export function SettingsSection({ title, children }: { title?: string; children: ReactNode }): React.JSX.Element {
  return (
    <section className="dsh-desktop-settings-section">
      {title !== undefined && <h3 className="dsh-desktop-settings-section-title">{title}</h3>}
      {children}
    </section>
  )
}

export function SettingsGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="dsh-desktop-settings-group">{children}</div>
}

export function SettingsRow({
  title,
  description,
  icon,
  control,
}: {
  title: string
  description?: string
  icon?: ReactNode
  control?: ReactNode
}): React.JSX.Element {
  return (
    <div className="dsh-desktop-settings-row">
      <div className="dsh-desktop-settings-row-leading">
        {icon !== undefined && <span className="dsh-desktop-settings-row-icon" aria-hidden="true">{icon}</span>}
        <span className="dsh-desktop-settings-row-copy">
          <span className="dsh-desktop-settings-row-title">{title}</span>
          {description !== undefined && (
            <span className="dsh-desktop-settings-row-description">{description}</span>
          )}
        </span>
      </div>
      {control !== undefined && <span className="dsh-desktop-settings-control">{control}</span>}
    </div>
  )
}

export function SettingsToggle({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="dsh-desktop-settings-toggle"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

export function SettingsSelect({
  value,
  label,
  disabled,
  onChange,
  children,
}: {
  value: string
  label: string
  disabled?: boolean
  onChange: (value: string) => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <select
      className="dsh-desktop-settings-select"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={event => onChange(event.target.value)}
    >
      {children}
    </select>
  )
}

export function SettingsNotice({
  level,
  children,
}: {
  level: 'info' | 'error'
  children: ReactNode
}): React.JSX.Element {
  return <div className="dsh-desktop-settings-notice" data-level={level} role={level === 'error' ? 'alert' : 'status'}>{children}</div>
}
