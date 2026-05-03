import { useEffect } from "react";
import { Button } from "../../components/ui/button";
import { useGoogleLogin } from "@react-oauth/google";
import { api } from "../../lib/api";

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
                console.log("Google Login Success, Code Response:", codeResponse);
                // Send access token to backend for verification and session creation
                console.log("Sending token to backend...");
                const res = await api.post("/auth/google", {
                    token: codeResponse.access_token,
                });
                console.log("Backend response:", res.data);

                // Save token (in real app, use HTTP-only cookie or secure storage)
                localStorage.setItem("token", res.data.accessToken);
                localStorage.setItem("user", JSON.stringify(res.data.user));

                window.location.href = "/dashboard";
            } catch (error: any) {
                console.error("Login failed", error);
                const msg = error.response?.data?.error || error.message || "Unknown error";
                alert(`Login failed! ${msg}`);
            }
        },
        onError: (error) => console.log('Login Failed:', error),
        flow: 'implicit',
        prompt: 'select_account',
        scope: 'email profile openid'
    });

    return (
        <div className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-slate-950 font-sans selection:bg-purple-500/30">
            {/* 1. Animated Grid Background */}
            <div className="absolute inset-0 z-0 h-full w-full bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] mask-radial-faded"></div>
            <div className="absolute inset-0 z-0 bg-gradient-to-t from-slate-950 via-transparent to-slate-950/80"></div>

            {/* 2. Aurora Blobs */}
            <div className="absolute -left-[10%] top-[20%] h-[500px] w-[500px] rounded-full bg-purple-600/20 blur-[120px] animate-aurora"></div>
            <div className="absolute -right-[10%] bottom-[20%] h-[500px] w-[500px] rounded-full bg-blue-600/20 blur-[120px] animate-aurora-delayed"></div>

            {/* 3. Glassmorphism Card with Shimmer Border */}
            <div className="group relative z-10 w-full max-w-sm rounded-3xl p-[1px] shadow-2xl transition-all duration-500 hover:shadow-purple-500/10 animate-in fade-in zoom-in-95 slide-in-from-bottom-8">
                {/* Border Gradient Layer */}
                <div className="absolute inset-0 -z-10 rounded-3xl bg-gradient-to-br from-white/20 via-white/5 to-white/0 opacity-100 transition-opacity duration-500 group-hover:via-white/10"></div>

                {/* Card Content */}
                <div className="relative h-full w-full rounded-[23px] bg-black/40 p-8 backdrop-blur-2xl sm:p-10">
                    <div className="flex flex-col items-center text-center">
                        {/* Logo */}
                        <div className="mb-2 inline-flex items-center justify-center rounded-2xl bg-white/5 p-3 shadow-lg ring-1 ring-white/10 backdrop-blur-md">
                            <svg className="h-8 w-8 text-white" fill="none" height="24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" /></svg>
                        </div>

                        <h1 className="mt-6 bg-gradient-to-br from-white via-slate-200 to-slate-500 bg-clip-text text-5xl font-extrabold tracking-tight text-transparent drop-shadow-sm">
                            CreditSync
                        </h1>
                        <p className="mt-4 text-slate-400">
                            The future of lending portfolio management.
                        </p>
                    </div>

                    <div className="mt-10 space-y-4">
                        <Button
                            variant="outline"
                            className="group/btn relative w-full overflow-hidden border-0 bg-white/10 py-6 text-base font-medium text-white transition-all hover:bg-white/15 active:scale-[0.99]"
                            onClick={() => login()}
                        >
                            {/* Shimmer Effect on Button */}
                            <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-1000 group-hover/btn:animate-[shimmer_2s_infinite]"></div>

                            <span className="relative z-10 flex items-center justify-center gap-3">
                                <svg
                                    className="h-5 w-5 transition-transform duration-300 group-hover/btn:scale-110"
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
                            </span>
                        </Button>
                    </div>

                    <p className="mt-8 px-4 text-center text-xs text-slate-500">
                        By connecting, you agree to our <a href="#" className="underline decoration-slate-600 hover:text-slate-400">Terms</a> and <a href="#" className="underline decoration-slate-600 hover:text-slate-400">Privacy Policy</a>.
                    </p>
                </div>
            </div>

            {/* Footer */}
            <div className="absolute bottom-6 text-xs text-slate-600">
                &copy; {new Date().getFullYear()} CreditSync Inc.
            </div>
        </div>
    );
}
