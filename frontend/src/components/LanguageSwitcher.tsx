import { useTranslation } from 'react-i18next';
import { Button } from "./ui/button";

export function LanguageSwitcher() {
    const { i18n } = useTranslation();

    const toggleLanguage = () => {
        const newLang = i18n.language === 'en' ? 'th' : 'en';
        i18n.changeLanguage(newLang);
    };

    return (
        <Button
            variant="ghost"
            size="sm"
            onClick={toggleLanguage}
            className="w-10 h-8 p-0 font-bold border rounded-md"
        >
            {i18n.language === 'en' ? 'TH' : 'EN'}
        </Button>
    );
}
