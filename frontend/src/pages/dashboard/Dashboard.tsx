import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Activity, CreditCard, DollarSign, Users, TrendingUp, ArrowUpRight, ArrowDownRight, ChevronRight, MessageCircle, Facebook, Users2, BarChart2 } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, PieChart, Pie, Cell } from "recharts";
import { useNavigate } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Badge } from "../../components/ui/badge";
import PortfolioGraph from "./PortfolioGraph";
import FundPerformance from "./funds/FundPerformance";

const data = [
    { name: "Jan", total: 12000 },
    { name: "Feb", total: 18000 },
    { name: "Mar", total: 22000 },
    { name: "Apr", total: 28000 },
    { name: "May", total: 32000 },
    { name: "Jun", total: 45000 },
];

const resentSales = [
    {
        name: "Somchai Jai-dee",
        contact: "081-234-5678",
        amount: "+฿1,999.00",
        status: "Repayment"
    },
    {
        name: "Jackson Lee",
        contact: "Line: @jackson",
        amount: "+฿39.00",
        status: "Repayment"
    },
    {
        name: "Isabella Nguyen",
        contact: "099-999-9999",
        amount: "+฿299.00",
        status: "Interest"
    },
    {
        name: "William Kim",
        contact: "Line: will_kim",
        amount: "+฿99.00",
        status: "Repayment"
    },
    {
        name: "Sofia Davis",
        contact: "089-876-5432",
        amount: "+฿39.00",
        status: "Interest"
    }
]

// Mock Data for Borrower Groups
const borrowerGroups = [
    {
        id: "line-1",
        name: "Office Gang (Rama 9)",
        platform: "line",
        members: 12,
        totalDebt: 150000,
        profitRate: 15, // ROI %
        profitAmount: 22500,
        status: "Healthy",
        collectionRate: 98
    },
    {
        id: "line-2",
        name: "Uni Friends (KU)",
        platform: "line",
        members: 8,
        totalDebt: 45000,
        profitRate: 10,
        profitAmount: 4500,
        status: "Watch",
        collectionRate: 85
    },
    {
        id: "fb-1",
        name: "Marketplace Leads",
        platform: "facebook",
        members: 24,
        totalDebt: 320000,
        profitRate: 22,
        profitAmount: 70400,
        status: "Healthy",
        collectionRate: 92
    }
]

