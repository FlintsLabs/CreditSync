import { useEffect } from "react";
import { Button } from "../../components/ui/Button";
import { useGoogleLogin } from "@react-oauth/google";
import axios from "axios";

export default function Login() {
    useEffect(() => {
        const token = localStorage.getItem("token");
        if (token) {
            window.location.href = "/dashboard";
        }
    }, []);

    const login = useGoogleLogin({
        onSuccess: async (codeResponse) => {
            try {
                // Send access token to backend for verification and session creation
                const res = await axios.post("http://localhost:3000/auth/google", {
                    token: codeResponse.access_token,
                });

                // Save token (in real app, use HTTP-only cookie or secure storage)
                localStorage.setItem("token", res.data.accessToken);
                localStorage.setItem("user", JSON.stringify(res.data.user));

                window.location.href = "/dashboard";
            } catch (error) {
                console.error("Login failed", error);
                alert("Login failed! Check console.");
            }
        },
        onError: (error) => console.log('Login Failed:', error)
    });

    return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-muted/50">
            <div className="w-full max-w-md space-y-8 rounded-lg border bg-card p-8 shadow-sm">
                <div className="text-center">
                    <h1 className="text-3xl font-bold tracking-tight">CreditSync</h1>
                    <p className="mt-2 text-sm text-muted-foreground">
                        Sign in to manage your lending portfolio
                    </p>
                </div>

                <div className="space-y-4">
                    <Button
                        variant="outline"
                        className="w-full py-6 text-base"
                        onClick={() => login()}
                    >
                        <svg
                            className="mr-2 h-5 w-5"
                            viewBox="0 0 24 24"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                        >
                            <path
                                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                                fill="#4285F4"
                            />
                            <path
                                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                                fill="#34A853"
                            />
                            <path
                                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                                fill="#FBBC05"
                            />
                            <path
                                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                                fill="#EA4335"
                            />
                        </svg>
                        Continue with Google
                    </Button>
                </div>

                <p className="px-8 text-center text-xs text-muted-foreground">
                    By clicking continue, you agree to our Terms of Service and Privacy Policy.
                </p>
            </div>
        </div>
    );
}
