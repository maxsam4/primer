import * as blocknote from '@blocknote/core/locales';
import en from './en.json';
import de from './de.json';
import es from './es.json';
import fr from './fr.json';
import ja from './ja.json';
import zh from './zh.json';

/**
 * Primer's own UI strings (BlockNote's editor strings have their own
 * dictionaries; both follow the same locale). No library: `en.json` is the
 * source of truth, each other locale has every key, and `t` fills `{name}`
 * placeholders.
 */
export type MessageKey = keyof typeof en;
export type Locale = 'en' | 'de' | 'es' | 'fr' | 'ja' | 'zh';

const messages: Record<Locale, Record<MessageKey, string>> = { en, de, es, fr, ja, zh };
const blocknoteDictionaries = { en: blocknote.en, de: blocknote.de, es: blocknote.es, fr: blocknote.fr, ja: blocknote.ja, zh: blocknote.zh };

/** The supported locale for a browser language tag (`de-AT` is `de`); `en` otherwise. */
export function resolveLocale(language: string | undefined): Locale {
  const base = (language ?? 'en').toLowerCase().split('-')[0] as Locale;
  return base in messages ? base : 'en';
}

const locale = resolveLocale(typeof navigator === 'undefined' ? undefined : navigator.language);

// The page's own language, for screen readers and hyphenation (index.html says "en").
if (typeof document !== 'undefined') document.documentElement.lang = locale;

export function currentLocale(): Locale {
  return locale;
}

/** BlockNote's editor dictionary for the same locale. */
export function editorDictionary() {
  return blocknoteDictionaries[locale];
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = messages[locale][key] ?? en[key];
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : text;
}
