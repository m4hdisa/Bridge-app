// The UI's languages. English text is the key: t('Connect') is "Connect" in English and its
// entry in the Persian dictionary (i18n-fa.ts) in Persian, or the English again if it has none.
// Placeholders are written {name}: t('Connected for {time}', { time }).
import { fa } from './i18n-fa'

export type Lang = 'en' | 'fa'

let current: Lang = 'en'

/** Switches the language, and with it the page direction (Persian reads right to left). */
export function setLanguage(lang: Lang): void {
  current = lang
  const root = document.documentElement
  if (root.lang !== lang) root.lang = lang
  const dir = lang === 'fa' ? 'rtl' : 'ltr'
  if (root.dir !== dir) root.dir = dir
}

export function language(): Lang {
  return current
}

export const isRtl = () => current === 'fa'

export function t(text: string, vars?: Record<string, string | number>): string {
  let s = current === 'fa' ? (fa[text] ?? text) : text
  if (vars) s = s.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m))
  return s
}

/**
 * Yekan Bakh, for Persian. A commercial font, so it isn't in the public repository: it's loaded
 * from the app's own files when present, and the system font is used when it isn't.
 */
export function loadPersianFont(): void {
  const weights: [string, string][] = [
    ['Light', '300'],
    ['Regular', '400'],
    ['SemiBold', '600'],
    ['Bold', '700']
  ]
  for (const [name, weight] of weights) {
    const face = new FontFace('Yekan Bakh', `url(fonts/yekan-bakh/YekanBakh-${name}.woff2) format('woff2')`, { weight, display: 'swap' })
    face.load().then(
      (f) => document.fonts.add(f),
      () => undefined
    )
  }
}
