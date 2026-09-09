import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from '../locales/en.json';
import th from '../locales/th.json';

type SupportedLanguage = 'en' | 'th';

function normalizeLanguage(language?: string): SupportedLanguage {
    return language?.toLowerCase().startsWith('th') ? 'th' : 'en';
}

function syncDocumentLanguage(language?: string) {
    if (typeof document !== 'undefined') {
        document.documentElement.lang = normalizeLanguage(language);
    }
}

i18n.on('languageChanged', syncDocumentLanguage);

i18n
    // detect user language
    .use(LanguageDetector)
    // pass the i18n instance to react-i18next.
    .use(initReactI18next)
    // init i18next
    .init({
        resources: {
            en: {
                translation: en
            },
            th: {
                translation: th
            }
        },
        supportedLngs: ['en', 'th'],
        nonExplicitSupportedLngs: true,
        fallbackLng: 'en',
        debug: true,

        interpolation: {
            escapeValue: false, // not needed for react as it escapes by default
        }
    })
    .then(() => syncDocumentLanguage(i18n.resolvedLanguage));

export default i18n;
