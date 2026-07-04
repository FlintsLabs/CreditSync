import { useState, useRef, useEffect } from "react";
import { MessageSquare, X, Send, Bot, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "./ui/card";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";
import { api } from "../lib/api";

type Message = {
    id: string;
    role: "user" | "assistant";
    content: string;
};

export function AIAssistant() {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<Message[]>([
        { id: "1", role: "assistant", content: "Hello! I am your AI assistant. How can I help you with CreditSync today?" }
    ]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Scroll to bottom when messages change
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, isOpen]);

    const handleSend = async () => {
        if (!input.trim() || isLoading) return;

        const userMessage: Message = { id: Date.now().toString(), role: "user", content: input };
        setMessages((prev) => [...prev, userMessage]);
        setInput("");
        setIsLoading(true);

        try {
            const response = await api.post("/ai-tools/chat", { message: userMessage.content });
            const assistantMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: "assistant",
                content: response.data.response || "I processed your request, but received no response."
            };
            setMessages((prev) => [...prev, assistantMessage]);
        } catch (error) {
            console.error("AI Assistant Error:", error);
            const errorMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: "assistant",
                content: "Sorry, I encountered an error while processing your request."
            };
            setMessages((prev) => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed bottom-20 md:bottom-8 right-4 md:right-8 z-[100] flex flex-col items-end">
            {/* Chat Window */}
            {isOpen && (
                <Card className="w-[320px] md:w-[380px] h-[450px] mb-4 shadow-2xl flex flex-col animate-in slide-in-from-bottom-5 duration-300">
                    <CardHeader className="p-4 border-b flex flex-row items-center justify-between space-y-0">
                        <div className="flex items-center gap-2">
                            <Bot className="h-5 w-5 text-primary" />
                            <CardTitle className="text-base font-semibold">AI Assistant</CardTitle>
                        </div>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setIsOpen(false)}>
                            <X className="h-4 w-4" />
                        </Button>
                    </CardHeader>

                    <CardContent className="flex-1 p-4 overflow-y-auto space-y-4" ref={scrollRef}>
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
                                {msg.content}
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex w-max max-w-[85%] items-center gap-2 rounded-lg px-3 py-2 text-sm bg-muted">
                                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                <span className="text-muted-foreground">Thinking...</span>
                            </div>
                        )}
                    </CardContent>

                    <CardFooter className="p-4 border-t">
                        <form
                            className="flex w-full items-center gap-2"
                            onSubmit={(e) => {
                                e.preventDefault();
                                handleSend();
                            }}
                        >
                            <Input
                                placeholder="Type a message..."
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                disabled={isLoading}
                                className="flex-1"
                            />
                            <Button type="submit" size="icon" disabled={!input.trim() || isLoading}>
                                <Send className="h-4 w-4" />
                            </Button>
                        </form>
                    </CardFooter>
                </Card>
            )}

            {/* Toggle Button */}
            <Button
                onClick={() => setIsOpen(!isOpen)}
                size="icon"
                className="h-14 w-14 rounded-full shadow-xl transition-transform hover:scale-105 active:scale-95"
            >
                {isOpen ? <X className="h-6 w-6" /> : <MessageSquare className="h-6 w-6" />}
            </Button>
        </div>
    );
}
