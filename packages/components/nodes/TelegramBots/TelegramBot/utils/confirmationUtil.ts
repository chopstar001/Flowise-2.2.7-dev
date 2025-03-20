// utils/confirmationUtil.ts
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { ContextAdapter } from '../ContextAdapter';

export const confirmationMessages: string[] = [
    "🤔 Processing your request, please wait...",
    "🔍 I'm working on that for you. This might take a moment...",
    "🧠 Analyzing your message. I'll respond shortly...",
    "💡 Thinking... I'll have an answer for you soon.",
    "⏳ Your request is being processed. Thank you for your patience.",
    "🚀 I'm on it! Give me a few seconds to formulate a response.",
    "🔢 Calculating the best response for you. Won't be long!",
    "🤓 Hmm, that's an interesting one. Let me think about it...",
    "📩 Request received! I'm processing it now.",
    "⚙️ Working on your query. I'll be with you in a moment."
];

export function getRandomConfirmationMessage(): string {
    const randomIndex = Math.floor(Math.random() * confirmationMessages.length);
    return confirmationMessages[randomIndex];
}

// in confirmationUtil.ts

export async function sendConfirmationMessage(adapter: ContextAdapter): Promise<[any, () => Promise<boolean>]> {
    const message = await adapter.reply(getRandomConfirmationMessage());
    const deleteFunction = async () => {
        try {
            await adapter.deleteMessage(message.message_id);
            return true;
        } catch (error) {
            console.error('Error deleting confirmation message:', error);
            return false;
        }
    };
    return [message, deleteFunction];
}

export async function deleteConfirmationMessage(adapter: ContextAdapter, messageId: number): Promise<boolean> {
    try {
        await adapter.deleteMessage(messageId);
        return true;
    } catch (error) {
        console.error('Error deleting confirmation message:', error);
        return false;
    }
}