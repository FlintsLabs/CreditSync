import { useState, useRef, useEffect } from "react";
import { MessageCircle, X, Send, Bot, User, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";
import { api } from "../lib/api";

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}

export function AIAssistant() {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isLoading]);

    const handleSend = async () => {
        if (!input.trim()) return;

        const userMessage = input.trim();
        setInput("");
        setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
        setIsLoading(true);

        try {
            const response = await api.post("/ai-tools/chat", {
                message: userMessage,
                history: messages
            });

            if (response.data && response.data.reply) {
                setMessages((prev) => [...prev, { role: "assistant", content: response.data.reply }]);
            } else {
                 setMessages((prev) => [...prev, { role: "assistant", content: "I'm sorry, I couldn't process that request." }]);
            }
        } catch (error) {
            console.error("Failed to send message:", error);
            setMessages((prev) => [...prev, { role: "assistant", content: "Sorry, I encountered an error. Please try again later." }]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            handleSend();
        }
    };

    return (
        <div className="fixed bottom-20 md:bottom-8 right-4 md:right-8 z-[100] flex flex-col items-end">
            {isOpen && (
                <Card className="w-[300px] md:w-[350px] mb-4 shadow-xl border-border/50 animate-in slide-in-from-bottom-5">
                    <CardHeader className="p-4 border-b bg-muted/30 flex flex-row items-center justify-between space-y-0">
                        <CardTitle className="text-sm font-medium flex items-center gap-2">
                            <Bot className="w-5 h-5 text-primary" />
                            CreditSync AI
                        </CardTitle>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsOpen(false)}>
                            <X className="w-4 h-4" />
                        </Button>
                    </CardHeader>
                    <CardContent className="p-4 h-[300px] overflow-y-auto flex flex-col gap-3">
                        {messages.length === 0 ? (
                            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-2 text-muted-foreground">
                                <Bot className="w-10 h-10 opacity-20" />
                                <p className="text-xs">Hi! I can help you find borrowers, active loans, and financial overviews.</p>
                            </div>
                        ) : (
                            messages.map((msg, idx) => (
                                <div key={idx} className={cn("flex gap-2 max-w-[85%]", msg.role === "user" ? "ml-auto flex-row-reverse" : "")}>
                                    <div className={cn("flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center", msg.role === "user" ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground")}>
                                        {msg.role === "user" ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                                    </div>
                                    <div className={cn("px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words", msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted")}>
                                        {msg.content}
                                    </div>
                                </div>
                            ))
                        )}
                        {isLoading && (
                             <div className="flex gap-2 max-w-[85%]">
                                <div className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center bg-muted text-muted-foreground">
                                    <Bot className="w-3.5 h-3.5" />
                                </div>
                                <div className="px-3 py-2 rounded-lg text-sm bg-muted flex items-center gap-2 whitespace-pre-wrap break-words">
                                     <Loader2 className="w-3 h-3 animate-spin" /> Thinking...
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </CardContent>
                    <CardFooter className="p-3 border-t bg-muted/10">
                        <div className="flex w-full items-center gap-2">
                            <Input
                                placeholder="Type a message..."
                                className="h-9 text-sm"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                disabled={isLoading}
                            />
                            <Button size="icon" className="h-9 w-9 shrink-0" onClick={handleSend} disabled={!input.trim() || isLoading}>
                                <Send className="w-4 h-4" />
                            </Button>
                        </div>
                    </CardFooter>
                </Card>
            )}

            <Button
                size="icon"
                className={cn("h-12 w-12 rounded-full shadow-lg transition-all duration-300", isOpen ? "scale-0 opacity-0" : "scale-100 opacity-100")}
                onClick={() => setIsOpen(true)}
            >
                <MessageCircle className="h-6 w-6" />
            </Button>
        </div>
    );
}
