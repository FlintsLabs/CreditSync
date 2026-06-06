import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Bot, Send, X, Loader2, Sparkles, User } from "lucide-react";
import { cn } from "../lib/utils";
import { api } from "../lib/api";

interface Message {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: Date;
}

export function AIAssistant() {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<Message[]>([
        {
            id: "welcome",
            role: "assistant",
            content: "Hi! I'm your CreditSync AI Assistant. I can help you find borrower summaries, check active loans, or calculate loan payoffs. How can I help you today?",
            timestamp: new Date()
        }
    ]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        if (isOpen) {
            scrollToBottom();
        }
    }, [messages, isOpen]);

    const handleSend = async () => {
        if (!input.trim()) return;

        const userMsg: Message = {
            id: Date.now().toString(),
            role: "user",
            content: input.trim(),
            timestamp: new Date()
        };

        setMessages(prev => [...prev, userMsg]);
        setInput("");
        setIsLoading(true);

        // Simulate AI Flow routing to tools or answering directly
        setTimeout(async () => {
            try {
                let aiResponse = "I'm sorry, I couldn't understand that request. Could you specify if you want to look up a borrower, check loans, or calculate a payoff?";

                // Extremely basic simulation of AI intent matching for demo purposes
                const lowerInput = userMsg.content.toLowerCase();

                if (lowerInput.includes("overview") || lowerInput.includes("financial")) {
                    try {
                         const toolRes = await api.post("/ai-tools/execute", {
                            tool: "get_financial_overview",
                            parameters: {}
                        });
                        if (toolRes.data) {
                            const data = toolRes.data;
                            aiResponse = `Here's your financial overview: Total Lent is ฿${data.totalLent.toLocaleString()}, Total Collected is ฿${data.totalCollected.toLocaleString()}, and Active Principal is ฿${data.activePrincipal.toLocaleString()}.`;
                        }
                    } catch (e) {
                         aiResponse = "I tried to get the financial overview but encountered an error.";
                    }
                } else if (lowerInput.includes("active loans") || lowerInput.includes("all loans")) {
                     try {
                         const toolRes = await api.post("/ai-tools/execute", {
                            tool: "get_active_loans",
                            parameters: {}
                        });
                        if (toolRes.data && toolRes.data.loans) {
                            const count = toolRes.data.loans.length;
                            aiResponse = `You have ${count} active loans. The latest ones are for ${toolRes.data.loans.slice(0,3).map((l:any) => l.borrowerName || 'Unknown').join(', ')}.`;
                        }
                    } catch (e) {
                         aiResponse = "I tried to get active loans but encountered an error.";
                    }
                } else {
                     aiResponse = "I'm a simulated AI Assistant. To see real tool integration, try asking for a 'financial overview' or 'active loans'!";
                }

                const assistantMsg: Message = {
                    id: (Date.now() + 1).toString(),
                    role: "assistant",
                    content: aiResponse,
                    timestamp: new Date()
                };

                setMessages(prev => [...prev, assistantMsg]);
            } catch (error) {
                 const errorMsg: Message = {
                    id: (Date.now() + 1).toString(),
                    role: "assistant",
                    content: "An error occurred while trying to process your request.",
                    timestamp: new Date()
                };
                setMessages(prev => [...prev, errorMsg]);
            } finally {
                setIsLoading(false);
            }
        }, 1000);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    if (!isOpen) {
        return (
            <Button
                onClick={() => setIsOpen(true)}
                className="fixed bottom-20 md:bottom-6 right-6 h-14 w-14 rounded-full shadow-xl bg-primary hover:bg-primary/90 transition-all hover:scale-105 z-50 flex items-center justify-center p-0"
                size="icon"
            >
                <Sparkles className="h-6 w-6 text-primary-foreground" />
            </Button>
        );
    }

    return (
        <Card className="fixed bottom-20 md:bottom-6 right-6 w-[350px] md:w-[400px] h-[500px] shadow-2xl flex flex-col z-50 animate-in slide-in-from-bottom-5 border-primary/20">
            <CardHeader className="p-4 border-b bg-muted/30 flex flex-row items-center justify-between space-y-0 rounded-t-xl">
                <div className="flex items-center gap-2">
                    <div className="bg-primary/10 p-2 rounded-full">
                        <Bot className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                        <CardTitle className="text-md font-bold">AI Assistant</CardTitle>
                        <p className="text-xs text-muted-foreground">Powered by MCP / Flow</p>
                    </div>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setIsOpen(false)}>
                    <X className="h-4 w-4" />
                </Button>
            </CardHeader>
            <CardContent className="flex-1 p-0 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {messages.map((msg) => (
                        <div
                            key={msg.id}
                            className={cn(
                                "flex w-max max-w-[85%] flex-col gap-2 rounded-lg px-3 py-2 text-sm",
                                msg.role === "user"
                                    ? "ml-auto bg-primary text-primary-foreground"
                                    : "bg-muted"
                            )}
                        >
                            <div className="flex items-center gap-2 mb-1 opacity-70 text-[10px]">
                                {msg.role === "assistant" && <Bot className="h-3 w-3" />}
                                {msg.role === "user" && <User className="h-3 w-3" />}
                                <span>{msg.role === "assistant" ? "AI" : "You"}</span>
                            </div>
                            <span>{msg.content}</span>
                        </div>
                    ))}
                    {isLoading && (
                        <div className="flex w-max max-w-[85%] flex-col gap-2 rounded-lg px-3 py-2 text-sm bg-muted">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>
                <div className="p-3 border-t bg-background">
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            handleSend();
                        }}
                        className="flex w-full items-center space-x-2"
                    >
                        <Input
                            type="text"
                            placeholder="Ask me anything..."
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            disabled={isLoading}
                            className="flex-1"
                        />
                        <Button type="submit" size="icon" disabled={isLoading || !input.trim()}>
                            <Send className="h-4 w-4" />
                        </Button>
                    </form>
                </div>
            </CardContent>
        </Card>
    );
}
