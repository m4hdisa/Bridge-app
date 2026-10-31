// Checks GitHub Releases for a newer Bridge and installs it when the user asks.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { app, net } from 'electron'
import type { UpdateStatus } from '../shared/types'
import { isNewer } from '../shared/version'

const REPO = 'm4hdisa/Bridge-app'

interface GithubRelease {
  tag_name: string
  name?: string
  body?: string
  html_url: string
  draft?: boolean
  prerelease?: boolean
  assets: { name: string; browser_download_url: string; size: number }[]
}

/** Asks GitHub for the latest release. Returns the update when it is newer than this build. */
export async function checkForUpdate(current = app.getVersion()): Promise<UpdateStatus> {
  // net.fetch uses Chromium's network stack, so it follows the Windows proxy settings.
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Bridge/${current}` }
  })
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`)
  const r = (await res.json()) as GithubRelease
  const version = r.tag_name.replace(/^v/, '')
  if (!isNewer(version, current)) return { state: 'latest', current, checkedAt: Date.now() }
  const asset = r.assets.find((a) => /\.exe$/i.test(a.name))
  return {
    state: 'available',
    current,
    checkedAt: Date.now(),
    update: { version, title: r.name || `Bridge ${version}`, notes: r.body || '', pageUrl: r.html_url, installerUrl: asset?.browser_download_url, size: asset?.size }
  }
}

/** Downloads the installer into the temp folder, reporting progress from 0 to 1. */
export async function downloadInstaller(url: string, onProgress: (fraction: number) => void): Promise<string> {
  const res = await net.fetch(url)
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  const file = join(app.getPath('temp'), `Bridge-Setup-${Date.now()}.exe`)
  const out = createWriteStream(file)
  let received = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      if (total) onProgress(received / total)
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
  }
  if (total && received !== total) throw new Error('Download was cut off; try again')
  return file
}

/**
 * Runs the installer silently over the current install and starts Bridge again afterwards
 * (electron-builder's NSIS supports /S and --force-run). The caller quits the app right after.
 */
export function runInstaller(file: string): void {
  spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
}
