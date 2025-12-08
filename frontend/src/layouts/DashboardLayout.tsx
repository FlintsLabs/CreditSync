import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Users, Wallet, FileText, Settings, LogOut, Activity } from "lucide-react";
import { cn } from "../lib/utils";
import { ModeToggle } from "../components/theme-toggle";

const navigation = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { name: "Borrowers", href: "/dashboard/borrowers", icon: Users },
    { name: "Loans", href: "/dashboard/loans", icon: FileText },
    { name: "Transactions", href: "/dashboard/transactions", icon: Activity },
    { name: "Funds", href: "/dashboard/funds", icon: Wallet },
    { name: "Settings", href: "/dashboard/settings", icon: Settings },
];

export default function DashboardLayout() {
    const location = useLocation();

    const handleLogout = () => {
        localStorage.removeItem("token");
        window.location.href = "/login";
    };

    return (
        <div className="flex min-h-screen bg-background text-foreground">
            {/* Sidebar */}
            <div className="hidden w-64 flex-col border-r bg-card md:flex">
                <div className="flex h-16 items-center justify-between border-b px-6">
                    <h1 className="text-xl font-bold">CreditSync</h1>
                    <ModeToggle />
                </div>
                <div className="flex flex-1 flex-col gap-1 p-4">
                    {navigation.map((item) => {
                        const Icon = item.icon;
                        const isActive = location.pathname === item.href;
                        return (
                            <Link
                                key={item.name}
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
                <div className="border-t p-4">
                    <button
                        onClick={handleLogout}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
                    >
                        <LogOut className="h-4 w-4" />
                        Sign out
                    </button>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex flex-1 flex-col">
                {/* Mobile Header would go here */}

                <main className="flex-1 p-6 md:p-8">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
