import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Users, Wallet, FileText, Settings, Activity } from "lucide-react";
import { cn } from "../lib/utils";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import AppBar from "../components/AppBar";
import { useTranslation } from "react-i18next";

export default function DashboardLayout() {
    const location = useLocation();
    const { t } = useTranslation();

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
            <div className="flex flex-1 flex-col min-w-0 pb-16 md:pb-0">
                {/* Mobile Header (Visible only on Mobile) */}
                <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
                    <span className="font-bold text-lg">CreditSync</span>
                    <div className="flex items-center gap-2">
                        {/* We use a specialized MobileAppBar here to avoid the extra CreditSync header from AppBar */}
                        <AppBar />
                    </div>
                </header>

                {/* Page Content */}
                <main className="flex-1 p-4 md:p-8 overflow-x-hidden">
                    <Outlet />
                </main>

                {/* Mobile Bottom Navigation Bar (Visible only on Mobile) */}
                <nav className="fixed bottom-0 left-0 right-0 z-40 flex h-16 items-center justify-around border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden pb-safe">
                    {navigation.slice(0, 5).map((item) => {
                        const Icon = item.icon;
                        const isActive = location.pathname === item.href;
                        return (
                            <Link
                                key={item.href}
                                to={item.href}
                                className={cn(
                                    "flex flex-col items-center justify-center w-full h-full gap-1 text-xs transition-colors hover:text-primary",
                                    isActive ? "text-primary font-medium" : "text-muted-foreground"
                                )}
                            >
                                <Icon className={cn("h-5 w-5", isActive && "fill-primary/20")} />
                                <span>{item.name}</span>
                            </Link>
                        );
                    })}
                </nav>
            </div>
        </div>
    );
}
