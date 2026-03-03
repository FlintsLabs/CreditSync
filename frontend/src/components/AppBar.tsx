import { UserCircle, LogOut } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { useAuth } from "../lib/auth";
import { Button } from "./ui/Button";

export default function AppBar() {
    const { user, logout } = useAuth();

    return (
        <div className="flex items-center gap-2 p-4 h-16 md:border-b-0 border-b-0 md:w-full md:justify-between w-auto justify-end">
            <div className="hidden md:flex items-center gap-2 font-bold text-primary">
                <div className="h-8 w-8 rounded bg-primary text-primary-foreground flex items-center justify-center">
                    C
                </div>
                CreditSync
            </div>
            <div className="flex items-center gap-2">
                <ThemeToggle />
                {user ? (
                    <Button variant="ghost" size="icon" onClick={logout} title="Logout">
                        <LogOut className="h-5 w-5" />
                    </Button>
                ) : (
                    <Button variant="ghost" size="icon">
                        <UserCircle className="h-5 w-5" />
                    </Button>
                )}
            </div>
        </div>
    );
}
