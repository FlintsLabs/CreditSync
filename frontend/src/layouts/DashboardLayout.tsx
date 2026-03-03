import { useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Users, Wallet, FileText, Activity } from "lucide-react";
import { cn } from "../lib/utils";
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
    ];

    return (
        <div className="flex h-screen bg-background text-foreground transition-colors duration-300 md:flex-row flex-col overflow-hidden">
            {/* Desktop Sidebar (Hidden on Mobile) */}
            <div className="hidden w-64 flex-col border-r bg-card md:flex h-full">
                <AppBar />
                <div className="flex flex-1 flex-col gap-1 p-4 overflow-y-auto">
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
            </div>

            {/* Mobile Header */}
            <header className="flex h-16 items-center border-b bg-card px-4 md:hidden shrink-0 z-20 sticky top-0">
                <span className="font-bold text-lg text-primary">CreditSync</span>
                <div className="ml-auto">
                    <AppBar />
                </div>
            </header>

            {/* Main Content Area */}
            <div className="flex-1 overflow-auto pb-16 md:pb-0 relative">
                <main className="p-4 md:p-8 max-w-7xl mx-auto h-full w-full">
                    <Outlet />
                </main>
            </div>

            {/* Mobile Bottom Navigation */}
            <nav className="md:hidden fixed bottom-0 left-0 right-0 w-full bg-card border-t z-50 flex justify-around items-center p-2 pb-safe">
                {navigation.map((item) => {
                    const Icon = item.icon;
                    const isActive = location.pathname === item.href;
                    return (
                        <Link
                            key={item.href}
                            to={item.href}
                            className={cn(
                                "flex flex-col items-center justify-center p-2 rounded-md transition-colors",
                                isActive ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <Icon className="h-5 w-5 mb-1" />
                            <span className="text-[10px]">{item.name}</span>
                        </Link>
                    );
                })}
            </nav>
        </div>
    );
}
