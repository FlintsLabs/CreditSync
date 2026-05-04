import { useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Users, Wallet, FileText, Settings, Activity, Menu, X } from "lucide-react";
import { cn } from "../lib/utils";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import AppBar from "../components/AppBar";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button";

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
                    <span className="font-bold text-lg">CreditSync</span>
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
                                <AppBar />
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
                                    <span className="text-sm font-medium text-muted-foreground">Language</span>
                                    <LanguageSwitcher />
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Page Content */}
                <main className="flex-1 p-4 md:p-8 overflow-x-hidden pb-20 md:pb-8">
                    <Outlet />
                </main>

                {/* Mobile Bottom Navigation */}
                <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                    <div className="flex h-16 items-center justify-around px-2">
                        {navigation.slice(0, 5).map((item) => {
                            const Icon = item.icon;
                            const isActive = location.pathname === item.href || (
                                item.href !== "/dashboard" && location.pathname.startsWith(item.href)
                            );
                            return (
                                <Link
                                    key={item.href}
                                    to={item.href}
                                    className={cn(
                                        "flex h-full w-full flex-col items-center justify-center gap-1 text-[10px] font-medium tracking-wide transition-colors hover:text-primary",
                                        isActive ? "text-primary" : "text-muted-foreground"
                                    )}
                                >
                                    <Icon className={cn("h-5 w-5", isActive && "fill-primary/20")} />
                                    <span className="max-w-[60px] truncate text-center">{item.name}</span>
                                </Link>
                            );
                        })}
                    </div>
                </nav>
            </div>
        </div>
    );
}
