// utils/utils.ts
import { Context } from 'telegraf'
import { Update } from 'telegraf/typings/core/types/typegram';
import {  MessageContext } from '../commands/types'
import { ContextAdapter } from '../ContextAdapter';
import { MessageContent, MessageContentComplex } from '@langchain/core/messages';

export async function handlePlatformSpecificResponse(
    adapter: ContextAdapter,
    telegramAction: () => Promise<void>,
    options: Array<{ command: string; description: string }>
) {
    const context = adapter.getMessageContext();

    switch (context.source) {
        case 'telegram':
            await telegramAction();
            break;
        case 'flowise':
            break;
        default:
            await adapter.reply("Unsupported platform.");
    }
}


/**
 * Cleans think tags and their content from responses, optionally preserving the thinking process
 * @param response The raw response from the model
 * @param preserveThinking Whether to return the thinking process separately
 * @returns Cleaned response and optional thinking process
 */
export interface CleanedResponse {
    content: string;
    thinking?: string[];  // Change to array for better structure
    thinkingFormatted?: string; // Add formatted version for display
}

// Helper to convert MessageContent to string
export function messageContentToString(content: MessageContent): string {
    if (typeof content === 'string') {
        return content;
    } else if (Array.isArray(content)) {
        return content.map(item => {
            if (typeof item === 'string') {
                return item;
            } else if (typeof item === 'object' && item !== null) {
                return JSON.stringify(item);
            }
            return String(item);
        }).join(' ');
    }
    return JSON.stringify(content);
}

// Update the cleaning function to provide better structure
export function cleanModelResponse(content: MessageContent, preserveThinking: boolean = false): CleanedResponse {
    const stringContent = messageContentToString(content);
    const thinkTagRegex = /<think>(.*?)<\/think>/gs;
    const thinkBlockRegex = /\[.*?thinking.*?\].*?\n/gi;
    
    let thinking: string[] = [];
    let cleanedContent = stringContent;

    if (preserveThinking) {
        // Extract and format thinking blocks
        const thinkMatches = [...stringContent.matchAll(thinkTagRegex)];
        thinking = thinkMatches.map(match => {
            const thoughtContent = match[1].trim();
            // Split into bullet points if possible
            return thoughtContent
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
        }).flat();

        // Create formatted version with emojis
        const formattedThinking = thinking
            .map(thought => `🤔 ${thought}`)
            .join('\n');

        cleanedContent = cleanedContent
            .replace(thinkTagRegex, '')
            .replace(thinkBlockRegex, '')
            .replace(/\|\s+\|/g, '')
            .replace(/\n\s*\n/g, '\n')
            .trim();

        return {
            content: cleanedContent,
            thinking,
            thinkingFormatted: formattedThinking
        };
    }

    return { content: cleanedContent };
}


// Helper function to check if a response contains think tags
export function hasThinkTags(content: MessageContent): boolean {
    const stringContent = messageContentToString(content);
    return /<think>|<\/think>|\[.*?thinking.*?\]/i.test(stringContent);
}