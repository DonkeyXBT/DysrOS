/**
 * IMAP connection presets.
 *
 * Hostnames and ports are prefilled so the user picks a provider rather than
 * hunting for settings, but every field stays editable — a preset is a starting
 * point, and the connection test is what actually confirms it.
 */
export interface ProviderPreset {
  id: string
  label: string
  host: string
  port: number
  useTls: boolean
  /** Whether the provider rejects the ordinary account password over IMAP.
   *  Surfaced in the account form, because this is where setup usually fails. */
  requiresAppPassword: boolean
  setupNote: string | null
  /** Address domains that imply this provider. */
  domains: readonly string[]
}

export const PROVIDERS: readonly ProviderPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    useTls: true,
    requiresAppPassword: true,
    setupNote:
      'Gmail rejects your normal password over IMAP. Turn on 2-step verification, then create an App password and paste it here — spaces and all, they are taken out for you.',
    domains: ['gmail.com', 'googlemail.com'],
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    host: 'outlook.office365.com',
    port: 993,
    useTls: true,
    requiresAppPassword: false,
    setupNote:
      'If your account uses 2-step verification, create an app password. Some work accounts have IMAP disabled by an administrator.',
    domains: ['outlook.com', 'hotmail.com', 'hotmail.nl', 'live.com', 'live.nl', 'msn.com'],
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    host: 'imap.mail.yahoo.com',
    port: 993,
    useTls: true,
    requiresAppPassword: true,
    setupNote:
      'Yahoo rejects your normal password over IMAP. Generate an App password in Account Security and paste it here as shown.',
    domains: ['yahoo.com', 'yahoo.co.uk', 'yahoo.nl', 'ymail.com'],
  },
  {
    id: 'webde',
    label: 'web.de',
    host: 'imap.web.de',
    port: 993,
    useTls: true,
    requiresAppPassword: false,
    setupNote:
      'web.de keeps IMAP switched off until you enable it. Turn on IMAP access in the web.de settings before connecting.',
    domains: ['web.de'],
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    host: 'imap.mail.me.com',
    port: 993,
    useTls: true,
    requiresAppPassword: true,
    setupNote:
      'iCloud requires an app-specific password from your Apple Account security settings. Paste it as shown; the dashes are taken out for you.',
    domains: ['icloud.com', 'me.com', 'mac.com'],
  },
  {
    id: 'namecheap',
    label: 'Namecheap Private Email',
    host: 'mail.privateemail.com',
    port: 993,
    useTls: true,
    requiresAppPassword: false,
    setupNote:
      'Private Email uses one shared hostname for every custom domain. Sign in with the full address as the username.',
    domains: [],
  },
  {
    id: 'custom',
    label: 'Other (enter details manually)',
    host: '',
    port: 993,
    useTls: true,
    requiresAppPassword: false,
    setupNote: null,
    domains: [],
  },
]

export function providerIds(): string[] {
  return PROVIDERS.map((preset) => preset.id)
}

export function presetFor(id: string): ProviderPreset {
  const preset = PROVIDERS.find((candidate) => candidate.id === id)
  if (!preset) throw new Error(`Unknown provider: ${id}`)
  return preset
}

/**
 * Suggests a provider from an address domain. Returns null for a custom domain
 * rather than guessing — a wrong hostname produces a confusing connection
 * failure, and Namecheap in particular cannot be inferred from the domain.
 */
export function presetForEmail(email: string): ProviderPreset | null {
  const domain = email.trim().toLowerCase().split('@')[1]
  if (!domain) return null
  return PROVIDERS.find((preset) => preset.domains.includes(domain)) ?? null
}
