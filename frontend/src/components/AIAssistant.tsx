import { useState, useRef, useEffect } from "react";
import { MessageCircle, X, Send } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";
import { api } from "../lib/api";

type Message = {
    role: "user" | "assistant";
    content: string;
};

export function AIAssistant() {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<Message[]>([
        { role: "assistant", content: "สวัสดีค่ะ มีอะไรให้ช่วยไหมคะ?" }
    ]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleSend = async () => {
        if (!input.trim()) return;

        const userMessage = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userMessage }]);
        setIsLoading(true);

        try {
            const currentMessages = [...messages, { role: "user", content: userMessage }];
            const res = await api.post("/ai-tools/chat", { messages: currentMessages });

            if (res.data && res.data.response) {
                setMessages(prev => [...prev, { role: "assistant", content: res.data.response }]);
            } else {
                setMessages(prev => [...prev, { role: "assistant", content: "ขออภัย เกิดข้อผิดพลาดในการประมวลผลคำตอบค่ะ" }]);
            }
        } catch (error) {
            console.error("AI Assistant Error:", error);
            setMessages(prev => [...prev, { role: "assistant", content: "ขออภัย ไม่สามารถติดต่อระบบ AI ได้ในขณะนี้ค่ะ" }]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed bottom-20 right-4 md:bottom-6 md:right-6 z-[100]">
            {isOpen ? (
                <div className="bg-card border shadow-xl rounded-2xl flex flex-col w-[320px] md:w-[380px] h-[450px] overflow-hidden animate-in slide-in-from-bottom-5">
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b bg-primary text-primary-foreground">
                        <div className="flex items-center gap-2">
                            <MessageCircle className="h-5 w-5" />
                            <span className="font-semibold">AI Assistant</span>
                        </div>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-primary-foreground hover:text-primary hover:bg-background" onClick={() => setIsOpen(false)}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>

                    {/* Chat Area */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                        {messages.map((msg, idx) => (
                            <div key={idx} className={cn("flex w-full", msg.role === "user" ? "justify-end" : "justify-start")}>
                                <div className={cn(
                                    "px-4 py-2 rounded-2xl max-w-[85%] text-sm",
                                    msg.role === "user" ? "bg-primary text-primary-foreground rounded-tr-sm" : "bg-muted rounded-tl-sm"
                                )}>
                                    {msg.content}
                                </div>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex w-full justify-start">
                                <div className="px-4 py-2 rounded-2xl bg-muted text-sm rounded-tl-sm flex gap-1 items-center">
                                    <span className="w-1.5 h-1.5 bg-foreground/50 rounded-full animate-bounce"></span>
                                    <span className="w-1.5 h-1.5 bg-foreground/50 rounded-full animate-bounce delay-100"></span>
                                    <span className="w-1.5 h-1.5 bg-foreground/50 rounded-full animate-bounce delay-200"></span>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input Area */}
                    <div className="p-3 border-t bg-card">
                        <form
                            onSubmit={(e) => { e.preventDefault(); handleSend(); }}
                            className="flex gap-2"
                        >
                            <Input
                                placeholder="พิมพ์ข้อความ..."
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                disabled={isLoading}
                                className="flex-1"
                            />
                            <Button type="submit" size="icon" disabled={isLoading || !input.trim()}>
                                <Send className="h-4 w-4" />
                            </Button>
                        </form>
                    </div>
                </div>
            ) : (
                <Button
                    size="icon"
                    className="h-14 w-14 rounded-full shadow-lg hover:shadow-xl transition-all"
                    onClick={() => setIsOpen(true)}
                >
                    <MessageCircle className="h-6 w-6" />
                </Button>
            )}
        </div>
    );
}
