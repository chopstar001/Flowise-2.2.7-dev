// packages/components/nodes/TelegramBots/TelegramBot/commands/processfolder.ts
import {
    Command,
    IExtendedMemory,
    TranscriptionOptions
} from './types';
import { ContextAdapter } from '../ContextAdapter';
import { ConversationManager } from '../ConversationManager';
import { PromptManager } from '../PromptManager';
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { TranscriptionService, SUPPORTED_MEDIA_EXTENSIONS } from '../services/TranscriptionService'; // Import constants too
import { ExtraEditMessageText } from 'telegraf/typings/telegram-types';
import { TranscriptionSettingsUtil } from './transcriptionsettings';
import * as fs from 'fs';
import * as path from 'path';
import { Markup } from 'telegraf'; // Import Markup

// Simple argument parser for key=value pairs
const parseArguments = (text: string): Record<string, string> => {
    const args: Record<string, string> = {};
    const regex = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g;
    let match;
    // Start searching after the command itself (e.g., after "/processfolder ")
    const commandEndIndex = text.indexOf(' ');
    const argsString = commandEndIndex === -1 ? '' : text.substring(commandEndIndex + 1);

    while ((match = regex.exec(argsString)) !== null) {
        const key = match[1];
        const value = match[3] ?? match[4] ?? match[5];
        args[key] = value;
    }
    return args;
};

// Function to encode filename for callback data
const encodeFilename = (filename: string): string => Buffer.from(filename).toString('base64url');

export const processfolder: Command = {
    name: 'processfolder',
    description: 'Lists media files in the input folder for transcription selection.',
    adminOnly: true, // Keep admin only for now
    execute: async (
        adapter: ContextAdapter,
        conversationManager: ConversationManager,
        memory: IExtendedMemory | null,
        userId: string, // This userId is already normalized (e.g., "telegram_12345")
        sessionId: string,
        promptManager: PromptManager | null,
        telegramBot: TelegramBot_Agents
    ): Promise<void> => {
        const methodName = 'processfolderExecute';
        // --> ADD LOGGING <--
        console.log(`[${methodName}] telegramBot instance available:`, !!telegramBot);
        const transcriptionService = telegramBot.getTranscriptionService();
        console.log(`[${methodName}] transcriptionService retrieved:`, !!transcriptionService);
        // --> END LOGGING <--

        if (!transcriptionService) {
            await adapter.reply('Transcription service is not available or configured.');
            return;
        }

        // Define the input folder path (relative to the service file's directory)
        // Note: This assumes TranscriptionService constructor logic remains the same
        const baseDir = path.dirname(require.resolve('../services/TranscriptionService'));
        const inputFolderPath = path.join(baseDir, '..', 'transcribe_input'); // Go up one level from services

        console.log(`[${methodName}] Scanning folder: ${inputFolderPath}`);

        let files: string[] = [];
        try {
            if (!fs.existsSync(inputFolderPath)) {
                 await adapter.reply(`Input folder not found: ${inputFolderPath}`);
                 return;
            }
            files = fs.readdirSync(inputFolderPath)
                .filter(fileName => {
                    try {
                        const filePath = path.join(inputFolderPath, fileName);
                        const stats = fs.statSync(filePath);
                        const ext = path.extname(fileName).toLowerCase();
                        // Ensure it's a file and has a supported extension
                        return stats.isFile() && SUPPORTED_MEDIA_EXTENSIONS.includes(ext);
                    } catch { return false; }
                });
        } catch (error) {
            console.error(`[${methodName}] Error reading input directory ${inputFolderPath}:`, error);
            await adapter.reply(`Error reading input folder: ${error.message}`);
            return;
        }

        if (files.length === 0) {
            await adapter.reply('No supported media files found in the input folder.');
            return;
        }

        // Parse command-line arguments to store them
        const commandText = adapter.getMessageContext().input || '';
        const args = parseArguments(commandText);
        const commandOptions: Partial<TranscriptionOptions> = {
            provider: args.provider as TranscriptionOptions['provider'] || undefined,
            modelSize: args.model as TranscriptionOptions['modelSize'] || undefined,
            language: args.lang || undefined,
        };
        // Filter out undefined args and ensure correct typing
        const validArgs = Object.entries(commandOptions).reduce(
            (acc: Partial<TranscriptionOptions>, [key, value]) => {
                if (value !== undefined) {
                    // Type assertion to satisfy TypeScript
                    acc[key as keyof TranscriptionOptions] = value as any;
                }
                return acc;
            },
            {} as Partial<TranscriptionOptions>
        );


        // Create buttons for each file
        // TODO: Add pagination if files.length is large
        // Create buttons using file index instead of encoded name
        const buttons = files.map((fileName, index) => {
            // Shorten displayed filename if too long
            const displayName = fileName.length > 40 ? fileName.substring(0, 37) + '...' : fileName;
            // Use index in callback data
            return [Markup.button.callback(`📄 ${displayName}`, `processfile:${index}`)];
        });

        // Add a cancel button
        buttons.push([Markup.button.callback('❌ Cancel', 'processfile_cancel')]);

        const keyboard = Markup.inlineKeyboard(buttons);

        // Send the message with the keyboard
        const sentMessage = await adapter.reply(
            `Found ${files.length} media file(s) in the input folder. Select one to transcribe:`,
            { reply_markup: keyboard.reply_markup }
        );

        // Store command arguments AND the file list in cache, associated with the user ID and the message ID of the keyboard
        if (sentMessage && typeof sentMessage.message_id === 'number') {
             const messageId = sentMessage.message_id;
             // Cache command arguments if any
             if (Object.keys(validArgs).length > 0) {
                 const argsCacheKey = `processfolder_args:${userId}:${messageId}`;
                 conversationManager.cache.set(argsCacheKey, validArgs, 60 * 60); // Cache for 1 hour
                 console.log(`[${methodName}] Stored command args for message ${messageId}:`, validArgs);
             }
             // Cache the list of files
             const filesCacheKey = `processfolder_files:${userId}:${messageId}`;
             conversationManager.cache.set(filesCacheKey, files, 60 * 60); // Cache for 1 hour
             console.log(`[${methodName}] Stored file list for message ${messageId}:`, files);
        }
    }
};

// Helper function to decode filename from callback data
// Export it if needed in CommandHandler as well
export const decodeFilename = (encoded: string): string => Buffer.from(encoded, 'base64url').toString('utf8');