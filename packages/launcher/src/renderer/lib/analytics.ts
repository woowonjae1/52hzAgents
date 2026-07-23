import posthog from "posthog-js"

const POSTHOG_KEY = "phc_t27xjrx9U42B54arcMwpiBgQxEFikBzXGnvzVtFEGtpf"

export function initAnalytics(): void {
  // Telemetry disabled for local-first privacy
}

export function capture(_event: string, _properties?: Record<string, unknown>): void {
  // Telemetry disabled for local-first privacy
}

export function group(_groupType: string, _groupKey: string, _properties?: Record<string, unknown>): void {
  // Telemetry disabled for local-first privacy
}
