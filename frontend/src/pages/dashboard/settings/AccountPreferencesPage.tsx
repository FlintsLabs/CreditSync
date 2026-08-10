import { useEffect, useState } from "react";
import { Languages, LogOut, Palette, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useTheme, type Theme } from "../../../components/theme-provider";
import { Avatar, AvatarFallback, AvatarImage } from "../../../components/ui/avatar";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader } from "../../../components/ui/Card";
import { signOut } from "../../../lib/account";
import { getStoredUser } from "../../../lib/session";
import { cn } from "../../../lib/utils";

type Language = "en" | "th";
type Role = "owner" | "manager" | "collector" | "viewer";

const roles = new Set<Role>(["owner", "manager", "collector", "viewer"]);

const choiceClass = (selected: boolean) => cn(
    "min-h-11 rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    selected
        ? "border-primary bg-primary text-primary-foreground"
        : "border-input bg-background text-foreground hover:bg-accent",
);

export default function AccountPreferencesPage() {
    const { t, i18n } = useTranslation();
    const { theme, setTheme } = useTheme();
    const location = useLocation();
    const navigate = useNavigate();
    const user = getStoredUser();
    const initialLanguage: Language = i18n.resolvedLanguage?.startsWith("th") ? "th" : "en";
    const [language, setLanguage] = useState<Language>(initialLanguage);
    const [announcement, setAnnouncement] = useState("");

    const displayName = user?.name?.trim() || t("accountPreferences.profile.unknownName");
    const email = user?.email?.trim() || t("accountPreferences.profile.unknownEmail");
    const role = user?.role && roles.has(user.role as Role)
        ? t(`accountPreferences.roles.${user.role}`)
        : t("accountPreferences.profile.unknownRole");
    const avatarFallback = user?.name?.trim().charAt(0).toUpperCase() || "U";

    useEffect(() => {
        if (location.hash !== "#profile" && location.hash !== "#preferences") return;
        const element = document.getElementById(location.hash.slice(1));
        if (!element) return;

        const frame = requestAnimationFrame(() => {
            element.scrollIntoView?.({ block: "start" });
            element.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
    }, [location.hash]);

    const changeLanguage = async (nextLanguage: Language) => {
        setLanguage(nextLanguage);
        try {
            await i18n.changeLanguage(nextLanguage);
            setAnnouncement(i18n.t("accountPreferences.preferences.changed", {
                preference: i18n.t("accountPreferences.preferences.language"),
                value: i18n.t(`accountPreferences.preferences.${nextLanguage === "th" ? "thai" : "english"}`),
            }));
        } catch {
            setAnnouncement(t("accountPreferences.preferences.notPersisted"));
        }
    };

    const changeTheme = (nextTheme: Theme) => {
        const persisted = setTheme(nextTheme);
        setAnnouncement(persisted
            ? t("accountPreferences.preferences.changed", {
                preference: t("accountPreferences.preferences.appearance"),
                value: t(`accountPreferences.preferences.${nextTheme}`),
            })
            : t("accountPreferences.preferences.notPersisted"));
    };

    const languages: Array<{ value: Language; label: string }> = [
        { value: "th", label: t("accountPreferences.preferences.thai") },
        { value: "en", label: t("accountPreferences.preferences.english") },
    ];
    const themes: Array<{ value: Theme; label: string }> = [
        { value: "light", label: t("accountPreferences.preferences.light") },
        { value: "dark", label: t("accountPreferences.preferences.dark") },
        { value: "system", label: t("accountPreferences.preferences.system") },
    ];

    return (
        <div className="mx-auto w-full max-w-4xl space-y-6">
            <header className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight">{t("accountPreferences.title")}</h1>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                    {t("accountPreferences.description")}
                </p>
            </header>

            <Card>
                <section id="profile" aria-labelledby="profile-heading" tabIndex={-1} className="scroll-mt-24 outline-none">
                    <CardHeader className="flex-row items-start gap-3 space-y-0">
                        <UserRound aria-hidden="true" className="mt-1 h-5 w-5 text-muted-foreground" />
                        <div>
                            <h2 id="profile-heading" className="text-xl font-semibold">{t("accountPreferences.profile.title")}</h2>
                            <p className="mt-1 text-sm text-muted-foreground">{t("accountPreferences.profile.description")}</p>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="flex items-center gap-4">
                            <Avatar className="h-16 w-16">
                                <AvatarImage src={user?.picture} alt={user?.name || ""} />
                                <AvatarFallback className="text-lg font-semibold">{avatarFallback}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                                <p className="truncate text-lg font-semibold">{displayName}</p>
                                <p className="truncate text-sm text-muted-foreground">{email}</p>
                            </div>
                        </div>
                        <dl className="grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-3">
                            <div><dt className="text-xs font-medium uppercase text-muted-foreground">{t("accountPreferences.profile.name")}</dt><dd className="mt-1 break-words text-sm font-medium">{displayName}</dd></div>
                            <div><dt className="text-xs font-medium uppercase text-muted-foreground">{t("accountPreferences.profile.email")}</dt><dd className="mt-1 break-words text-sm font-medium">{email}</dd></div>
                            <div><dt className="text-xs font-medium uppercase text-muted-foreground">{t("accountPreferences.profile.role")}</dt><dd className="mt-1 text-sm font-medium">{role}</dd></div>
                        </dl>
                    </CardContent>
                </section>
            </Card>

            <Card>
                <section id="preferences" aria-labelledby="preferences-heading" tabIndex={-1} className="scroll-mt-24 outline-none">
                    <CardHeader className="flex-row items-start gap-3 space-y-0">
                        <Palette aria-hidden="true" className="mt-1 h-5 w-5 text-muted-foreground" />
                        <div>
                            <h2 id="preferences-heading" className="text-xl font-semibold">{t("accountPreferences.preferences.title")}</h2>
                            <p className="mt-1 text-sm text-muted-foreground">{t("accountPreferences.preferences.description")}</p>
                        </div>
                    </CardHeader>
                    <CardContent className="grid gap-6 md:grid-cols-2">
                        <fieldset className="space-y-3">
                            <legend className="flex items-center gap-2 text-sm font-semibold"><Languages aria-hidden="true" className="h-4 w-4" />{t("accountPreferences.preferences.language")}</legend>
                            <div className="flex flex-wrap gap-2">
                                {languages.map((option) => <button key={option.value} type="button" aria-pressed={language === option.value} className={choiceClass(language === option.value)} onClick={() => void changeLanguage(option.value)}>{option.label}</button>)}
                            </div>
                        </fieldset>
                        <fieldset className="space-y-3">
                            <legend className="text-sm font-semibold">{t("accountPreferences.preferences.appearance")}</legend>
                            <div className="flex flex-wrap gap-2">
                                {themes.map((option) => <button key={option.value} type="button" aria-pressed={theme === option.value} className={choiceClass(theme === option.value)} onClick={() => changeTheme(option.value)}>{option.label}</button>)}
                            </div>
                        </fieldset>
                        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>
                    </CardContent>
                </section>
            </Card>

            <Card>
                <section aria-labelledby="session-heading">
                    <CardHeader>
                        <h2 id="session-heading" className="text-xl font-semibold">{t("accountPreferences.session.title")}</h2>
                        <p className="text-sm text-muted-foreground">{t("accountPreferences.session.description")}</p>
                    </CardHeader>
                    <CardContent className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                        <p className="text-sm text-muted-foreground">{t("accountPreferences.session.signedInAs", { email })}</p>
                        <Button variant="destructive" className="min-h-11 gap-2" onClick={() => signOut(navigate)}>
                            <LogOut aria-hidden="true" className="h-4 w-4" />
                            {t("accountPreferences.session.signOut")}
                        </Button>
                    </CardContent>
                </section>
            </Card>
        </div>
    );
}
