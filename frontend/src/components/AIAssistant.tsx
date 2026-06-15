import React, { useState, useRef, useEffect } from "react";
import { MessageSquare, X, Send, Bot, User, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

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
            content: "สวัสดีครับ มีอะไรให้ผมช่วยเกี่ยวกับข้อมูลทางการเงินหรือการจัดการสินเชื่อไหมครับ?"
        }
    ]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isOpen]);

    const handleSend = async () => {
        if (!input.trim()) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            role: "user",
            content: input.trim()
        };

        setMessages((prev) => [...prev, userMessage]);
        setInput("");
        setIsLoading(true);

        try {
            // Include history (excluding the very first welcome message if desired, or send all)
            const history = messages.map(m => ({ role: m.role, content: m.content }));

            const response = await api.post("/ai-tools/chat", {
                message: userMessage.content,
                history: history
            });

            const assistantMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: "assistant",
                content: response.data.reply || "เกิดข้อผิดพลาดในการตอบกลับ"
            };

            setMessages((prev) => [...prev, assistantMessage]);

            // If a tool needs to be executed based on the mock response, we can simulate it here
            // In a real MCP flow, the backend would execute it and return the final result
            if (response.data.toolToCall) {
                const toolResponse = await api.post("/ai-tools/execute", {
                    tool: response.data.toolToCall,
                    parameters: response.data.toolParameters || {}
                });

                const toolResultMessage: Message = {
                    id: (Date.now() + 2).toString(),
                    role: "assistant",
                    content: `[ข้อมูลจากระบบ]\n${JSON.stringify(toolResponse.data, null, 2)}`
                };

                setMessages((prev) => [...prev, toolResultMessage]);
            }

        } catch (error) {
            console.error("Failed to send message to AI:", error);
            const errorMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: "assistant",
                content: "ขออภัยครับ เกิดข้อผิดพลาดในการเชื่อมต่อกับเซิร์ฟเวอร์"
            };
            setMessages((prev) => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="fixed bottom-20 md:bottom-6 right-4 md:right-6 z-50 flex flex-col items-end" style={{ pointerEvents: 'auto' }}>
            {/* Chat Window */}
            {isOpen && (
                <Card className="w-[300px] sm:w-[350px] h-[450px] max-h-[80vh] flex flex-col mb-4 shadow-2xl animate-in slide-in-from-bottom-5">
                    <CardHeader className="p-4 border-b flex flex-row items-center justify-between bg-primary text-primary-foreground rounded-t-xl space-y-0">
                        <div className="flex items-center gap-2">
                            <Bot className="h-5 w-5" />
                            <CardTitle className="text-base font-medium">CreditSync AI</CardTitle>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-primary-foreground hover:bg-primary-foreground/20 hover:text-primary-foreground"
                            onClick={() => setIsOpen(false)}
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    </CardHeader>

                    <CardContent className="flex-1 p-4 overflow-y-auto flex flex-col gap-4 bg-muted/20">
                        {messages.map((msg) => (
                            <div
                                key={msg.id}
                                className={cn(
                                    "flex w-max max-w-[85%] flex-col gap-2 rounded-lg px-3 py-2 text-sm",
                                    msg.role === "user"
                                        ? "self-end bg-primary text-primary-foreground"
                                        : "self-start bg-muted text-foreground"
                                )}
                            >
                                <div className="flex items-center gap-1.5 opacity-70 mb-1">
                                    {msg.role === "user" ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                                    <span className="text-[10px] uppercase font-semibold">
                                        {msg.role === "user" ? "คุณ" : "AI"}
                                    </span>
                                </div>
                                <span className="whitespace-pre-wrap leading-relaxed">{msg.content}</span>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="self-start bg-muted text-foreground flex w-max max-w-[85%] flex-col gap-2 rounded-lg px-3 py-3 text-sm">
                                <Loader2 className="h-4 w-4 animate-spin opacity-50" />
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </CardContent>

                    <div className="p-3 border-t bg-background rounded-b-xl flex gap-2">
                        <Input
                            placeholder="พิมพ์ข้อความ..."
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            disabled={isLoading}
                            className="flex-1"
                        />
                        <Button
                            size="icon"
                            onClick={handleSend}
                            disabled={isLoading || !input.trim()}
                        >
                            <Send className="h-4 w-4" />
                        </Button>
                    </div>
                </Card>
            )}

            {/* Floating Button */}
            {!isOpen && (
                <Button
                    size="icon"
                    className="h-14 w-14 rounded-full shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105"
                    onClick={() => setIsOpen(true)}
                >
                    <MessageSquare className="h-6 w-6" />
                </Button>
            )}
        </div>
    );
}
