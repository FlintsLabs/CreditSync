import React, { useState, useRef, useEffect } from "react";
import { MessageSquare, X, Send, Loader2, Bot, User } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "./ui/card";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

interface ChatMessage {
    id: string;
    role: "user" | "assistant" | "system";
    content: string | React.ReactNode;
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
        if (isOpen && messages.length === 0) {
            setMessages([
                {
                    id: "welcome",
                    role: "assistant",
                    content: "Hello! I am your CreditSync Assistant. How can I help you today? Try asking for an 'active loans' or 'calculate payoff 1'."
                }
            ]);
        }
    }, [isOpen, messages.length]);

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleSendMessage = async (e?: React.FormEvent) => {
        e?.preventDefault();

        const trimmedInput = input.trim();
        if (!trimmedInput) return;

        const userMsgId = Date.now().toString();
        setMessages(prev => [...prev, { id: userMsgId, role: "user", content: trimmedInput }]);
        setInput("");
        setIsLoading(true);

        try {
            // First, call the chat endpoint to parse intent
            const chatRes = await api.post("/ai-tools/chat", { message: trimmedInput });
            const { reply, toolCall } = chatRes.data;

            setMessages(prev => [...prev, { id: Date.now().toString(), role: "assistant", content: reply }]);

            // If a tool execution was determined by the backend
            if (toolCall) {
                const execRes = await api.post("/ai-tools/execute", {
                    tool: toolCall.tool,
                    parameters: toolCall.parameters
                });

                // Format tool output as code block
                setMessages(prev => [...prev, {
                    id: Date.now().toString() + "-tool",
                    role: "system",
                    content: (
                        <div className="bg-muted p-2 rounded-md overflow-x-auto text-xs font-mono whitespace-pre-wrap">
                            {JSON.stringify(execRes.data, null, 2)}
                        </div>
                    )
                }]);
            }

        } catch (error: any) {
            console.error("AI Assistant error:", error);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: "assistant",
                content: "Sorry, I encountered an error while processing your request. " + (error.response?.data?.error || error.message)
            }]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <>
            {/* Floating Toggle Button */}
            {!isOpen && (
                <Button
                    onClick={() => setIsOpen(true)}
                    className="fixed bottom-24 right-4 md:bottom-8 md:right-8 h-14 w-14 rounded-full shadow-lg z-50 p-0 flex items-center justify-center bg-primary hover:bg-primary/90 transition-transform hover:scale-105"
                >
                    <MessageSquare className="h-6 w-6 text-primary-foreground" />
                </Button>
            )}

            {/* Chat Window */}
            {isOpen && (
                <Card className="fixed bottom-20 right-4 md:bottom-8 md:right-8 w-[90vw] max-w-[380px] h-[60vh] max-h-[600px] shadow-2xl z-50 flex flex-col animate-in slide-in-from-bottom-5">
                    <CardHeader className="p-4 border-b flex flex-row items-center justify-between space-y-0 bg-muted/50 rounded-t-lg">
                        <CardTitle className="text-md flex items-center gap-2">
                            <Bot className="h-5 w-5 text-primary" />
                            CreditSync Assistant
                        </CardTitle>
                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => setIsOpen(false)}>
                            <X className="h-4 w-4" />
                        </Button>
                    </CardHeader>

                    <CardContent className="p-4 flex-1 overflow-y-auto space-y-4 flex flex-col">
                        {messages.map((msg) => (
                            <div
                                key={msg.id}
                                className={cn(
                                    "flex gap-2 max-w-[85%]",
                                    msg.role === "user" ? "ml-auto flex-row-reverse" : "mr-auto"
                                )}
                            >
                                <div className={cn(
                                    "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
                                    msg.role === "user" ? "bg-primary text-primary-foreground" :
                                    msg.role === "system" ? "bg-gray-500 text-white" : "bg-muted"
                                )}>
                                    {msg.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                                </div>
                                <div className={cn(
                                    "rounded-2xl px-4 py-2 text-sm",
                                    msg.role === "user" ? "bg-primary text-primary-foreground" :
                                    msg.role === "system" ? "bg-transparent p-0 w-full" : "bg-muted"
                                )}>
                                    {msg.content}
                                </div>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex gap-2 mr-auto max-w-[85%]">
                                <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                                    <Bot className="h-4 w-4" />
                                </div>
                                <div className="rounded-2xl px-4 py-2 text-sm bg-muted flex items-center">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </CardContent>

                    <CardFooter className="p-3 border-t bg-background rounded-b-lg">
                        <form onSubmit={handleSendMessage} className="flex w-full gap-2">
                            <Input
                                placeholder="Ask me anything..."
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                disabled={isLoading}
                                className="flex-1 rounded-full"
                            />
                            <Button
                                type="submit"
                                size="icon"
                                disabled={isLoading || !input.trim()}
                                className="rounded-full flex-shrink-0"
                            >
                                <Send className="h-4 w-4" />
                            </Button>
                        </form>
                    </CardFooter>
                </Card>
            )}
        </>
    );
}
