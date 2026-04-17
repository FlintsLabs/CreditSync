import { useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Users, Wallet, FileText, Settings, Activity, Menu, X, MoreHorizontal } from "lucide-react";
import { cn } from "../lib/utils";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import AppBar from "../components/AppBar";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/Button";

export default function DashboardLayout() {
    const location = useLocation();
    const { t } = useTranslation();
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

    const primaryNavigation = [
        { name: t("dashboard.title", "Dashboard"), href: "/dashboard", icon: LayoutDashboard },
        { name: t("dashboard.borrowers", "Borrowers"), href: "/dashboard/borrowers", icon: Users },
        { name: t("dashboard.loans", "Loans"), href: "/dashboard/loans", icon: FileText },
        { name: t("dashboard.transactions", "Transactions"), href: "/dashboard/transactions", icon: Activity },
    ];

    const secondaryNavigation = [
        { name: t("dashboard.funds", "Funds"), href: "/dashboard/funds", icon: Wallet },
        { name: t("dashboard.settings", "Settings"), href: "/dashboard/settings", icon: Settings },
    ];

    const navigation = [...primaryNavigation, ...secondaryNavigation];

    return (
        <div className="flex min-h-screen bg-background text-foreground transition-colors duration-300 md:pb-0 pb-16">
            {/* Desktop Sidebar (Hidden on Mobile) */}
            <div className="hidden w-64 flex-col border-r bg-card md:flex sticky top-0 h-screen overflow-y-auto z-20">
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
            <div className="flex flex-1 flex-col min-w-0 pb-16 md:pb-0">
                {/* Mobile Header (Visible only on Mobile) */}
                <header className="sticky top-0 z-30 flex h-16 items-center border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
                    <span className="font-bold text-lg flex-1">CreditSync</span>
                    <AppBar />
                </header>

                {/* Right-side Drawer / Mobile Sidebar Overlay (Slide-in) */}
                {isMobileMenuOpen && (
                    <div className="fixed inset-0 z-40 flex md:hidden justify-end">
                        {/* Backdrop */}
                        <div
                            className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
                            onClick={() => setIsMobileMenuOpen(false)}
                        />

                        {/* Sidebar Panel - slide from right */}
                        <div className="relative flex w-[80%] max-w-xs flex-col bg-card shadow-2xl animate-in slide-in-from-right duration-300 h-full">
                            <div className="p-4 border-b flex justify-between items-center">
                                <span className="font-bold text-lg">Menu</span>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setIsMobileMenuOpen(false)}
                                >
                                    <X className="h-5 w-5" />
                                </Button>
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

                            <div className="border-t p-4 pb-20">
                                <div className="flex items-center justify-between mb-4">
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
            </div>

            {/* Mobile Bottom Navigation Bar */}
            <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex justify-around items-center h-16 px-2 safe-area-bottom">
                {primaryNavigation.map((item) => {
                    const Icon = item.icon;
                    const isActive = location.pathname === item.href || (item.href !== '/dashboard' && location.pathname.startsWith(item.href));
                    return (
                        <Link
                            key={item.href}
                            to={item.href}
                            className={cn(
                                "flex flex-col items-center justify-center w-full h-full space-y-1 text-xs",
                                isActive ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <Icon className={cn("h-5 w-5", isActive ? "stroke-primary" : "stroke-muted-foreground")} />
                            <span className="truncate w-full text-center">{item.name}</span>
                        </Link>
                    );
                })}
                <button
                    onClick={() => setIsMobileMenuOpen(true)}
                    className={cn(
                        "flex flex-col items-center justify-center w-full h-full space-y-1 text-xs",
                        isMobileMenuOpen ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground"
                    )}
                >
                    <MoreHorizontal className={cn("h-5 w-5", isMobileMenuOpen ? "stroke-primary" : "stroke-muted-foreground")} />
                    <span className="truncate w-full text-center">{t("dashboard.more", "More")}</span>
                </button>
            </nav>
        </div>
    );
}