export default function Dashboard() {
    const navigate = useNavigate();
    return (
        <div className="flex-1 space-y-8 p-4 pt-6">
            <div className="flex items-center justify-between space-y-2">
                <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
                <div className="flex items-center space-x-2">
                    {/* DateRangePicker Placeholder */}
                </div>
            </div>

            <Tabs defaultValue="overview" className="space-y-4">
                <TabsList>
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                    <TabsTrigger value="groups">Borrower Groups</TabsTrigger>
                    <TabsTrigger value="graph">Portfolio Graph</TabsTrigger>
                    <TabsTrigger value="analytics">Analytics</TabsTrigger>
                </TabsList>

                {/* TAB: OVERVIEW */}
                <TabsContent value="overview" className="space-y-4">
                    {/* Stats Cards */}
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                        <Card>
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <CardTitle className="text-sm font-medium">
                                    Total Revenue
                                </CardTitle>
                                <DollarSign className="h-4 w-4 text-muted-foreground" />
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold">฿45,231.89</div>
                                <p className="text-xs text-emerald-500 font-medium flex items-center">
                                    +20.1% <TrendingUp className="h-3 w-3 ml-1" /> from last month
                                </p>
                                <div className="h-[40px] mt-3">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <AreaChart data={data}>
                                            <defs>
                                                <linearGradient id="colorTotalMini" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                                                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                                </linearGradient>
                                            </defs>
                                            <Area type="monotone" dataKey="total" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorTotalMini)" />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <CardTitle className="text-sm font-medium">
                                    Active Borrowers
                                </CardTitle>
                                <Users className="h-4 w-4 text-muted-foreground" />
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold">+2350</div>
                                <p className="text-xs text-emerald-500 font-medium flex items-center">
                                    +180.1% <TrendingUp className="h-3 w-3 ml-1" /> from last month
                                </p>
                                <div className="h-[40px] mt-3">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <AreaChart data={[
                                            { val: 100 }, { val: 120 }, { val: 150 }, { val: 200 }, { val: 300 }, { val: 350 }
                                        ]}>
                                            <Area type="monotone" dataKey="val" stroke="#10b981" strokeWidth={2} fill="none" />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <CardTitle className="text-sm font-medium">Sales</CardTitle>
                                <CreditCard className="h-4 w-4 text-muted-foreground" />
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold">+12,234</div>
                                <p className="text-xs text-rose-500 font-medium flex items-center">
                                    -19% <TrendingUp className="h-3 w-3 ml-1 rotate-180" /> from last month
                                </p>
                                <div className="h-[40px] mt-3">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <AreaChart data={[
                                            { val: 500 }, { val: 400 }, { val: 300 }, { val: 200 }, { val: 250 }, { val: 220 }
                                        ]}>
                                            <defs>
                                                <linearGradient id="colorSalesMini" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3} />
                                                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                                                </linearGradient>
                                            </defs>
                                            <Area type="monotone" dataKey="val" stroke="#f43f5e" strokeWidth={2} fillOpacity={1} fill="url(#colorSalesMini)" />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <CardTitle className="text-sm font-medium">
                                    Active Now
                                </CardTitle>
                                <Activity className="h-4 w-4 text-muted-foreground" />
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold">+573</div>
                                <p className="text-xs text-emerald-500 font-medium flex items-center">
                                    +201 <ArrowUpRight className="h-3 w-3 ml-1" /> since last hour
                                </p>
                                <div className="h-[40px] mt-3">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <AreaChart data={[
                                            { val: 10 }, { val: 25 }, { val: 15 }, { val: 40 }, { val: 30 }, { val: 60 }
                                        ]}>
                                            <Area type="monotone" dataKey="val" stroke="#10b981" strokeWidth={2} fill="none" />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Active Bank Loans Section */}
                    <div>
                        <h3 className="text-lg font-medium mb-4">Your Sources of Funds</h3>
                        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                            {/* Loan Card 1: TTB - Fixed Term */}
                            <Card
                                className="overflow-hidden border-l-4 border-l-blue-600 transition-all hover:shadow-md cursor-pointer hover:bg-muted/20"
                                onClick={() => navigate("/dashboard/funds/1")}
                            >
                                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 bg-muted/40">
                                    <div>
                                        <CardTitle className="text-base font-bold text-blue-700">TTB Cash2Go</CardTitle>
                                        <p className="text-xs text-muted-foreground">Fixed Term Loan</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <CreditCard className="h-5 w-5 text-blue-600" />
                                        <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                                    </div>
                                </CardHeader>
                                <CardContent className="pt-4">
                                    <div className="flex justify-between items-end mb-2">
                                        <div>
                                            <p className="text-xs text-muted-foreground">Remaining Balance</p>
                                            <p className="text-2xl font-bold">฿145,000</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-xs text-muted-foreground">Limit</p>
                                            <p className="text-sm font-medium">฿200,000</p>
                                        </div>
                                    </div>
                                    {/* Progress Bar */}
                                    <div className="h-2 w-full bg-secondary rounded-full mb-4">
                                        <div className="h-2 bg-blue-600 rounded-full" style={{ width: "72.5%" }}></div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4 text-sm">
                                        <div>
                                            <p className="text-xs text-muted-foreground mb-1">Monthly Payment</p>
                                            <p className="font-semibold">฿5,400</p>
                                            <p className="text-[10px] text-muted-foreground">Fixed (24/36)</p>
                                        </div>
                                        <div>
                                            <p className="text-xs text-muted-foreground mb-1">Interest</p>
                                            <p className="font-semibold text-rose-500">18.0%</p>
                                            <p className="text-[10px] text-muted-foreground">Effective Rate</p>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Loan Card 2: KBank - Minimum Pay */}
                            <Card className="overflow-hidden border-l-4 border-l-green-600 transition-all hover:shadow-md">
                                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 bg-muted/40">
                                    <div>
                                        <CardTitle className="text-base font-bold text-green-700">K-Express Cash</CardTitle>
                                        <p className="text-xs text-muted-foreground">Revolving Credit</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <CreditCard className="h-5 w-5 text-green-600" />
                                        <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                                    </div>
                                </CardHeader>
                                <CardContent className="pt-4">
                                    <div className="flex justify-between items-end mb-2">
                                        <div>
                                            <p className="text-xs text-muted-foreground">Current Usage</p>
                                            <p className="text-2xl font-bold">฿28,500</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-xs text-muted-foreground">Limit</p>
                                            <p className="text-sm font-medium">฿50,000</p>
                                        </div>
                                    </div>
                                    {/* Progress Bar */}
                                    <div className="h-2 w-full bg-secondary rounded-full mb-4">
                                        <div className="h-2 bg-green-600 rounded-full" style={{ width: "57%" }}></div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4 text-sm">
                                        <div>
                                            <p className="text-xs text-muted-foreground mb-1">Min Payment</p>
                                            <p className="font-semibold">฿1,425</p>
                                            <p className="text-[10px] text-muted-foreground">5% of Balance</p>
                                        </div>
                                        <div>
                                            <p className="text-xs text-muted-foreground mb-1">Interest</p>
                                            <p className="font-semibold text-rose-500">25.0%</p>
                                            <p className="text-[10px] text-muted-foreground">Daily Calc</p>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Loan Card 3: SCB - Available */}
                            <Card className="overflow-hidden border-l-4 border-l-purple-600 opacity-80 transition-all hover:shadow-md">
                                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 bg-muted/40">
                                    <div>
                                        <CardTitle className="text-base font-bold text-purple-700">SCB Speedy Cash</CardTitle>
                                        <p className="text-xs text-muted-foreground">Cash Card</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <CreditCard className="h-5 w-5 text-purple-600" />
                                        <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                                    </div>
                                </CardHeader>
                                <CardContent className="pt-4">
                                    <div className="flex justify-between items-end mb-2">
                                        <div>
                                            <p className="text-xs text-muted-foreground">Available</p>
                                            <p className="text-2xl font-bold text-emerald-600">฿100,000</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-xs text-muted-foreground">Limit</p>
                                            <p className="text-sm font-medium">฿100,000</p>
                                        </div>
                                    </div>
                                    {/* Progress Bar */}
                                    <div className="h-2 w-full bg-secondary rounded-full mb-4">
                                        <div className="h-2 bg-purple-600 rounded-full" style={{ width: "0%" }}></div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4 text-sm">
                                        <div>
                                            <p className="text-xs text-muted-foreground mb-1">Status</p>
                                            <p className="font-semibold text-emerald-600">Standby</p>
                                        </div>
                                        <div>
                                            <p className="text-xs text-muted-foreground mb-1">Interest</p>
                                            <p className="font-semibold text-rose-500">22.0%</p>
                                            <p className="text-[10px] text-muted-foreground">If withdrawn</p>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
                        {/* Chart */}
                        <Card className="col-span-4 transition-all hover:shadow-md">
                            <CardHeader>
                                <CardTitle>Overview</CardTitle>
                            </CardHeader>
                            <CardContent className="pl-2">
                                <ResponsiveContainer width="100%" height={350}>
                                    <AreaChart data={data}>
                                        <defs>
                                            <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#8884d8" stopOpacity={0.8} />
                                                <stop offset="95%" stopColor="#8884d8" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <XAxis
                                            dataKey="name"
                                            stroke="#888888"
                                            fontSize={12}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <YAxis
                                            stroke="#888888"
                                            fontSize={12}
                                            tickLine={false}
                                            axisLine={false}
                                            tickFormatter={(value) => `฿${value}`}
                                        />
                                        <Tooltip
                                            formatter={(value) => [`฿${value}`, "Revenue"]}
                                            contentStyle={{ borderRadius: "8px", border: "none", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="total"
                                            stroke="#8884d8"
                                            fillOpacity={1}
                                            fill="url(#colorTotal)"
                                        />
                                    </AreaChart>
                                </ResponsiveContainer>
                            </CardContent>
                        </Card>

                        {/* Recent Sales/Activity */}
                        <Card className="col-span-3 transition-all hover:shadow-md">
                            <CardHeader>
                                <CardTitle>Recent Activity</CardTitle>
                                <p className="text-sm text-muted-foreground">
                                    You made 265 sales this month.
                                </p>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-8">
                                    {resentSales.map((sale, index) => (
                                        <div className="flex items-center" key={index}>
                                            <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
                                                {/* Avatar Fallback */}
                                                <span className="text-xs font-bold text-primary">
                                                    {sale.name.charAt(0)}{sale.name.split(" ")[1]?.charAt(0)}
                                                </span>
                                            </div>
                                            <div className="ml-4 space-y-1">
                                                <p className="text-sm font-medium leading-none">{sale.name}</p>
                                                <p className="text-sm text-muted-foreground">
                                                    {sale.contact}
                                                </p>
                                            </div>
                                            <div className="ml-auto font-medium">
                                                {sale.amount}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

                {/* TAB: BORROWER GROUPS */}
                <TabsContent value="groups" className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="text-lg font-medium">Your Borrower Groups</h3>
                            <p className="text-sm text-muted-foreground">Organize and track performance by platform.</p>
                        </div>
                        {/* Add New Group Button could go here */}
                    </div>

                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {borrowerGroups.map((group) => (
                            <Card key={group.id} className="transition-all hover:shadow-lg border-t-4"
                                style={{ borderTopColor: group.platform === 'line' ? '#06c755' : '#1877f2' }}
                            >
                                <CardHeader className="pb-2">
                                    <div className="flex justify-between items-start">
                                        <div>
                                            <CardTitle className="text-lg flex items-center gap-2">
                                                {group.platform === 'line' ? <MessageCircle className="h-5 w-5 text-[#06c755]" fill="#06c755" color="white" /> : <Facebook className="h-5 w-5 text-[#1877f2]" fill="#1877f2" color="white" />}
                                                {group.name}
                                            </CardTitle>
                                            <p className="text-xs text-muted-foreground mt-1 capitalize">{group.platform} Group</p>
                                        </div>
                                        <div className={`px-2 py-1 rounded-full text-xs font-bold ${group.status === 'Healthy' ? 'bg-emerald-100 text-emerald-700' : 'bg-yellow-100 text-yellow-700'}`}>
                                            {group.status}
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <div className="grid grid-cols-2 gap-4 mb-6">
                                        <div className="space-y-1">
                                            <p className="text-xs text-muted-foreground">Total Active Debt</p>
                                            <p className="text-2xl font-bold">฿{group.totalDebt.toLocaleString()}</p>
                                        </div>
                                        <div className="space-y-1 text-right">
                                            <p className="text-xs text-muted-foreground">Members</p>
                                            <p className="text-xl font-medium flex justify-end items-center gap-1">
                                                <Users2 className="h-4 w-4" /> {group.members}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="bg-muted/50 p-4 rounded-lg space-y-4">
                                        <div className="flex justify-between items-center">
                                            <span className="text-sm font-medium flex items-center gap-2">
                                                <BarChart2 className="h-4 w-4 text-primary" /> Profit / ROI
                                            </span>
                                            <span className="text-lg font-bold text-emerald-600">
                                                +{group.profitRate}%
                                            </span>
                                        </div>
                                        <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                                            <div className="h-full bg-emerald-500" style={{ width: `${group.profitRate * 2}%` }}></div>
                                        </div>
                                        <div className="flex justify-between text-xs text-muted-foreground">
                                            <span>Est. Profit: ฿{group.profitAmount.toLocaleString()}</span>
                                            <span>Collection: {group.collectionRate}%</span>
                                        </div>
                                    </div>

                                    <div className="mt-4 flex -space-x-2 overflow-hidden">
                                        {/* Mock Avatars */}
                                        {[...Array(4)].map((_, i) => (
                                            <div key={i} className="inline-block h-8 w-8 rounded-full ring-2 ring-background bg-slate-200 flex items-center justify-center text-[10px] font-bold text-slate-500">
                                                U{i + 1}
                                            </div>
                                        ))}
                                        <div className="inline-block h-8 w-8 rounded-full ring-2 ring-background bg-slate-100 flex items-center justify-center text-xs text-muted-foreground">
                                            +{group.members - 4}
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </TabsContent>

                {/* TAB: PORTFOLIO GRAPH */}
                <TabsContent value="graph" className="space-y-4">
                    <PortfolioGraph />
                </TabsContent>

                {/* TAB: ANALYTICS */}
                <TabsContent value="analytics" className="space-y-4">
                    <FundPerformance />
                </TabsContent>
            </Tabs>
        </div>
    )
}
