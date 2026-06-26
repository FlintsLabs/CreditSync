import { useState, useRef, useEffect } from "react";
import { MessageCircle, X, Send, Bot } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { api } from "../lib/api";

type Message = {
    id: string;
    text: string;
    sender: "user" | "bot";
};

export default function AIAssistant() {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<Message[]>([
        { id: "init", text: "สวัสดีครับ มีอะไรให้ AI Assistant ช่วยไหมครับ?", sender: "bot" }
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

    const handleSend = async (e?: React.FormEvent) => {
        e?.preventDefault();

        const trimmedInput = input.trim();
        if (!trimmedInput) return;

        const userMsg: Message = {
            id: Date.now().toString(),
            text: trimmedInput,
            sender: "user"
        };

        setMessages(prev => [...prev, userMsg]);
        setInput("");
        setIsLoading(true);

        try {
            const response = await api.post("/ai-tools/chat", { message: trimmedInput });
            const botMsg: Message = {
                id: (Date.now() + 1).toString(),
                text: response.data.reply || "เกิดข้อผิดพลาดในการตอบกลับ",
                sender: "bot"
            };
            setMessages(prev => [...prev, botMsg]);
        } catch (error) {
            console.error("AI chat error:", error);
            const errorMsg: Message = {
                id: (Date.now() + 1).toString(),
                text: "ขออภัยครับ ไม่สามารถเชื่อมต่อกับระบบ AI ได้ในขณะนี้",
                sender: "bot"
            };
            setMessages(prev => [...prev, errorMsg]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <>
            {/* Chat Window */}
            {isOpen && (
                <div className="mb-4 w-[320px] sm:w-[350px] h-[450px] max-h-[70vh] bg-card border shadow-2xl rounded-2xl flex flex-col overflow-hidden animate-in slide-in-from-bottom-5 fade-in duration-300">
                    {/* Header */}
                    <div className="bg-primary text-primary-foreground p-4 flex items-center justify-between shadow-sm z-10">
                        <div className="flex items-center gap-2">
                            <Bot className="h-5 w-5" />
                            <h3 className="font-semibold text-sm">CreditSync AI</h3>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setIsOpen(false)}
                            className="text-primary-foreground hover:bg-primary-foreground/20 hover:text-primary-foreground h-8 w-8"
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    </div>

                    {/* Messages Area */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-muted/30">
                        {messages.map((msg) => (
                            <div
                                key={msg.id}
                                className={cn(
                                    "flex w-max max-w-[85%] flex-col gap-2 rounded-2xl px-4 py-2 text-sm",
                                    msg.sender === "user"
                                        ? "ml-auto bg-primary text-primary-foreground rounded-br-none"
                                        : "bg-muted text-foreground rounded-bl-none border shadow-sm"
                                )}
                            >
                                <span className="whitespace-pre-wrap">{msg.text}</span>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="bg-muted text-foreground flex w-max max-w-[80%] flex-col gap-2 rounded-2xl rounded-bl-none border shadow-sm px-4 py-3 text-sm">
                                <div className="flex gap-1 items-center h-4">
                                    <span className="w-1.5 h-1.5 bg-foreground/50 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                                    <span className="w-1.5 h-1.5 bg-foreground/50 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                                    <span className="w-1.5 h-1.5 bg-foreground/50 rounded-full animate-bounce"></span>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input Area */}
                    <div className="p-3 bg-card border-t z-10">
                        <form onSubmit={handleSend} className="flex gap-2">
                            <Input
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                placeholder="พิมพ์คำถาม หรือ 'ภาพรวม'"
                                className="flex-1 rounded-full border-muted-foreground/30 focus-visible:ring-primary/50"
                                disabled={isLoading}
                            />
                            <Button
                                type="submit"
                                size="icon"
                                disabled={!input.trim() || isLoading}
                                className="rounded-full shrink-0 h-10 w-10"
                            >
                                <Send className="h-4 w-4" />
                            </Button>
                        </form>
                    </div>
                </div>
            )}

            {/* Floating Action Button */}
            {!isOpen && (
                <Button
                    onClick={() => setIsOpen(true)}
                    size="icon"
                    className="h-14 w-14 rounded-full shadow-xl bg-primary hover:bg-primary/90 hover:scale-105 transition-all duration-300 animate-in zoom-in fade-in"
                >
                    <MessageCircle className="h-6 w-6 text-primary-foreground" />
                </Button>
            )}
        </>
    );
}
