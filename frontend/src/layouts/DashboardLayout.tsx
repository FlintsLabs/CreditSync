import { useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Users, Wallet, FileText, Settings, Activity, Menu, X } from "lucide-react";
import { cn } from "../lib/utils";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import AppBar from "../components/AppBar";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/Button";

export default function DashboardLayout() {
    const location = useLocation();
    const { t } = useTranslation();
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

    const navigation = [
        { name: t("dashboard.title", "Dashboard"), href: "/dashboard", icon: LayoutDashboard },
        { name: t("dashboard.borrowers", "Borrowers"), href: "/dashboard/borrowers", icon: Users },
        { name: t("dashboard.loans", "Loans"), href: "/dashboard/loans", icon: FileText },
        { name: t("dashboard.transactions", "Transactions"), href: "/dashboard/transactions", icon: Activity },
        { name: t("dashboard.funds", "Funds"), href: "/dashboard/funds", icon: Wallet },
        { name: t("dashboard.settings", "Settings"), href: "/dashboard/settings", icon: Settings },
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
                        <span className="text-xs font-medium text-muted-foreground">Language</span>
                        <LanguageSwitcher />
                    </div>
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex flex-1 flex-col min-w-0 pb-16 md:pb-0"> {/* Add padding for bottom nav on mobile */}
                {/* Mobile Header (Visible only on Mobile) */}
                <header className="sticky top-0 z-30 flex justify-between h-16 items-center border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
                    <span className="font-bold text-lg">CreditSync</span>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setIsMobileMenuOpen(true)}
                    >
                        <Menu className="h-5 w-5" />
                    </Button>
                </header>

                {/* Mobile Slide-out Right Drawer (For Settings, Profile, etc.) */}
                {isMobileMenuOpen && (
                    <div className="fixed inset-0 z-50 flex justify-end md:hidden">
                        {/* Backdrop */}
                        <div
                            className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
                            onClick={() => setIsMobileMenuOpen(false)}
                        />

                        {/* Drawer Panel */}
                        <div className="relative flex w-[80%] max-w-xs flex-col bg-card shadow-2xl animate-in slide-in-from-right duration-300">
                            <div className="p-4 border-b flex justify-between items-center">
                                <AppBar />
                                <Button variant="ghost" size="icon" onClick={() => setIsMobileMenuOpen(false)}>
                                    <X className="h-5 w-5" />
                                </Button>
                            </div>

                            <div className="flex-1 overflow-y-auto p-4">
                                <nav className="flex flex-col gap-1">
                                     {/* Navigation items could be put here if they didn't fit in bottom nav,
                                         but we'll show all in bottom nav. We keep settings here. */}
                                    <Link
                                        to="/dashboard/settings"
                                        onClick={() => setIsMobileMenuOpen(false)}
                                        className={cn(
                                            "flex items-center gap-3 rounded-md px-3 py-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                                            location.pathname === "/dashboard/settings" ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                                        )}
                                    >
                                        <Settings className="h-5 w-5" />
                                        {t("dashboard.settings", "Settings")}
                                    </Link>
                                </nav>
                            </div>

                            <div className="border-t p-4">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium text-muted-foreground">Language</span>
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

                {/* Mobile Bottom Navigation */}
                <div className="fixed bottom-0 left-0 right-0 z-30 flex h-16 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
                    <div className="flex w-full items-center justify-around">
                        {navigation.filter(n => n.name !== t("dashboard.settings", "Settings")).map((item) => {
                            const Icon = item.icon;
                            const isActive = location.pathname === item.href;
                            return (
                                <Link
                                    key={item.href}
                                    to={item.href}
                                    className={cn(
                                        "flex flex-col items-center justify-center w-full h-full gap-1 text-xs font-medium transition-colors hover:text-foreground",
                                        isActive ? "text-primary" : "text-muted-foreground"
                                    )}
                                >
                                    <Icon className="h-5 w-5" />
                                    <span className="sr-only sm:not-sr-only sm:text-[10px]">{item.name}</span>
                                </Link>
                            );
                        })}
                    </div>
                </div>

            </div>
        </div>
    );
}
