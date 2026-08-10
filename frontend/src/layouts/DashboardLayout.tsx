import { useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Users, Wallet, FileText, Settings, Activity, Menu, X, ArrowRightLeft, ScanSearch, Inbox } from "lucide-react";
import { cn } from "../lib/utils";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import AppBar, { UserAccountMenu } from "../components/AppBar";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/Button";
import { getStoredUser, isTenantAdminUser } from "../lib/session";

export default function DashboardLayout() {
    const location = useLocation();
    const { t } = useTranslation();
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const currentUser = getStoredUser();
    const isTenantAdmin = isTenantAdminUser(currentUser);

    const navigation = [
        ...(isTenantAdmin ? [{ name: t("nav.dashboard", "Dashboard"), href: "/dashboard", icon: LayoutDashboard }] : []),
        { name: t("dashboard.borrowers", "Borrowers"), href: "/borrowers", icon: Users },
        { name: t("dashboard.loans", "Loans"), href: "/loans", icon: FileText },
        { name: t("nav.transactions", "Transactions"), href: "/transactions", icon: Activity },
        { name: t("nav.payments"), href: "/payments", icon: Inbox },
        ...(isTenantAdmin ? [
            { name: t("nav.matching", "Matching"), href: "/matching", icon: ArrowRightLeft },
            { name: t("nav.reconciliation", "Reconciliation"), href: "/reconciliation", icon: ScanSearch },
            { name: t("dashboard.funds", "Funds"), href: "/funds", icon: Wallet },
        ] : []),
        { name: t("nav.settings", "Settings"), href: "/dashboard/settings", icon: Settings },
    ];

    return (
        <div className="flex min-h-screen bg-background text-foreground transition-colors duration-300">
            {/* Desktop Sidebar (Hidden on Mobile) */}
            <div className="hidden w-64 flex-col border-r bg-card md:flex sticky top-0 h-screen overflow-y-auto">
                <AppBar />
                <div className="flex flex-1 flex-col gap-1 p-4">
                    {navigation.map((item) => {
                        const Icon = item.icon;
                        const isActive = location.pathname === item.href;
                        return (
                            <Link
                                key={item.href}
                                to={item.href}
                                className={cn(
                                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                                    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                                )}
                            >
                                <Icon className="h-4 w-4" />
                                {item.name}
                            </Link>
                        );
                    })}
                </div>
                <div className="p-4 mt-auto border-t">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">{t("nav.language", "Language")}</span>
                        <LanguageSwitcher />
                    </div>
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex flex-1 flex-col min-w-0">
                {/* Mobile Header (Visible only on Mobile) */}
                <header className="sticky top-0 z-30 flex h-16 items-center border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="-ml-2 mr-2"
                        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                    >
                        {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
                    </Button>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                        <img aria-hidden="true" className="h-7 w-7 shrink-0 rounded-md" src="/favicon.svg" />
                        <span className="truncate text-lg font-bold">CreditSync</span>
                    </div>
                    <UserAccountMenu />
                </header>

                {/* Mobile Sidebar Overlay (Slide-in) */}
                {isMobileMenuOpen && (
                    <div className="fixed inset-0 z-40 flex md:hidden">
                        {/* Backdrop */}
                        <div
                            className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
                            onClick={() => setIsMobileMenuOpen(false)}
                        />

                        {/* Sidebar Panel */}
                        <div className="relative flex w-[80%] max-w-xs flex-col bg-card shadow-2xl animate-in slide-in-from-left duration-300">
                            <div className="p-4 border-b">
                                <AppBar showAccount={false} />
                            </div>

                            <div className="flex-1 overflow-y-auto p-4">
                                <nav className="flex flex-col gap-1">
                                    {navigation.map((item) => {
                                        const Icon = item.icon;
                                        const isActive = location.pathname === item.href;
                                        return (
                                            <Link
                                                key={item.href}
                                                to={item.href}
                                                onClick={() => setIsMobileMenuOpen(false)}
                                                className={cn(
                                                    "flex items-center gap-3 rounded-md px-3 py-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                                                    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                                                )}
                                            >
                                                <Icon className="h-5 w-5" />
                                                {item.name}
                                            </Link>
                                        );
                                    })}
                                </nav>
                            </div>

                            <div className="border-t p-4">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium text-muted-foreground">{t("nav.language", "Language")}</span>
                                    <LanguageSwitcher />
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Page Content */}
                <main className="flex-1 p-4 md:p-8 overflow-x-hidden">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
