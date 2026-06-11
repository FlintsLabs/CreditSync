import { useState, useRef, useEffect } from "react";
import { MessageSquare, X, Send, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import axios from "axios";

interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
}

export function AIAssistant() {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<Message[]>([
        {
            id: "1",
            role: "assistant",
            content: "Hello! I am your AI assistant. How can I help you with CreditSync today?",
        },
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
        if (!input.trim() || isLoading) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            role: "user",
            content: input.trim(),
        };

        setMessages((prev) => [...prev, userMessage]);
        setInput("");
        setIsLoading(true);

        try {
            // NOTE: Requires backend to implement POST /ai-tools/chat
            const response = await axios.post(
                "/api/ai-tools/chat",
                { message: userMessage.content },
                {
                    headers: {
                        Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
                    },
                }
            );

            const aiMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: "assistant",
                content: response.data.reply || "I completed the request successfully.",
            };
            setMessages((prev) => [...prev, aiMessage]);
        } catch (error) {
            console.error("AI chat error:", error);
            const errorMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: "assistant",
                content: "Sorry, I encountered an error processing your request.",
            };
            setMessages((prev) => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen) {
        return (
            <Button
                onClick={() => setIsOpen(true)}
                className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-2xl z-50 hover:scale-105 transition-transform"
                size="icon"
            >
                <MessageSquare className="h-6 w-6" />
            </Button>
        );
    }

    return (
        <Card className="fixed bottom-6 right-6 w-[350px] sm:w-[400px] h-[500px] shadow-2xl flex flex-col z-50 border-border bg-background animate-in slide-in-from-bottom-5 fade-in duration-300">
            <CardHeader className="flex flex-row items-center justify-between p-4 border-b bg-muted/30">
                <CardTitle className="text-lg flex items-center gap-2">
                    <MessageSquare className="h-5 w-5 text-primary" />
                    AI Assistant
                </CardTitle>
                <Button variant="ghost" size="icon" onClick={() => setIsOpen(false)} className="h-8 w-8 text-muted-foreground hover:text-foreground">
                    <X className="h-4 w-4" />
                </Button>
            </CardHeader>

            <CardContent className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={`flex flex-col max-w-[80%] ${
                            msg.role === "user" ? "self-end items-end" : "self-start items-start"
                        }`}
                    >
                        <div
                            className={`px-4 py-2 rounded-2xl text-sm ${
                                msg.role === "user"
                                    ? "bg-primary text-primary-foreground rounded-br-sm"
                                    : "bg-muted text-foreground rounded-bl-sm border"
                            }`}
                        >
                            {msg.content}
                        </div>
                    </div>
                ))}
                {isLoading && (
                    <div className="self-start px-4 py-2 rounded-2xl bg-muted text-muted-foreground border rounded-bl-sm text-sm flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Thinking...
                    </div>
                )}
                <div ref={messagesEndRef} />
            </CardContent>

            <CardFooter className="p-3 border-t bg-muted/10">
                <form
                    className="flex w-full gap-2"
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
    );
}
