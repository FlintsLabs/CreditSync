import { useState, useRef, useEffect } from "react";
import { MessageCircle, X, Send, Bot } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "./ui/card";
import { Input } from "./ui/input";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

interface Message {
    role: "user" | "assistant";
    content: string;
    isError?: boolean;
}

export function AIAssistant() {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<Message[]>([
        { role: "assistant", content: "Hi! I am your AI Assistant. How can I help you today? You can ask me for a financial overview, active loans, or a borrower summary." }
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

        const userText = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userText }]);
        setIsLoading(true);

        try {
            const response = await api.post("/ai-tools/chat", {
                message: userText
            });

            const replyContent = response.data.response;
            setMessages(prev => [...prev, { role: "assistant", content: replyContent }]);

        } catch (error: any) {
            console.error(error);
            const errMsg = error.response?.data?.error || "Sorry, I encountered an error while processing your request.";
            setMessages(prev => [...prev, { role: "assistant", content: errMsg, isError: true }]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <>
            {/* Floating button */}
            {!isOpen && (
                <Button
                    onClick={() => setIsOpen(true)}
                    className="fixed bottom-24 md:bottom-6 right-4 md:right-6 h-14 w-14 rounded-full shadow-xl z-50 p-0 flex items-center justify-center transition-transform hover:scale-110 bg-primary text-primary-foreground"
                >
                    <MessageCircle className="h-6 w-6" />
                </Button>
            )}

            {/* Chat Widget */}
            {isOpen && (
                <Card className="fixed bottom-0 right-0 md:bottom-6 md:right-6 w-full h-full md:w-[400px] md:h-[600px] md:max-h-[calc(100vh-120px)] shadow-2xl z-50 flex flex-col animate-in slide-in-from-bottom-5 md:rounded-xl rounded-none border-muted">
                    <CardHeader className="p-6 border-b flex flex-row items-center justify-between bg-primary text-primary-foreground md:rounded-t-xl space-y-0">
                        <div className="flex items-center gap-3">
                            <Bot className="h-6 w-6" />
                            <div>
                                <CardTitle className="text-lg font-bold">AI Assistant</CardTitle>
                                <p className="text-sm opacity-80">Powered by CreditSync</p>
                            </div>
                        </div>
                        <Button variant="ghost" size="icon" className="h-10 w-10 text-primary-foreground hover:bg-primary-foreground/20 hover:text-primary-foreground" onClick={() => setIsOpen(false)}>
                            <X className="h-5 w-5" />
                        </Button>
                    </CardHeader>

                    <CardContent className="flex-1 p-4 overflow-y-auto space-y-4 bg-muted/30">
                        {messages.map((msg, idx) => (
                            <div key={idx} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                                <div className={cn(
                                    "max-w-[80%] rounded-2xl px-4 py-2 text-sm shadow-sm",
                                    msg.role === "user"
                                        ? "bg-primary text-primary-foreground rounded-tr-none"
                                        : "bg-background border rounded-tl-none",
                                    msg.isError && "bg-destructive/10 text-destructive border-destructive/20"
                                )}>
                                    {msg.role === "assistant" && <div className="font-semibold text-xs mb-1 opacity-70">CreditSync AI</div>}
                                    <div className="whitespace-pre-wrap">{msg.content}</div>
                                </div>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex justify-start">
                                <div className="max-w-[80%] rounded-2xl px-4 py-3 bg-background border rounded-tl-none shadow-sm flex items-center gap-1">
                                    <div className="w-2 h-2 bg-primary/40 rounded-full animate-bounce"></div>
                                    <div className="w-2 h-2 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: "0.2s" }}></div>
                                    <div className="w-2 h-2 bg-primary/80 rounded-full animate-bounce" style={{ animationDelay: "0.4s" }}></div>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </CardContent>

                    <CardFooter className="p-3 border-t bg-background rounded-b-xl gap-2">
                        <Input
                            placeholder="Type a message..."
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") handleSend();
                            }}
                            className="flex-1 rounded-full"
                        />
                        <Button size="icon" onClick={handleSend} disabled={isLoading || !input.trim()} className="rounded-full shrink-0">
                            <Send className="h-4 w-4" />
                        </Button>
                    </CardFooter>
                </Card>
            )}
        </>
    );
}
