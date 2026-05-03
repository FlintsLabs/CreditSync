import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";
import { ArrowRight, ShieldCheck, Zap, BarChart3 } from "lucide-react";

export default function LandingPage() {
    return (
        <div className="min-h-screen bg-slate-950 text-white overflow-hidden relative selection:bg-cyan-500/30">

            {/* Ambient Background Glows */}
            <div className="fixed top-0 left-0 w-[500px] h-[500px] bg-violet-600/30 rounded-full blur-[120px] -translate-x-1/2 -translate-y-1/2 pointer-events-none animate-pulse" />
            <div className="fixed bottom-0 right-0 w-[600px] h-[600px] bg-cyan-600/20 rounded-full blur-[120px] translate-x-1/2 translate-y-1/2 pointer-events-none" />
            <div className="fixed top-1/2 left-1/2 w-[800px] h-[800px] bg-fuchsia-600/10 rounded-full blur-[150px] -translate-x-1/2 -translate-y-1/2 pointer-events-none" />

            {/* Navbar */}
            <nav className="relative z-50 flex items-center justify-between px-6 py-6 md:px-12 backdrop-blur-sm border-b border-white/5 bg-slate-950/50">
                <div className="flex items-center gap-2">
                    <div className="h-8 w-8 bg-gradient-to-br from-cyan-400 to-violet-600 rounded-lg flex items-center justify-center shadow-lg shadow-cyan-500/20">
                        <span className="font-bold text-white text-lg">C</span>
                    </div>
                    <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">
                        CreditSync
                    </span>
                </div>
                <div className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-300">
                    <a href="#features" className="hover:text-cyan-400 transition-colors">Features</a>
                    <a href="#safety" className="hover:text-violet-400 transition-colors">Security</a>
                    <a href="#pricing" className="hover:text-fuchsia-400 transition-colors">Pricing</a>
                </div>
                <div className="flex items-center gap-4">
                    <Link to="/login">
                        <Button variant="ghost" className="text-slate-300 hover:text-white hover:bg-white/5">
                            Sign In
                        </Button>
                    </Link>
                    <Link to="/login">
                        <Button className="bg-white text-slate-950 hover:bg-cyan-50 hover:shadow-lg hover:shadow-cyan-500/20 transition-all duration-300 rounded-full px-6">
                            Get Started
                        </Button>
                    </Link>
                </div>
            </nav>

            {/* Hero Section */}
            <main className="relative z-10 container mx-auto px-6 pt-20 pb-32">
                <div className="max-w-4xl mx-auto text-center space-y-8">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-cyan-400 text-sm font-medium backdrop-blur-md animate-in fade-in slide-in-from-bottom-4 duration-700">
                        <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
                        </span>
                        New Transaction System V1.0
                    </div>

                    <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-tight animate-in fade-in zoom-in-50 duration-700 delay-150">
                        Manage Loans with <br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-violet-500 to-fuchsia-500 animate-gradient-x">
                            Military-Grade Precision
                        </span>
                    </h1>

                    <p className="text-lg md:text-xl text-slate-400 max-w-2xl mx-auto leading-relaxed animate-in fade-in slide-in-from-bottom-8 duration-700 delay-300">
                        The ultimate financial operating system for modern lenders.
                        Track repayments, automate schedules, and secure documents with banking-standard encryption.
                    </p>

                    <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4 animate-in fade-in slide-in-from-bottom-8 duration-700 delay-500">
                        <Link to="/login">
                            <Button size="lg" className="h-12 w-full sm:w-auto px-8 bg-gradient-to-r from-cyan-500 to-violet-600 hover:from-cyan-400 hover:to-violet-500 text-white rounded-full shadow-lg shadow-violet-500/25 transition-all hover:scale-105 active:scale-95">
                                Start Dashboard <ArrowRight className="ml-2 h-4 w-4" />
                            </Button>
                        </Link>
                        <Button variant="outline" size="lg" className="h-12 w-full sm:w-auto px-8 rounded-full border-white/10 bg-white/5 text-white hover:bg-white/10 backdrop-blur-sm transition-all hover:scale-105">
                            View Documentation
                        </Button>
                    </div>
                </div>

                {/* Glass Cards Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-32">
                    {[
                        {
                            icon: Zap,
                            color: "text-cyan-400",
                            bg: "bg-cyan-500/10",
                            title: "Instant Calculation",
                            desc: "Real-time interest wizard for Daily, Weekly, and Monthly schedules."
                        },
                        {
                            icon: ShieldCheck,
                            color: "text-violet-400",
                            bg: "bg-violet-500/10",
                            title: "Bank-Grade Security",
                            desc: "Assets stored in S3/MinIO with role-based access control."
                        },
                        {
                            icon: BarChart3,
                            color: "text-fuchsia-400",
                            bg: "bg-fuchsia-500/10",
                            title: "Smart Analytics",
                            desc: "Visual dashboard for tracking ROI, risk, and cash flow."
                        }
                    ].map((feature, i) => (
                        <div key={i} className="group relative p-8 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md hover:bg-white/10 transition-all duration-500 hover:-translate-y-2 hover:shadow-2xl hover:shadow-violet-500/10">
                            <div className={`absolute inset-0 bg-gradient-to-br ${feature.bg} opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl`} />
                            <div className="relative z-10">
                                <div className={`h-12 w-12 rounded-xl ${feature.bg} flex items-center justify-center mb-6 ring-1 ring-white/10 group-hover:scale-110 transition-transform duration-500`}>
                                    <feature.icon className={`h-6 w-6 ${feature.color}`} />
                                </div>
                                <h3 className="text-xl font-semibold mb-3 text-white group-hover:text-cyan-300 transition-colors">{feature.title}</h3>
                                <p className="text-slate-400 leading-relaxed group-hover:text-slate-300 transition-colors">{feature.desc}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </main>

            {/* Bottom Gradient Line */}
            <div className="fixed bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent opacity-50" />
        </div>
    );
}
