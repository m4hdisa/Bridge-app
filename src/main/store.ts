// Persists app state (servers, subscriptions, app rules, settings) as JSON in the user data folder.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppState, Settings } from '../shared/types'


export const DEFAULT_SETTINGS: Settings = {
  mode: 'per-app',
  bypassIran: true,
  mixedPort: 2080,
  testUrl: 'https://www.gstatic.com/generate_204',
  strictRoute: false,
  dnsMode: 'real',
  logLevel: 'info'
}

export class Store {
  state: AppState

  constructor(private file: string) {
    this.state = this.load()
  }

  private load(): AppState {
    const empty: AppState = { servers: [], subscriptions: [], appRules: [], settings: { ...DEFAULT_SETTINGS } }
    if (!existsSync(this.file)) return empty
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AppState>
      // Only keep known settings, so options removed in newer versions disappear.
      const settings = { ...DEFAULT_SETTINGS }
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        if (saved.settings?.[key] !== undefined) Object.assign(settings, { [key]: saved.settings[key] })
      }
      return { ...empty, ...saved, settings }
    } catch {
      // Keep the broken file for inspection and start fresh.
      renameSync(this.file, this.file + '.broken')
      return empty
    }
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.file)
  }

  update(fn: (s: AppState) => void): void {
    fn(this.state)
    this.save()
  }
}
